/**
 * Leneda Energie-WebApp – Backend (Google Apps Script)
 *
 * Aufgaben:
 *  - holt von Leneda: Strom gesamt + Restbezug Lieferant (15-min-Leistung in kW),
 *    Gas in m³, Nm³ und kWh (stündlich)
 *  - holt Temperatur + Wetter (stündlich) von Open-Meteo (kostenlos, ohne Key)
 *  - speichert abgeschlossene Tage im Sheet (Historie)
 *  - rechnet Verbrauch, Spitzenleistung und Kosten nach der Preistabelle (Blatt "Preise")
 *  - beantwortet Anfragen der GitHub-Seite nur mit gültigem Passwort
 *
 * Geheime Werte stehen NICHT im Code, sondern in den Script Properties
 * (Projekteinstellungen → Script-Properties):
 *   LENEDA_API_KEY, LENEDA_ENERGY_ID, STROM_POD, GAS_POD, APP_PASSWORD
 *   optional: LENEDA_BASE (Standard: https://api.leneda.eu/api)
 *   TOKEN_SECRET wird beim ersten Login automatisch angelegt.
 */

const TZ = 'Europe/Luxembourg';
const MAX_RANGE_DAYS = 31;   // max. Tage pro API-Anfrage
const MAX_QUERY_DAYS = 400;  // max. Zeitraum pro Abfrage aus der WebApp
const SH_LOG = 'Abgerufen', SH_CFG = 'Einstellungen', SH_PREISE = 'Preise';

// Messreihen. required = Fehler wird deutlich gemeldet; sonst still ersetzt.
const SERIES = {
  strom:      { src: 'leneda', pod: 'STROM_POD', obis: '1-1:1.29.0',    sheet: 'Strom',      head: 'Leistung gesamt (kW)' },
  strom_rest: { src: 'leneda', pod: 'STROM_POD', obis: '1-65:1.29.9',   sheet: 'Strom_Rest', head: 'Leistung Restbezug Lieferant (kW)' },
  gas:        { src: 'leneda', pod: 'GAS_POD',   obis: '7-1:99.23.15',  sheet: 'Gas',        head: 'Volumen (m³)' },
  gas_nm3:    { src: 'leneda', pod: 'GAS_POD',   obis: '7-1:99.23.17',  sheet: 'Gas_Nm3',    head: 'Normvolumen (Nm³)' },
  gas_kwh:    { src: 'leneda', pod: 'GAS_POD',   obis: '7-20:99.33.17', sheet: 'Gas_kWh',    head: 'Energie (kWh)' },
  wetter:     { src: 'meteo',  sheet: 'Wetter',  head: 'Temperatur (°C)' }
};
const OPTIONAL = { strom_rest: 1, gas_nm3: 1, gas_kwh: 1 };

// Bezugsgrößen für die Preistabelle
const BASEN = {
  kWh_gesamt:    'kWh Gesamtverbrauch',
  kWh_lieferant: 'kWh Restbezug Lieferant',
  kWh_geteilt:   'kWh aus Energiegemeinschaft',
  m3:            'm³ Gas',
  Nm3:           'Nm³ Gas',
  kWh_gas:       'kWh Gas',
  Monat:         'Monat (anteilig pro Tag)'
};

const CFG_ROWS = [
  ['lat', 'Breitengrad für Wetter', 49.868],
  ['lon', 'Längengrad für Wetter', 6.159],
  ['gas_kwh_pro_m3', 'Ersatzwert kWh je m³, nur falls Leneda keine Gas-kWh liefert (Enovos 08–11/2025: 10,92)', 10.92],
  ['gas_nm3_pro_m3', 'Ersatzwert Nm³ je m³, nur falls Leneda kein Normvolumen liefert (Enovos 2025: 0,947)', 0.947],
];

