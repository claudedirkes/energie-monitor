"""
Holt die aktuellen 10-Minuten-Messwerte der AgriMeteo-Stationen Ettelbruck und
Bettendorf (Landwirtschaftsministerium Luxemburg, Lizenz CC0) und speichert sie
für die Webseite als data/live/agrimeteo.json.

Die Werte stehen auf agrimeteo.lu nur als HTML-Tabelle. Dieses Script liest die
Tabelle aus („Scraping“). Die Webseite selbst darf die Tabelle nicht direkt
laden (Browser-Sperre), deshalb läuft das hier als GitHub-Job alle 30 Minuten.

Start:  python scripts/agrimeteo_live.py
"""

import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

ZIEL = Path(__file__).resolve().parent.parent / "data" / "live"
SERVER = "https://dlr-web-daten1.aspdienste.de/cgi-bin/"
STATIONEN = {            # Stationsnummer beim Datenserver: Name
    10: "Ettelbruck",
    36: "Bettendorf",
}


def laden(url):
    anfrage = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(anfrage, timeout=60) as antwort:
        return antwort.read().decode("latin-1")


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


def zahl(text):
    try:
        return float(text.replace(",", "."))
    except ValueError:
        return None


def zehn_minuten(sid):
    """Liest die 10-Minuten-Tabelle der letzten 24 Stunden.
    Spalten laut Kopf: Datum, Zeit (MESZ), Temp 2 m, Temp 20 cm, Luftfeuchte, Niederschlag, Wind, Zeit."""
    html = laden(f"{SERVER}wetter.min5.pl?c=92&sid={sid}&t=1,2,6,8,9&hh=24")
    leser = TabellenLeser()
    leser.feed(html)
    werte, datum = [], None
    for z in leser.zeilen:
        # Datum steht nur in der ersten Zeile eines Tages
        d = next((c for c in z if re.fullmatch(r"\d\d\.\d\d\.\d{4}", c)), None)
        if d:
            datum = d
        i = next((k for k, c in enumerate(z) if re.fullmatch(r"\d\d:\d\d", c)), None)
        if datum is None or i is None or len(z) < i + 6:
            continue
        t2, t20, rf, regen, wind = (zahl(c) for c in z[i + 1:i + 6])
        tag, monat, jahr = datum.split(".")
        werte.append({
            "zeit": f"{jahr}-{monat}-{tag}T{z[i]}",   # Ortszeit Luxemburg
            "t": t2, "t20": t20, "rf": rf, "regen": regen, "wind": wind,
        })
    werte.sort(key=lambda w: w["zeit"])
    return werte


def main():
    ZIEL.mkdir(parents=True, exist_ok=True)
    ergebnis = {
        "quelle": "AgriMeteo Luxembourg (Ministère de l'Agriculture), CC0 – agrimeteo.lu",
        "abgerufen": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "stationen": {},
    }
    fehler = 0
    for nr, (sid, name) in enumerate(STATIONEN.items()):
        if nr:
            time.sleep(8)  # Server begrenzt schnelle Abfragen (HTTP 429)
        try:
            try:
                werte = zehn_minuten(sid)
            except urllib.error.HTTPError as e:
                if e.code != 429:
                    raise
                time.sleep(30)  # zu viele Anfragen → kurz warten, dann ein zweites Mal
                werte = zehn_minuten(sid)
            ergebnis["stationen"][name] = {"sid": sid, "werte": werte}
            print(f"{name}: {len(werte)} Werte, neuester {werte[-1]['zeit'] if werte else '–'}")
        except Exception as e:  # Station nicht erreichbar → beim nächsten Lauf erneut
            fehler += 1
            ergebnis.setdefault("fehler", {})[name] = repr(e)
            print(f"{name}: Fehler {e!r}")
    alt = ZIEL / "agrimeteo.json"
    if fehler == len(STATIONEN) and alt.exists():
        print("Alle Stationen fehlgeschlagen – alte Daten bleiben stehen.")
        return
    (ZIEL / "agrimeteo.json").write_text(json.dumps(ergebnis, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
