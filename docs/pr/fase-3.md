## Fase 3 — kindermodus en beeld

Gestapeld op `feat/security-features`.

- **Leeftijdsclassificatie** (`ratings.js`): elke bron wordt teruggebracht tot één minimumleeftijd op de Kijkwijzer-schaal (AL = 0, 6, 9, 12, 14, 16, 18). Bronnen: TMDB (`release_dates` / `content_ratings`, Nederland eerst), Wikidata zonder sleutel (Kijkwijzer P2684, FSK P1981, MPAA P1657) en `<mpaa>`/`<certification>` in `.nfo`. Een leeftijd tussen twee stappen gaat naar de strengere. De beheerder kan per titel zelf een leeftijd zetten (Beheer → Metadata).
- **Kindermodus**: per gebruiker `max_age`, "titels zonder classificatie ook verbergen" (standaard aan) en "eenvoudige home". Loopt via dezelfde rechtenlaag (`access.js`) als de bibliotheekrechten, dus geldt in home, zoeken, collecties, details, play, Mijn lijst, voortgang, Watch Night en samen kijken. Live tv is uit voor een account met leeftijdsgrens (zenders hebben geen classificatie).
- **Trickplay** (`trickplay.js`): na een scan op de achtergrond, met `nice -n 19`, één bestand tegelijk; alleen keyframes worden gedecodeerd. Eén plaatje per 10 s, 100 per sheet. Per bibliotheek aan/uit (standaard uit). Tonen: zweven boven de zoekbalk (web), slepen (mobiel), na elke sprong (tv).
- **HDR → SDR**: `pipelines()` kiest per pad: VA-API `tonemap_vaapi`; Quick Sync/NVENC/V4L2 softwarefilter + hardware-encode; software `zscale`+`tonemap` (hable). Mislukt de keten, dan valt de sessie terug op de volgende en uiteindelijk op omzetten zonder tonemapping. HDR-detectie (PQ/HLG) bestond al in de ffprobe-uitlezing.
- Migratie 3. De federatie-catalogus geeft de leeftijd door.

## Keuzes
- Trickplay staat standaard **uit** per bibliotheek: het kost rekentijd en schijfruimte, en aanzetten is één schakelaar.
- `tonemap_opencl` en `libplacebo` worden wel gedetecteerd maar niet gebruikt: zonder GPU hier niet te testen.
- Eenvoudige home = minder rijen (verder kijken, nieuw, mijn lijst, vier genres), geen trailers. Geen aparte vormgeving.
- Onbekende certificeringen ("Not Rated") tellen als geen classificatie.

## Getest
- `npm test`: 40 van 40 (5 nieuw). Met echte ffmpeg: een HDR10-fragment wordt herkend en de softwareketen levert SDR `yuv420p`; van een fragment van 65 s komen 7 previews op één sheet en de route serveert ze alleen met een geldig ticket.
- Kindermodus: 6 lijsten en 15 directe routes met een account met grens 9.
- `flutter analyze` schoon, `flutter test` 4 van 4.

## Zelf testen
1. Zet bij een bibliotheek "Spoel-previews" aan; na een tijdje verschijnen plaatjes bij het spoelen. Op een toestel is dit niet geprobeerd.
2. Speel een HDR-film af in een lagere kwaliteit: de kleuren horen normaal te zijn, niet grijs. `tonemap_vaapi` op een echte videokaart is hier niet getest.
3. Geef een testgebruiker een leeftijdsgrens en kijk als die gebruiker rond; controleer onder Beheer → Metadata hoeveel titels geen classificatie hebben.