// Startwerte aus den Rechnungen. Leeres "Gültig ab" = Zeile wird ignoriert.
const R_STROM = 'Nordenergie Rechnung 07/2026';
const R_GAS = 'Enovos Jahresrechnung 12/2024–11/2025';
const PRICE_ROWS = [
  ['Strom', 'Energie Nordenergie', 'kWh_lieferant', '2026-07-01', 0.109, 8, R_STROM],
  ['Strom', 'Prime mensuelle', 'Monat', '2026-07-01', 4.00, 8, R_STROM],
  ['Strom', 'Remise Connect', 'Monat', '2026-07-01', -2.50, 8, R_STROM],
  ['Strom', 'Mécanisme de compensation', 'kWh_lieferant', '2026-07-01', -0.001, 8, R_STROM],
  ['Strom', "Taxe d'électricité", 'kWh_lieferant', '2026-07-01', 0.001, 8, R_STROM],
  ['Strom', 'Redevance de comptage', 'Monat', '2026-07-01', 5.72, 8, R_STROM],
  ['Strom', 'Redevance fixe', 'Monat', '2026-07-01', 7.42, 8, R_STROM],
  ['Strom', 'Redevance volumétrique', 'kWh_gesamt', '2026-07-01', 0.051, 8, R_STROM],
  ['Strom', 'Energiegemeinschaft WattSwap', 'kWh_geteilt', '2026-07-01', 0.09, 0, 'WattSwap Rechnungen 07+08/2026 (0 % MwSt)'],
  ['Strom', 'Subvention Resilienzpak (−4 ct brutto)', 'kWh_lieferant', '2026-08-01', -0.037037, 8, 'Resilienzpak 2026, nur auf von Nordenergie verrechneten Strom'],
  ['Strom', 'Subvention Resilienzpak (−4 ct brutto)', 'kWh_lieferant', '2027-01-01', 0, 8, 'Ende 31.12.2026 laut Resilienzpak 2026'],
  ['Gas', 'Energie Enovos', 'm3', '2024-12-01', 0.65540, 8, R_GAS],
  ['Gas', 'Energie Enovos', 'm3', '2025-01-01', 0.60550, 8, R_GAS],
  ['Gas', 'Energie Enovos', 'm3', '2025-08-01', 0.53433, 8, R_GAS],
  ['Gas', 'Energie Enovos', 'm3', '2026-08-01', 0.43870, 8, 'Enovos fix 3 naturgas home, Vertrag 01.08.2026–31.07.2029'],
  ['Gas', 'Prime de puissance (25 kW × 0,30)', 'Monat', '2024-12-01', 7.50, 8, R_GAS],
  ['Gas', 'Remise Connect', 'Monat', '2024-12-01', -2.50, 8, R_GAS],
  ['Gas', 'Taxe sur le gaz', 'kWh_gas', '2024-12-01', 0.00108, 8, R_GAS],
  ['Gas', 'Taxe CO2', 'kWh_gas', '2024-12-01', 0.00707, 8, R_GAS],
  ['Gas', 'Taxe CO2', 'kWh_gas', '2025-01-01', 0.00804, 8, R_GAS],
  ['Gas', 'Redevance mensuelle', 'Monat', '2024-12-01', 7.92, 8, R_GAS],
  ['Gas', 'Redevance mensuelle', 'Monat', '2025-01-01', 8.64, 8, R_GAS],
  ['Gas', 'Utilisation réseau conso', 'Nm3', '2024-12-01', 0.2158, 8, R_GAS],
  ['Gas', 'Utilisation réseau conso', 'Nm3', '2025-01-01', 0.2560, 8, R_GAS],
  ['Gas', 'Prise en charge réseau prime (Staat)', 'Monat', '2024-12-01', -7.92, 8, R_GAS],
  ['Gas', 'Prise en charge réseau prime (Staat)', 'Monat', '2025-01-01', 0, 8, 'Ende der Übernahme'],
  ['Gas', 'Prise en charge réseau conso (Staat)', 'Nm3', '2024-12-01', -0.2158, 8, R_GAS],
  ['Gas', 'Prise en charge réseau conso (Staat)', 'Nm3', '2025-01-01', 0, 8, 'Ende der Übernahme'],
  ['Gas', 'Subvention Resilienzpak (−15 ct/m³ brutto)', 'm3', '2026-08-01', -0.138889, 8, 'Resilienzpak 2026, Start lt. Nutzer'],
  ['Gas', 'Subvention Resilienzpak (−15 ct/m³ brutto)', 'm3', '2027-01-01', 0, 8, 'Ende 31.12.2026 laut Resilienzpak 2026'],
];

// ───────────────────────── Einmalige Einrichtung ─────────────────────────

