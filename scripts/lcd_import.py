"""
Importiert die Messwerte der Wetterstation meteoLCD (Lycée classique Diekirch)
und speichert TAGESWERTE als JSON-Dateien für die Webseite.

Quelle: https://meteo.lcd.lu  –  "meteoLCD: Meteorological Station of the
Lycee Classique Diekirch, L-9233 Diekirch, Luxembourg"

Ablauf:
  1. Für jedes Jahr die Rohdateien herunterladen (Jahres-ZIP bis 2024,
     Monatsdateien ab 2025).
  2. Jede Zeile = 30-Minuten-Wert. Aus der Kopfzeile ("Label" bzw.
     "Sensor code") wird bestimmt, in welcher Spalte Regen und Temperatur stehen.
  3. Pro Tag: Regensumme, Temperatur min/max/Mittel, Anzahl Messungen.
  4. Ergebnis: data/lcd/<Jahr>.json  und  data/lcd/index.json

Start:  python scripts/lcd_import.py            (nur fehlende/aktuelle Jahre)
        python scripts/lcd_import.py --alle     (alles neu)
"""

import io
import json
import re
import sys
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

BASIS = "https://meteo.lcd.lu/data/"
ZIEL = Path(__file__).resolve().parent.parent / "data" / "lcd"
ERSTES_JAHR = 1994
MONATE = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
FEHLT = 9999            # so markiert die Station fehlende Werte
TEMP_KORREKTUR_AB = 2016  # laut Station: Air_Temp seit 2016 um +1,6 °C zu hoch
TEMP_KORREKTUR = -1.6

# Zeilen mit Messwerten beginnen mit "TT/MM hh:mm:ss
ZEILE = re.compile(r'^"(\d\d)/(\d\d) (\d\d):(\d\d)')


def laden(url):
    """Lädt eine Datei; gibt None zurück, wenn sie nicht existiert."""
    anfrage = urllib.request.Request(url, headers={"User-Agent": "wetter-diekirch (GitHub Actions)"})
    try:
        with urllib.request.urlopen(anfrage, timeout=120) as antwort:
            return antwort.read()
    except Exception as fehler:  # 404, Zeitüberschreitung …
        print(f"  – nicht geladen: {url} ({fehler})")
        return None


def felder(zeile):
    """Zerlegt eine Zeile wie  "01/08 11:01",25," ",0.35," ",0.0,...
    und gibt nur die Messwerte zurück (jedes zweite Feld ab Position 3)."""
    teile = [t.strip().strip('"').strip() for t in zeile.split(",")]
    return teile, [teile[i] for i in range(3, len(teile), 2)]


def spalten_finden(text):
    """Sucht in der Kopfzeile, in welcher Spalte Regen und Lufttemperatur stehen."""
    regen = temp = None
    for zeile in text.splitlines()[:40]:
        if zeile.startswith('"Label') or zeile.startswith('"Sensor code'):
            _, namen = felder(zeile)
            for i, name in enumerate(namen):
                n = name.upper()
                if regen is None and n in ("RAINFALL", "RG1"):
                    regen = i
                if temp is None and n in ("AIR_TEMP", "AIT"):
                    temp = i
    return regen, temp


def zahl(text):
    try:
        wert = float(text)
    except ValueError:
        return None
    return None if wert >= FEHLT else wert


