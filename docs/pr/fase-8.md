## Fase 8 — Spotify-gevoel

Gestapeld op `feat/music-app`.

**Server** (`musicextra.js`, migratie 7)
- **ReplayGain**: voor nummers zonder tags meet een achtergrondtaak de loudness met ffmpeg `ebur128` (lage prioriteit) en slaat track-gain en piek op; album-gain wordt uit de nummers berekend. Uit te zetten.
- **Songteksten**: `.lrc` naast het bestand, tekst uit de tags, of LRCLIB (gratis, geen sleutel). Resultaten, ook "niets gevonden", worden bewaard.
- **Radio**: `GET /api/music/radio` op basis van eigen gegevens (zelfde artiest, zelfde genres, wat gebruikers samen luisteren), optioneel aangevuld met vergelijkbare artiesten van Last.fm. Hooguit vier nummers per artiest.
- **Home-mixes**: "Opnieuw ontdekken" en een dagmix per favoriet genre; de hele dag gelijk, morgen anders.
- **Scrobbelen** per gebruiker: ListenBrainz (eigen token) en Last.fm (sleutel en geheim van de beheerder, gebruiker geeft toestemming op last.fm). Tokens komen nooit terug in een response.
- **Kinoko Connect**: spelers melden zich op het bestaande meldingskanaal; `GET /api/music/devices` en `POST /api/music/devices/:id/command`. Alleen eigen apparaten zijn te zien en te bedienen.

**Kinoko Music**
- **Naadloos** afspelen via de afspeellijst van de speler; **overvloeien** 0–12 s met een tweede speler die het volgende nummer onder het einde start. Opeenvolgende nummers van één album blijven naadloos.
- **Volume gelijktrekken**: per nummer, per album of uit.
- **Offline downloads**: albums, playlists en gelikete nummers; volgt wijzigingen op de server; eigen kwaliteit, opslaglimiet, alleen via wifi. Gedownloade nummers spelen van het toestel, ook zonder server.
- **Kwaliteit per netwerk**: wifi en mobiel apart.
- **Songteksten**: meescrollend, tik op een regel om daarheen te springen.
- **Radio**: "Start radio" bij nummer, artiest en album; doorspelen als de wachtrij op is.
- **Scrobbelen** en **Apparaten** (Connect) in de instellingen en de speler.

**Web**: de web-speler is een Connect-apparaat (zichtbaar en te bedienen vanuit de app); beheerinstellingen voor volume meten, songteksten en Last.fm.

## Nieuwe dependency
- `connectivity_plus` (alleen `music/`): weten of het toestel op wifi of mobiel zit, voor kwaliteit per netwerk en "alleen via wifi downloaden".

## Keuzes
- Vergelijkbare artiesten: alleen Last.fm (met sleutel). ListenBrainz heeft daar geen stabiele openbare route voor; de eigen gegevens zijn de basis.
- Album-gain is een berekening uit de track-waarden, geen meting van het hele album achter elkaar.
- Volume gelijktrekken kan alleen zachter zetten; een nummer dat harder zou moeten blijft zoals het is.
- Offline: de app opent ook zonder server; home toont dan een fout en de muziek staat onder Bibliotheek → Downloads.
- Last.fm koppelen in de app gaat met een link die je zelf in de browser opent (geen extra pakket om een browser te starten).

## Getest
- `npm test`: 61 van 61 (6 nieuw): loudness-meting van een echt bestand, songteksten met nagemaakte LRCLIB, radio (ook met rechten), mixes, scrobbelen met nagemaakte diensten, Connect met pogingen op andermans apparaat.
- `flutter analyze` schoon voor `app/` en `music/`; `flutter test` geslaagd.

## Niet getest
- Alles wat geluid maakt op een toestel: overvloeien (twee spelers en het overnemen), volume gelijktrekken, naadloos afspelen.
- Downloads op een toestel, het gedrag zonder verbinding.
- Echte verzoeken naar LRCLIB, ListenBrainz en Last.fm.

## Zelf testen
1. Zet overvloeien op een paar seconden en luister naar de overgang tussen twee losse nummers. Klinkt het niet goed, zet het dan op 0; meld het dan graag.
2. Download een playlist, zet de vliegtuigmodus aan en speel hem af onder Bibliotheek → Downloads.
3. Open de muziekpagina in de browser en zet in de app het afspelen daarheen over (speler → Apparaten).