/** Einmal manuell ausführen: legt alle Tabellenblätter an (bestehende bleiben erhalten). */
function setup() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);
  const mk = (name, header, textCols) => {
    const s = ss.getSheetByName(name) || ss.insertSheet(name);
    (textCols || ['B:B']).forEach(c => s.getRange(c).setNumberFormat('@')); // Text, damit Google nichts umwandelt
    if (s.getLastRow() === 0) s.appendRow(header);
    return s;
  };
  Object.keys(SERIES).forEach(k => {
    const h = ['epoch_ms', 'Zeit (lokal)', SERIES[k].head];
    if (k === 'wetter') h.push('Wettercode');
    mk(SERIES[k].sheet, h);
  });
  mk(SH_LOG, ['Reihe', 'Datum', 'abgerufen am']);
  const c = mk(SH_CFG, ['Schlüssel', 'Beschreibung', 'Wert'], []);
  if (c.getLastRow() === 1) c.getRange(2, 1, CFG_ROWS.length, 3).setValues(CFG_ROWS);
  const p = mk(SH_PREISE, ['Typ', 'Posten', 'Basis', 'Gültig ab', 'Preis netto (€)', 'MwSt %', 'Quelle / Notiz'], ['D:D']);
  if (p.getLastRow() === 1) p.getRange(2, 1, PRICE_ROWS.length, 7).setValues(PRICE_ROWS);
  p.setFrozenRows(1);

  const props = PropertiesService.getScriptProperties();
  ['LENEDA_API_KEY', 'LENEDA_ENERGY_ID', 'STROM_POD', 'GAS_POD', 'APP_PASSWORD'].forEach(k => {
    if (!props.getProperty(k)) Logger.log('FEHLT Script Property: ' + k);
  });
  Logger.log('Setup fertig. Erlaubte Werte für "Basis": ' + Object.keys(BASEN).join(', '));
}

/** Einmal ausführen: richtet den täglichen Abruf um ca. 06:00 ein. */
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailyUpdate')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyUpdate').timeBased().everyDays(1).atHour(6).create();
  Logger.log('Täglicher Trigger eingerichtet.');
}

/** Täglich: füllt die Historie der letzten Tage auf. */
function dailyUpdate() {
  const t = today_();
  const warn = [];
  withLock_(() => loadSeries_(dayList_(addDays_(t, -14), addDays_(t, -2)), warn));
  if (warn.length) Logger.log(warn.join('\n'));
}

/** Test: ruft gestern für alle Leneda-Reihen ab und schreibt die Rohantwort ins Ausführungsprotokoll. */
function testLeneda() {
  const d = addDays_(today_(), -1);
  Object.keys(SERIES).filter(k => SERIES[k].src === 'leneda').forEach(k => {
    const req = lenedaReq_(k, [d, d]);
    const res = UrlFetchApp.fetch(req.url, req);
    Logger.log(k + ' (' + SERIES[k].obis + ') HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 500));
  });
}

// ───────────────────────── Web-Schnittstelle ─────────────────────────

function doGet() {
  return ContentService.createTextOutput('Leneda-Backend läuft.');
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    if (req.action === 'login') {
      checkPassword_(req.password);
      const days = req.remember ? TOKEN_DAYS_REMEMBER : TOKEN_DAYS_SESSION;
      out = { token: makeToken_(Date.now() + days * 86400000) };
    } else {
      checkAuth_(req);
      if (req.action === 'ping') out = {};
      else if (req.action === 'data') out = getData_(req.from, req.to, req.res || 'auto');
      else if (req.action === 'monate') out = getMonths_(Number(req.year));
      else throw new Error('Unbekannte Aktion');
    }
    out.ok = true;
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ───────────────────────── Anmeldung ─────────────────────────
// Token = Ablaufzeit + Signatur (HMAC-SHA256). Der Schlüssel enthält APP_PASSWORD:
// wird das Passwort geändert, sind alle ausgegebenen Tokens sofort ungültig.

const TOKEN_DAYS_REMEMBER = 30;
const TOKEN_DAYS_SESSION = 0.5; // 12 Stunden

function tokenKey_() {
  const p = PropertiesService.getScriptProperties();
  let secret = p.getProperty('TOKEN_SECRET');
  if (!secret) { secret = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('TOKEN_SECRET', secret); }
  return secret + '|' + (p.getProperty('APP_PASSWORD') || '');
}

function sign_(exp) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(String(exp), tokenKey_())).replace(/=+$/, '');
}

function makeToken_(exp) {
  return exp + '.' + sign_(exp);
}

function checkPassword_(pw) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('fails') || 0);
  if (fails >= 10) throw new Error('Zu viele Fehlversuche – bitte 15 Minuten warten.');
  const ok = PropertiesService.getScriptProperties().getProperty('APP_PASSWORD');
  if (!ok) throw new Error('APP_PASSWORD ist im Backend nicht gesetzt.');
  if (!pw || pw !== ok) {
    cache.put('fails', String(fails + 1), 900);
    Utilities.sleep(1000);
    throw new Error('Falsches Passwort');
  }
}

function checkAuth_(req) {
  if (req.token) {
    const parts = String(req.token).split('.');
    const exp = Number(parts[0]);
    if (parts.length === 2 && exp > Date.now() && parts[1] === sign_(exp)) return;
    throw new Error('Anmeldung abgelaufen – bitte neu anmelden');
  }
  checkPassword_(req.password);
}

