# Wetter Diekirch

Statische Wetterseite für Diekirch (Luxemburg) – läuft komplett im Browser über GitHub Pages, ohne Backend und ohne API-Key.

**Seite:** https://claudedirkes.github.io/energie-monitor/

## Inhalt
- **Jetzt:** Temperatur, gefühlt, Wetter, Wind/Böen, Luftfeuchte, Luftdruck, Sonnenauf-/-untergang
- **Nächste 48 Stunden:** Temperatur und Niederschlag (mm/h, Regenwahrscheinlichkeit im Tooltip)
- **Vorhersage 7 Tage**
- **Rückblick** (frei wählbarer Zeitraum): Niederschlagssumme, Regentage, nassester Tag, längste Trockenphase, Temperaturen, Sonnenstunden
- **Jahresvergleich:** Niederschlag je Monat gegen das Vorjahr

## Daten
[Open-Meteo](https://open-meteo.com/) (CC BY 4.0) für 49,868° N / 6,159° O:
- Vorhersage-API für aktuelle Werte, Vorhersage und die letzten Tage
- Archiv-API (ERA5-Reanalyse) für ältere Tage (ca. 5 Tage Verzögerung)

Es sind Modellwerte, keine Messungen einer Station in Diekirch – lokale Schauer können abweichen.

## Anpassen
Standort oben im Script von `index.html` ändern: `const LAT = 49.868, LON = 6.159`.
