## Fase 6 — muziek: server

Gestapeld op `feat/admin`. Eigen API, geen Subsonic.

- **Bibliotheektype `music`**. De tabel `libraries` had een CHECK op het type; migratie 6 bouwt die tabel opnieuw op volgens het recept van SQLite (foreign keys uit rond de transactie, `foreign_key_check` vóór de commit). Alle rijen en id's blijven; daar is een aparte test voor.
- **Scanner** (`music.js`): ffprobe-tags (titel, artiest, albumartiest, album, track/disc, jaar, genres, duur, codec, bitrate, sample rate, MusicBrainz-id's, ReplayGain en R128), terugval op bestands- en mapnamen, lokale hoezen (`cover.jpg`, `folder.jpg`, … of ingebed). Verzamelalbums komen onder "Diverse artiesten".
- **Schema**: `artists`, `albums`, `album_artists`, `tracks`, `genres`, `track_genres`, `playlists`, `playlist_items`, `playlist_shares`, `music_likes`, `music_plays`, `music_queue`, met indexen op alles waarop gezocht of gesorteerd wordt.
- **Online metadata** (`musicmeta.js`, optioneel, uit te zetten): MusicBrainz met een herkenbare User-Agent en hooguit één verzoek per seconde, Cover Art Archive voor ontbrekende hoezen, Wikidata/Wikimedia voor artiestfoto en korte omschrijving.
- **Streamen**: origineel met Range-requests, of omgezet naar Opus (Ogg) of AAC (MP4) op 96/160/320 kbps. Een omgezet nummer wordt één keer gemaakt en bewaard in een cache met een instelbare grootte, zodat spoelen ook daar met Range werkt. Tickets zoals bij video.
- **API** (`musicapi.js`): home, artiesten, albums, nummers, genres, zoeken (artiest/album/nummer/playlist, ook met typfouten), playlists (CRUD, volgorde, delen), likes, wachtrij, geschiedenis.
- **Rechten**: dezelfde bibliotheekrechten als video. Playlists zijn privé tenzij gedeeld.
- **Federatie**: muziek van gekoppelde servers wordt meegesynchroniseerd en speelt via je eigen server.
- **Web**: `/muziek` met albums, artiesten, playlists, zoeken en een spelerbalk die blijft doorspelen; muziek in het beheer (bibliotheektype, tellingen, online opzoeken aan/uit, cachegrootte).

## Keuzes
- Muziek heeft geen leeftijdsclassificatie. Een account met leeftijdsgrens krijgt alle muziek behalve nummers die in hun tags als "explicit" staan.
- Hoezen zijn net als posters zonder inloggen opvraagbaar.
- Omzetten gebeurt per heel nummer naar een cachebestand in plaats van live naar een pijp: dat duurt een seconde of twee, maar maakt Range en offline downloads (fase 8) mogelijk.
- Een MP3/AAC/Opus-bestand met een lagere bitrate dan gevraagd wordt niet omgezet.
- "Diverse artiesten" en "Onbekende artiest" zijn gewone artiestrijen.

## Getest
- `npm test`: 55 van 55 (6 nieuw). Met echte ffmpeg: getagde MP3/FLAC-bestanden scannen, bladeren, zoeken met typfout, playlists met volgorde en delen (en pogingen van een ander account), likes, wachtrij, geschiedenis, Range op het origineel en op een Opus-omzetting, rechten en kindermodus, verwijderde bestanden.
- De migratie tegen een nagebouwde oude database.
- Online opzoeken met nagemaakte antwoorden; echte verzoeken naar MusicBrainz zijn niet gedaan.
- De webweergave in een headless browser met gegenereerde nummers (afspelen, zoeken, beheer).

## Zelf testen
1. **Maak eerst een back-up** (Beheer → Back-ups) voordat je bijwerkt: migratie 6 herbouwt de tabel met bibliotheken.
2. Voeg een bibliotheek van het type Muziek toe en kijk onder Muziek in de navigatie.
3. Kies in de muziekweergave een lagere kwaliteit en speel een FLAC af.