// ───────────────────────── Auswertung ─────────────────────────

function getData_(from, to, res) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from) || !re.test(to)) throw new Error('Datum im Format JJJJ-MM-TT angeben');
  const today = today_();
  if (to > today) to = today;
  if (from > to) throw new Error('"Von" liegt nach "Bis"');
  const days = dayList_(from, to);
  if (days.length > MAX_QUERY_DAYS) throw new Error('Zeitraum zu lang (max. ' + MAX_QUERY_DAYS + ' Tage)');

  const warn = [];
  let S;
  withLock_(() => { S = loadSeries_(days, warn); });
  const c = cfg_();

  if (res === 'auto') res = days.length <= 3 ? '15min' : days.length <= 10 ? 'hour' : 'day';
  const gRes = res === '15min' ? 'hour' : res;

  // Tag (lokal) je Zeitpunkt – mit Cache pro Stunde, weil formatDate langsam ist
  const dayCache = {};
  const dayOf = t => {
    const h = Math.floor(t / 3600000);
    return dayCache[h] || (dayCache[h] = Utilities.formatDate(new Date(t), TZ, 'yyyy-MM-dd'));
  };
  const bucket = (t, r) => r === '15min' ? t : r === 'hour' ? Math.floor(t / 3600000) * 3600000 : dayOf(t);
  // Viertelstunde des Tages (0–95) in Lokalzeit – Offset pro Stunde gecacht
  const offCache = {};
  const slotOf = t => {
    const h = Math.floor(t / 3600000);
    const off = offCache[h] !== undefined ? offCache[h] : (offCache[h] = offsetMin_(t));
    const local = t + off * 60000;
    return Math.floor((((local % 86400000) + 86400000) % 86400000) / 900000);
  };
  const prof = Array.from({ length: 96 }, () => ({ s: 0, n: 0, max: null }));

  const D = new Map();
  days.forEach(d => D.set(d, {
    kwh: 0, rest: 0, geteilt: 0, peak: null, n15: 0, nRestFehlt: 0,
    m3: 0, nm3: 0, gkwh: 0, nGas: 0, nGasErsatz: 0,
    tmin: null, tmax: null, tsum: 0, tn: 0, code: null
  }));

  // Strom: Gesamt und Restbezug je 15 min
  const restMap = new Map(S.strom_rest);
  let peak = null, peakT = null;
  const sB = new Map();
  S.strom.forEach(([t, kw]) => {
    const e = kw * 0.25;
    let restKw = restMap.get(t);
    const d = D.get(dayOf(t));
    if (!d) return;
    if (restKw === undefined) { restKw = kw; d.nRestFehlt++; } // ohne Restwert: alles beim Lieferanten
    const r = Math.min(restKw, kw) * 0.25, g = e - r;
    d.kwh += e; d.rest += r; d.geteilt += g; d.n15++;
    if (d.peak === null || kw > d.peak) d.peak = kw;
    if (peak === null || kw > peak) { peak = kw; peakT = t; }
    const pr = prof[slotOf(t)];
    pr.s += kw; pr.n++;
    if (pr.max === null || kw > pr.max) pr.max = kw;
    const k = bucket(t, res);
    const b = sB.get(k) || sB.set(k, { kwh: 0, rest: 0, geteilt: 0, peak: null, peakT: null }).get(k);
    b.kwh += e; b.rest += r; b.geteilt += g;
    if (b.peak === null || kw > b.peak) { b.peak = kw; b.peakT = t; }
  });

  // Gas: m³ + Nm³ + kWh (Leneda, sonst Ersatzfaktor)
  const nm3Map = new Map(S.gas_nm3), kwhMap = new Map(S.gas_kwh);
  const gB = new Map();
  S.gas.forEach(([t, v]) => {
    const d = D.get(dayOf(t));
    if (!d) return;
    let nm3 = nm3Map.get(t), kwh = kwhMap.get(t);
    if (nm3 === undefined || kwh === undefined) d.nGasErsatz++;
    if (nm3 === undefined) nm3 = c.gas_nm3_pro_m3 != null ? v * c.gas_nm3_pro_m3 : 0;
    if (kwh === undefined) kwh = c.gas_kwh_pro_m3 != null ? v * c.gas_kwh_pro_m3 : 0;
    d.m3 += v; d.nm3 += nm3; d.gkwh += kwh; d.nGas++;
    const k = bucket(t, gRes);
    const b = gB.get(k) || gB.set(k, { m3: 0, kwh: 0 }).get(k);
    b.m3 += v; b.kwh += kwh;
  });

  // Wetter
  const wB = new Map();
  S.wetter.forEach(([t, w]) => {
    const temp = w[0], code = w[1];
    if (temp === '' || temp === null) return;
    const d = D.get(dayOf(t));
    if (!d) return;
    d.tsum += temp; d.tn++;
    if (d.tmin === null || temp < d.tmin) d.tmin = temp;
    if (d.tmax === null || temp > d.tmax) d.tmax = temp;
    if (code !== '' && (d.code === null || code > d.code)) d.code = code;
    const k = bucket(t, gRes);
    const b = wB.get(k) || wB.set(k, { s: 0, n: 0, min: null, max: null, code: null }).get(k);
    b.s += temp; b.n++;
    if (b.min === null || temp < b.min) b.min = temp;
    if (b.max === null || temp > b.max) b.max = temp;
    if (code !== '' && (b.code === null || code > b.code)) b.code = code;
  });

  // Kosten je Tag nach Preistabelle
  const P = readPrices_();
  const cost = { Strom: { total: 0, posten: {}, fehlTage: [] }, Gas: { total: 0, posten: {}, fehlTage: [] } };
  days.forEach(day => {
    const d = D.get(day);
    const qty = {
      kWh_gesamt: d.kwh, kWh_lieferant: d.rest, kWh_geteilt: d.geteilt,
      m3: d.m3, Nm3: d.nm3, kWh_gas: d.gkwh, Monat: 1 / daysInMonth_(day)
    };
    d.kosten = { Strom: 0, Gas: 0 };
    ['Strom', 'Gas'].forEach(typ => {
      let any = false;
      Object.keys(P[typ] || {}).forEach(posten => {
        const row = priceAt_(P[typ][posten], day);
        if (!row) return;
        any = true;
        const menge = qty[row.basis] || 0;
        const eur = menge * row.brutto;
        d.kosten[typ] += eur;
        const p = cost[typ].posten[posten] || (cost[typ].posten[posten] = { posten: posten, basis: row.basis, menge: 0, eur: 0, preise: {} });
        p.menge += menge; p.eur += eur; p.preise[row.brutto] = 1;
      });
      if (!any) { cost[typ].fehlTage.push(day); d.kosten[typ] = null; }
      cost[typ].total += d.kosten[typ] || 0;
    });
  });

  // Summen
  const sum = f => days.reduce((a, day) => a + f(D.get(day)), 0);
  const kwh = sum(d => d.kwh), rest = sum(d => d.rest), geteilt = sum(d => d.geteilt);
  const m3 = sum(d => d.m3), gkwh = sum(d => d.gkwh);
  const tn = sum(d => d.tn), tsum = sum(d => d.tsum);
  const tmins = days.map(x => D.get(x).tmin).filter(x => x !== null), tmaxs = days.map(x => D.get(x).tmax).filter(x => x !== null);
  const spanH = (localMidnight_(addDays_(to, 1)) - localMidnight_(from)) / 3600000; // berücksichtigt 23-/25-h-Tage
  const n15 = sum(d => d.n15), nGas = sum(d => d.nGas);

  if (n15 && sum(d => d.nRestFehlt) / n15 > 0.02)
    warn.push('Für einen Teil des Zeitraums fehlt der Restbezug (1-65:1.29.9) – dort wird der ganze Strom als Lieferanten-Strom gerechnet.');
  if (nGas && sum(d => d.nGasErsatz) / nGas > 0.02)
    warn.push('Gas-kWh/Nm³ fehlen teilweise bei Leneda – dort wird mit den Ersatzfaktoren aus "Einstellungen" gerechnet.');
  ['Strom', 'Gas'].forEach(typ => {
    const f = cost[typ].fehlTage;
    if (f.length) warn.push(typ + ': für ' + f.length + ' Tag(e) gibt es keine Preise (' + f[0] + (f.length > 1 ? ' … ' + f[f.length - 1] : '') + ') – Kosten dort unvollständig.');
  });

  const label = k => typeof k === 'string' ? k : Utilities.formatDate(new Date(k), TZ, 'yyyy-MM-dd HH:mm');
  const r3 = x => x == null ? null : Math.round(x * 1000) / 1000;
  const r2 = x => x == null ? null : Math.round(x * 100) / 100;
  const postenList = typ => Object.keys(cost[typ].posten).filter(k => Object.keys(cost[typ].posten[k].preise).some(x => Number(x) !== 0)).map(k => {
    const p = cost[typ].posten[k];
    return { posten: p.posten, basis: BASEN[p.basis] || p.basis, menge: r3(p.menge), eur: r2(p.eur),
      preis: Object.keys(p.preise).map(Number).sort((a, b) => a - b) };
  });

  return {
    from: from, to: to, days: days.length, res: res, gasRes: gRes, warnungen: warn,
    kpi: {
      stromKwh: r3(kwh), stromRestKwh: r3(rest), stromGeteiltKwh: r3(geteilt),
      peakKw: r3(peak), peakT: peakT ? label(peakT) : null,
      avgKw: n15 ? r3(kwh / (n15 * 0.25)) : null,
      stromVollstaendig: r3(n15 / (spanH * 4)),
      gasM3: r3(m3), gasKwh: r3(gkwh), gasVollstaendig: r3(nGas / spanH),
      tAvg: tn ? r2(tsum / tn) : null,
      tMin: tmins.length ? Math.min.apply(null, tmins) : null,
      tMax: tmaxs.length ? Math.max.apply(null, tmaxs) : null,
      stromKosten: r2(cost.Strom.total), gasKosten: r2(cost.Gas.total),
      stromKostenVollst: !cost.Strom.fehlTage.length, gasKostenVollst: !cost.Gas.fehlTage.length
    },
    kosten: { Strom: postenList('Strom'), Gas: postenList('Gas') },
    strom: [...sB.entries()].map(([k, b]) => [label(k), r3(b.kwh), r3(b.peak), label(b.peakT), r3(b.rest), r3(b.geteilt)]),
    gas: [...gB.entries()].map(([k, b]) => [label(k), r3(b.m3), r3(b.kwh)]),
    profil: prof.map((x, i) => [String(Math.floor(i / 4)).padStart(2, '0') + ':' + String((i % 4) * 15).padStart(2, '0'),
      x.n ? r3(x.s / x.n) : null, r3(x.max)]),
    wetter: [...wB.entries()].map(([k, b]) => [label(k), r2(b.s / b.n), b.min, b.max, b.code]),
    tage: days.map(day => {
      const x = D.get(day);
      return {
        datum: day, kwh: r3(x.kwh), geteilt: r3(x.geteilt), peak: r3(x.peak), m3: r3(x.m3), gkwh: r3(x.gkwh),
        tmin: x.tmin, tmax: x.tmax, tavg: x.tn ? r2(x.tsum / x.tn) : null, code: x.code,
        kostenStrom: r2(x.kosten.Strom), kostenGas: r2(x.kosten.Gas),
        vollstaendig: r3(x.n15 / (((localMidnight_(addDays_(day, 1)) - localMidnight_(day)) / 3600000) * 4))
      };
    })
  };
}