def datei_auswerten(text, jahr, messungen, bericht):
    """Liest alle 30-Minuten-Werte einer .dat-Datei in das Dict `messungen`
    (Schlüssel = Zeitpunkt, damit doppelte Zeilen nur einmal zählen)."""
    regen_sp, temp_sp = spalten_finden(text)
    if regen_sp is None or temp_sp is None:
        # Ohne Kopfzeile: Aufbau der aktuellen Logger-Dateien annehmen
        regen_sp, temp_sp = 1, 3
        bericht["ohne_kopf"] = bericht.get("ohne_kopf", 0) + 1
    for zeile in text.splitlines():
        treffer = ZEILE.match(zeile)
        if not treffer:
            continue
        tag, monat, stunde, minute = (int(x) for x in treffer.groups())
        try:
            datum = date(jahr, monat, tag)
        except ValueError:
            continue
        _, werte = felder(zeile)
        if len(werte) <= max(regen_sp, temp_sp):
            continue
        regen = zahl(werte[regen_sp])
        temp = zahl(werte[temp_sp])
        # Unplausible Werte verwerfen (Wartung, Stromausfall …)
        if regen is not None and not (0 <= regen <= 50):
            regen = None
        if temp is not None and not (-30 <= temp <= 45):
            temp = None
        messungen[(datum, stunde, minute // 30)] = (regen, temp)


def jahr_verarbeiten(jahr):
    """Lädt alle Rohdaten eines Jahres und berechnet die Tageswerte."""
    messungen, bericht = {}, {"dateien": 0}
    texte = []
    if jahr <= 2024:
        for name in (f"{jahr}_with_headers.zip", f"{jahr}.zip"):
            inhalt = laden(BASIS + name)
            if inhalt:
                with zipfile.ZipFile(io.BytesIO(inhalt)) as z:
                    for datei in z.namelist():
                        if datei.lower().endswith(".dat"):
                            texte.append(z.read(datei).decode("latin-1"))
                break
    else:
        kurz = str(jahr)[2:]
        for m in MONATE:
            inhalt = laden(f"{BASIS}{jahr}/{m}{kurz}.dat")
            if inhalt:
                texte.append(inhalt.decode("latin-1"))
    if texte and "--debug" in sys.argv:
        dbg = ZIEL / "debug"
        dbg.mkdir(exist_ok=True)
        (dbg / f"{jahr}.txt").write_text(f"Dateien: {len(texte)}  Spalten: {spalten_finden(texte[0])}\n" +
                                         "\n".join(texte[0].splitlines()[:22]) + "\n...\n" +
                                         "\n".join(texte[0].splitlines()[-3:]))
    for text in texte:
        datei_auswerten(text, jahr, messungen, bericht)
    bericht["dateien"] = len(texte)

    # 30-Minuten-Werte zu Tageswerten zusammenfassen
    tage = {}
    for (datum, _, _), (regen, temp) in messungen.items():
        t = tage.setdefault(datum, {"regen": 0.0, "n_regen": 0, "temps": []})
        if regen is not None:
            t["regen"] += regen
            t["n_regen"] += 1
        if temp is not None:
            if jahr >= TEMP_KORREKTUR_AB:
                temp += TEMP_KORREKTUR
            t["temps"].append(temp)

    zeilen = []
    for datum in sorted(tage):
        t = tage[datum]
        temps = t["temps"]
        zeilen.append([
            datum.isoformat(),
            round(t["regen"], 1) if t["n_regen"] else None,       # Regen mm
            round(min(temps), 1) if temps else None,              # T min
            round(max(temps), 1) if temps else None,              # T max
            round(sum(temps) / len(temps), 1) if temps else None,  # T Mittel
            t["n_regen"],                                        # Anzahl Halbstunden mit Regenwert (48 = vollständig)
        ])
    bericht["tage"] = len(zeilen)
    bericht["regen_summe"] = round(sum(z[1] or 0 for z in zeilen), 1)
    return zeilen, bericht


def main():
    alles_neu = "--alle" in sys.argv
    ZIEL.mkdir(parents=True, exist_ok=True)
    heute = date.today()
    uebersicht = {}
    alt_index = ZIEL / "index.json"
    if alt_index.exists():
        uebersicht = json.loads(alt_index.read_text()).get("jahre", {})

    for jahr in range(ERSTES_JAHR, heute.year + 1):
        datei = ZIEL / f"{jahr}.json"
        # Abgeschlossene Archivjahre (bis 2024) nur einmal verarbeiten
        if datei.exists() and jahr <= 2024 and not alles_neu:
            continue
        print(f"Jahr {jahr} …")
        zeilen, bericht = jahr_verarbeiten(jahr)
        print(f"  {bericht}")
        if not zeilen:
            continue
        datei.write_text(json.dumps({"jahr": jahr, "spalten": ["datum", "regen_mm", "tmin", "tmax", "tmittel", "n"],
                                     "tage": zeilen}, separators=(",", ":")))
        uebersicht[str(jahr)] = {"von": zeilen[0][0], "bis": zeilen[-1][0], **bericht}

    (ZIEL / "index.json").write_text(json.dumps({
        "quelle": "meteoLCD – Meteorological Station of the Lycee Classique Diekirch, L-9233 Diekirch (https://meteo.lcd.lu)",
        "hinweis": f"Lufttemperatur ab {TEMP_KORREKTUR_AB} um {TEMP_KORREKTUR} °C korrigiert (Angabe der Station).",
        "stand": heute.isoformat(),
        "jahre": dict(sorted(uebersicht.items())),
    }, indent=1, ensure_ascii=False))
    print("Fertig.")


if __name__ == "__main__":
    main()
