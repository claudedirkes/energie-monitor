# Energie-Monitor (Leneda)

Strom (15-min-Leistung), Gas (m³/Stunde), Wetter und Kosten für einen frei wählbaren Zeitraum.

- `index.html` → Frontend (GitHub Pages)
- `apps-script/Code.gs` + `appsscript.json` → Backend (Google Apps Script, an ein Google Sheet gebunden)

Der API-Key liegt **nur** in den Script Properties des Apps-Script-Projekts – nie in diesem Repo.

## Einrichtung

### 1. Google Sheet + Apps Script
1. Neues Google Sheet anlegen → **Erweiterungen → Apps Script**.
2. Inhalt von `Code.gs` einfügen. Unter Projekteinstellungen „appsscript.json im Editor anzeigen“ aktivieren und Inhalt von `appsscript.json` einfügen.
3. **Projekteinstellungen → Script-Properties** anlegen:
   | Property | Wert |
   |---|---|
   | `LENEDA_API_KEY` | API-Key aus Leneda |
   | `LENEDA_ENERGY_ID` | z. B. `LUXE-…` |
   | `STROM_POD` | Zählpunkt Strom `LU…` |
   | `GAS_POD` | Zählpunkt Gas `LU…` |
   | `APP_PASSWORD` | Passwort für die Webseite |
4. Funktion **`setup`** ausführen (Berechtigungen bestätigen) → Blätter werden angelegt.
5. Funktion **`testLeneda`** ausführen → im Ausführungsprotokoll muss `HTTP 200` stehen.
6. Funktion **`installTrigger`** ausführen → täglicher Abruf um ca. 06:00.
7. Blatt **Preise** prüfen (vorbefüllt aus den Rechnungen). Zeilen mit leerem „Gültig ab“ werden ignoriert, bis du ein Datum einträgst.
8. **Bereitstellen → Neue Bereitstellung → Web-App**: Ausführen als *Ich*, Zugriff *Jeder*. URL kopieren.

### 2. GitHub Pages
1. In `index.html` bei `API_URL` die Web-App-URL eintragen.
2. Repo pushen → **Settings → Pages → Branch `main` / root**.

## Hinweise
- Leneda liefert Strom als **mittlere Leistung (kW) pro 15 min**. Energie = kW × 0,25.
- Tage bis vorgestern werden im Sheet gespeichert (Wetter: bis vor 6 Tagen). Neuere Tage werden jedes Mal live geholt.
- Wetter: Open-Meteo (stündlich). „Wetter (stärkstes)“ = das heftigste Wetter des Tages (z. B. ein Regenschauer).
- **Preise** (Blatt „Preise“): eine Zeile pro Posten und Gültigkeitsbeginn. Für jeden Tag gilt die Zeile mit dem letzten „Gültig ab“ ≤ Tag. Ein Posten endet mit einer neuen Zeile mit Preis 0.
  Basis: `kWh_gesamt`, `kWh_lieferant`, `kWh_geteilt`, `m3`, `Nm3`, `kWh_gas`, `Monat` (Monatsgebühr wird tageweise anteilig verteilt).
- Strom: Gesamt (`1-1:1.29.0`) und Restbezug Lieferant (`1-65:1.29.9`); Energiegemeinschaft = Gesamt − Rest.
- Gas: m³ (`7-1:99.23.15`), Nm³ (`7-1:99.23.17`), kWh (`7-20:99.33.17`). Fehlen Nm³/kWh, wird mit den Ersatzfaktoren aus „Einstellungen“ gerechnet.
- Kontrolle: Strom 07/2026 ergibt 91,79 € (Rechnungen 61,40 + 30,40), Gas 08–11/2025 ergibt 470,44 € (Rechnung 470,45 €).
- Überschreitung der Referenzleistung (3 kW) ist nicht eingerechnet.
- Nach Code-Änderungen im Backend: **Bereitstellungen verwalten → Bearbeiten → Neue Version**, sonst läuft die alte Version weiter.