/** Monatssummen für ein Jahr und das Vorjahr (Strom kWh, Gas m³/kWh, Kosten). */
function getMonths_(year) {
  const now = Number(today_().slice(0, 4));
  if (!(year >= 2000 && year <= now)) throw new Error('Ungültiges Jahr');
  const out = { year: year, jahre: {}, warnungen: [] };
  [year - 1, year].forEach(y => {
    const months = Array.from({ length: 12 }, () => ({ kwh: 0, geteilt: 0, m3: 0, gkwh: 0, kStrom: null, kGas: null, tage: 0 }));
    if (y + '-01-01' <= today_()) {
      const r = getData_(y + '-01-01', y + '-12-31', 'day');
      r.tage.forEach(t => {
        const m = months[Number(t.datum.slice(5, 7)) - 1];
        m.kwh += t.kwh || 0; m.geteilt += t.geteilt || 0; m.m3 += t.m3 || 0; m.gkwh += t.gkwh || 0; m.tage++;
        if (t.kostenStrom != null) m.kStrom = (m.kStrom || 0) + t.kostenStrom;
        if (t.kostenGas != null) m.kGas = (m.kGas || 0) + t.kostenGas;
      });
      r.warnungen.forEach(w => out.warnungen.push(y + ': ' + w));
    }
    const r2 = x => x == null ? null : Math.round(x * 100) / 100;
    out.jahre[y] = months.map(m => m.tage ? { kwh: r2(m.kwh), geteilt: r2(m.geteilt), m3: r2(m.m3), gkwh: r2(m.gkwh), kStrom: r2(m.kStrom), kGas: r2(m.kGas) } : null);
  });
  return out;
}

