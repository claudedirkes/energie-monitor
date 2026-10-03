"""
Importiert TAGESWERTE der AgriMeteo-Station Ettelbruck (seit 2004) und speichert
sie im gleichen Format wie die meteoLCD-Daten: data/agri/ettelbruck/<Jahr>.json

Quelle: AgriMeteo Luxembourg (Ministère de l'Agriculture), Lizenz CC0.
Spalten der Quelle (Parameter t): 1 = Temp. 2 m Mittel, 2 = Temp. Minimum,
3 = Temp. Maximum (beides aus Stundenmitteln), 11 = Niederschlagssumme.

Der Server bremst schnelle Abfragen (HTTP 429) → zwischen den Monaten wird gewartet.
Abgeschlossene Monate werden nur einmal geladen; danach nur noch die letzten zwei.

Start:  python scripts/agrimeteo_tage.py
"""

import json
import re
import time
import urllib.error
import urllib.request
from datetime import date
from html.parser import HTMLParser
from pathlib import Path

STATION = {"name": "Ettelbruck", "sid": "010", "ordner": "ettelbruck", "seit": 2004}
ZIEL = Path(__file__).resolve().parent.parent / "data" / "agri" / STATION["ordner"]
URL = "https://dlr-web-daten1.aspdienste.de/cgi-bin/wetter.dd.pl?c=92&sid={sid}&t=1,2,3,11&y={j}&m={m:02d}"
PAUSE = 4  # Sekunden zwischen zwei Abfragen


class TabellenLeser(HTMLParser):
    """Sammelt alle Tabellenzeilen als Listen von Zelltexten."""

    def __init__(self):
        super().__init__()
        self.zeilen, self.zeile, self.zelle = [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.zeile = []
        elif tag in ("td", "th") and self.zeile is not None:
            self.zelle = ""

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.zelle is not None and self.zeile is not None:
            self.zeile.append(" ".join(self.zelle.split()))
            self.zelle = None
        elif tag == "tr" and self.zeile is not None:
            if self.zeile:
                self.zeilen.append(self.zeile)
            self.zeile = None

    def handle_data(self, data):
        if self.zelle is not None:
            self.zelle += data


def laden(url):
    for versuch in range(4):
        try:
            anfrage = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(anfrage, timeout=60) as antwort:
                return antwort.read().decode("latin-1")
        except urllib.error.HTTPError as e:
            if e.code == 429 and versuch < 3:
                time.sleep(30 * (versuch + 1))  # zu viele Anfragen → länger warten
                continue
            raise


def zahl(text):
    try:
        return float(text.replace(",", "."))
    except ValueError:
        return None  # "-" = kein Wert


def monat(jahr, mon):
    """Gibt die Tageszeilen eines Monats zurück: [datum, regen, tmin, tmax, tmittel, 1]."""
    leser = TabellenLeser()
    leser.feed(laden(URL.format(sid=STATION["sid"], j=jahr, m=mon)))
    tage = []
    for z in leser.zeilen:
        if not z or not re.fullmatch(r"\d\d\.\d\d\.", z[0]) or len(z) < 5:
            continue
        tag, mo = int(z[0][:2]), int(z[0][3:5])
        if mo != mon:
            continue
        tmittel, tmin, tmax, regen = (zahl(c) for c in z[1:5])
        tage.append([date(jahr, mon, tag).isoformat(), regen, tmin, tmax, tmittel, 1])
    return tage


def main():
    ZIEL.mkdir(parents=True, exist_ok=True)
    heute = date.today()
    letzte_zwei = {(heute.year, heute.month)}
    vor = (heute.year - (heute.month == 1), 12 if heute.month == 1 else heute.month - 1)
    letzte_zwei.add(vor)

    uebersicht = {}
    for jahr in range(STATION["seit"], heute.year + 1):
        datei = ZIEL / f"{jahr}.json"
        vorhanden = json.loads(datei.read_text()) if datei.exists() else {"tage": [], "monate": []}
        tage = {t[0]: t for t in vorhanden["tage"]}
        fertig = set(vorhanden.get("monate", []))
        geaendert = False
        for mon in range(1, 13):
            if (jahr, mon) > (heute.year, heute.month):
                break
            if mon in fertig and (jahr, mon) not in letzte_zwei:
                continue
            try:
                neu = monat(jahr, mon)
            except Exception as e:
                print(f"{jahr}-{mon:02d}: Fehler {e!r}")
                continue
            finally:
                time.sleep(PAUSE)
            for t in neu:
                tage[t[0]] = t
            if neu and (jahr, mon) not in letzte_zwei:
                fertig.add(mon)
            geaendert = True
            print(f"{jahr}-{mon:02d}: {len(neu)} Tage")
        zeilen = sorted(tage.values())
        if geaendert and zeilen:
            datei.write_text(json.dumps({"jahr": jahr, "spalten": ["datum", "regen_mm", "tmin", "tmax", "tmittel", "vollst"],
                                         "monate": sorted(fertig), "tage": zeilen}, separators=(",", ":")))
        if zeilen:
            uebersicht[str(jahr)] = {"von": zeilen[0][0], "bis": zeilen[-1][0], "tage": len(zeilen),
                                     "regen_summe": round(sum(t[1] or 0 for t in zeilen), 1)}

    (ZIEL / "index.json").write_text(json.dumps({
        "quelle": "AgriMeteo Luxembourg – Station Ettelbruck (254 m), CC0 – agrimeteo.lu",
        "hinweis": "Temperatur-Minimum/-Maximum aus Stundenmitteln.",
        "stand": heute.isoformat(), "jahre": uebersicht}, indent=1, ensure_ascii=False))
    print("Fertig.")


if __name__ == "__main__":
    main()