// ───────────────────────── Preise ─────────────────────────

/** Liest das Blatt "Preise": {Typ: {Posten: [{ab, basis, brutto}, ...sortiert]}} */
function readPrices_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SH_PREISE);
  const out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().forEach(r => {
    const typ = String(r[0]).trim(), posten = String(r[1]).trim(), basis = String(r[2]).trim();
    const ab = r[3] instanceof Date ? Utilities.formatDate(r[3], TZ, 'yyyy-MM-dd') : String(r[3]).trim();
    const netto = Number(String(r[4]).replace(',', '.'));
    const mwst = Number(String(r[5] === '' ? 0 : r[5]).replace(',', '.'));
    if (!typ || !posten || !/^\d{4}-\d{2}-\d{2}$/.test(ab) || r[4] === '' || isNaN(netto) || !BASEN[basis]) return;
    ((out[typ] = out[typ] || {})[posten] = out[typ][posten] || []).push({ ab: ab, basis: basis, brutto: netto * (1 + mwst / 100) });
  });
  Object.keys(out).forEach(t => Object.keys(out[t]).forEach(p => out[t][p].sort((a, b) => a.ab < b.ab ? -1 : 1)));
  return out;
}

/** Zeile, die an diesem Tag gilt (letztes "Gültig ab" ≤ Tag), sonst null. */
function priceAt_(rows, day) {
  let hit = null;
  for (let i = 0; i < rows.length; i++) if (rows[i].ab <= day) hit = rows[i];
  return hit;
}

// ───────────────────────── Daten holen + speichern ─────────────────────────

/** Lädt alle Reihen für die Tage: fehlende abgeschlossene Tage holen + speichern, neue Tage live. */
function loadSeries_(days, warn) {
  const keys = Object.keys(SERIES);
  const done = readLog_();
  const plan = [];
  keys.forEach(k => {
    const limit = finalLimit_(k);
    const have = done[k] || new Set();
    toRanges_(days.filter(d => d <= limit && !have.has(d))).forEach(r => plan.push({ k: k, r: r, store: true }));
    toRanges_(days.filter(d => d > limit)).forEach(r => plan.push({ k: k, r: r, store: false }));
  });

  const c = cfg_();
  const results = plan.length
    ? UrlFetchApp.fetchAll(plan.map(p => SERIES[p.k].src === 'meteo' ? meteoReq_(p.r, c) : lenedaReq_(p.k, p.r)))
    : [];
  const rowsOf = plan.map((p, i) => {
    const res = results[i], code = res.getResponseCode();
    if (code !== 200) {
      const msg = (SERIES[p.k].src === 'meteo' ? 'Wetter' : 'Leneda ' + p.k + ' (' + SERIES[p.k].obis + ')') +
        ': HTTP ' + code + ' für ' + p.r.join(' – ') + (code === 401 || code === 403 ? ' – API-Key / Energy-ID prüfen' : '');
      if (!OPTIONAL[p.k] || code === 401) warn.push(msg);
      return null;
    }
    return parseRows_(p.k, JSON.parse(res.getContentText()));
  });

  // Speichern
  const now = new Date();
  const logRows = [];
  keys.forEach(k => {
    const rows = [];
    plan.forEach((p, i) => {
      if (p.k !== k || !p.store || !rowsOf[i]) return;
      rows.push.apply(rows, rowsOf[i]);
      const got = new Set(rowsOf[i].map(r => r[1].slice(0, 10)));
      // Optionale Reihen ohne Daten trotzdem als erledigt markieren, sonst wird jedes Mal neu gefragt
      dayList_(p.r[0], p.r[1]).forEach(d => { if (got.has(d) || OPTIONAL[k]) logRows.push([k, d, now]); });
    });
    if (rows.length) {
      const sh = sheet_(SERIES[k].sheet);
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    }
  });
  if (logRows.length) {
    const ls = sheet_(SH_LOG);
    ls.getRange(ls.getLastRow() + 1, 1, logRows.length, 3).setValues(logRows);
  }

  // Lesen: Sheet + Live-Daten
  const t0 = localMidnight_(days[0]);
  const t1 = localMidnight_(addDays_(days[days.length - 1], 1));
  const out = {};
  keys.forEach(k => {
    const wet = k === 'wetter';
    const val = r => wet ? [r[2], r[3]] : r[2];
    const m = new Map();
    const sh = sheet_(SERIES[k].sheet);
    if (sh.getLastRow() > 1) {
      const v = sh.getRange(2, 1, sh.getLastRow() - 1, wet ? 4 : 3).getValues();
      for (let i = 0; i < v.length; i++) {
        const t = Number(v[i][0]);
        if (t >= t0 && t < t1) m.set(t, val(v[i]));
      }
    }
    plan.forEach((p, i) => {
      if (p.k !== k || p.store || !rowsOf[i]) return;
      rowsOf[i].forEach(r => { if (r[0] >= t0 && r[0] < t1) m.set(r[0], val(r)); });
    });
    out[k] = [...m.entries()].sort((a, b) => a[0] - b[0]);
  });
  return out;
}

function parseRows_(k, j) {
  const rows = [];
  if (SERIES[k].src === 'meteo') {
    const h = j.hourly || {};
    (h.time || []).forEach((t, i) => {
      if (h.temperature_2m[i] === null) return;
      const ms = t * 1000;
      rows.push([ms, fmtLocal_(ms), h.temperature_2m[i], h.weather_code[i] == null ? '' : h.weather_code[i]]);
    });
  } else {
    (j.items || []).forEach(it => {
      const ms = Date.parse(it.startedAt);
      if (isNaN(ms) || it.value == null) return;
      rows.push([ms, fmtLocal_(ms), Number(it.value)]);
    });
  }
  return rows;
}

/** Tage bis einschließlich diesem Datum gelten als final (werden gespeichert). */
function finalLimit_(k) {
  return addDays_(today_(), k === 'wetter' ? -6 : -2);
}

function readLog_() {
  const sh = sheet_(SH_LOG);
  const s = {};
  if (sh.getLastRow() < 2) return s;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(r => {
    const d = r[1] instanceof Date ? Utilities.formatDate(r[1], TZ, 'yyyy-MM-dd') : String(r[1]);
    (s[r[0]] = s[r[0]] || new Set()).add(d);
  });
  return s;
}

function lenedaReq_(k, r) {
  const p = PropertiesService.getScriptProperties();
  const base = p.getProperty('LENEDA_BASE') || 'https://api.leneda.eu/api';
  const pod = p.getProperty(SERIES[k].pod);
  const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z');
  const start = iso(localMidnight_(r[0]));
  const end = iso(localMidnight_(addDays_(r[1], 1)) - 1000);
  return {
    url: base + '/metering-points/' + encodeURIComponent(pod) + '/time-series' +
      '?startDateTime=' + encodeURIComponent(start) +
      '&endDateTime=' + encodeURIComponent(end) +
      '&obisCode=' + encodeURIComponent(SERIES[k].obis),
    headers: {
      'X-API-KEY': p.getProperty('LENEDA_API_KEY'),
      'X-ENERGY-ID': p.getProperty('LENEDA_ENERGY_ID'),
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  };
}

function meteoReq_(r, c) {
  // Archiv für alte Tage, Vorhersage-API (mit Vergangenheit) für die letzten Tage
  const host = r[1] <= addDays_(today_(), -6)
    ? 'https://archive-api.open-meteo.com/v1/archive'
    : 'https://api.open-meteo.com/v1/forecast';
  return {
    url: host + '?latitude=' + c.lat + '&longitude=' + c.lon +
      '&start_date=' + r[0] + '&end_date=' + r[1] +
      '&hourly=temperature_2m,weather_code&timezone=' + encodeURIComponent(TZ) + '&timeformat=unixtime',
    muteHttpExceptions: true
  };
}

// ───────────────────────── Hilfsfunktionen ─────────────────────────

function cfg_() {
  const o = {};
  sheet_(SH_CFG).getDataRange().getValues().slice(1).forEach(r => {
    const v = String(r[2]).trim().replace(',', '.');
    o[r[0]] = v === '' || isNaN(Number(v)) ? null : Number(v);
  });
  return o;
}

function sheet_(name) {
  const s = SpreadsheetApp.getActive().getSheetByName(name);
  if (!s) throw new Error('Blatt "' + name + '" fehlt – bitte setup() ausführen');
  return s;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try { fn(); } finally { lock.releaseLock(); }
}

/** Fasst aufeinanderfolgende Tage zu Bereichen [von, bis] zusammen (max. 31 Tage). */
function toRanges_(days) {
  const out = [];
  days.slice().sort().forEach(d => {
    const last = out[out.length - 1];
    if (last && addDays_(last[1], 1) === d && dayList_(last[0], d).length <= MAX_RANGE_DAYS) last[1] = d;
    else out.push([d, d]);
  });
  return out;
}

function dayList_(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays_(d, 1)) out.push(d);
  return out;
}

function addDays_(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function daysInMonth_(s) {
  const [y, m] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function today_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function fmtLocal_(ms) {
  return Utilities.formatDate(new Date(ms), TZ, 'yyyy-MM-dd HH:mm');
}

/** Zeitpunkt (ms) von 00:00 Luxemburger Zeit an diesem Tag – berücksichtigt Sommer-/Winterzeit. */
function localMidnight_(s) {
  const [y, m, d] = s.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d);
  let t = utc - offsetMin_(utc) * 60000;
  t = utc - offsetMin_(t) * 60000;
  return t;
}

function offsetMin_(ms) {
  const z = Utilities.formatDate(new Date(ms), TZ, 'Z'); // z. B. +0200
  const sign = z[0] === '-' ? -1 : 1;
  return sign * (Number(z.substr(1, 2)) * 60 + Number(z.substr(3, 2)));
}
