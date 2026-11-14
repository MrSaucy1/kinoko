## Fase 1 — snelle verbeteringen

Gestapeld op `fix/security-hardening`.

**Server**
- **Bestandswatcher** (`watcher.js`): `fs.watch` op elke bibliotheekmap, 30 s na de laatste wijziging start een scan. Tijdelijke en verborgen bestanden tellen niet mee. De periodieke scan blijft.
- **Back-ups** (`backup.js`): dagelijks `VACUUM INTO` naar `KINOKO_DATA/backups/`, de laatste N (standaard 7) blijven. Lijst, nu maken, downloaden en verwijderen in het beheer; alleen voor beheerders.
- **Voorkeuren per serie**: `PUT /api/titles/:id/prefs`, terug te lezen in de titeldetails. Per gebruiker.
- **Ondertitel-offset**: `PUT /api/files/:id/sub-offset`, per gebruiker en bestand; `/api/play` geeft `subOffsetMs` terug.
- **Verder op ander apparaat**: nieuw kanaal `/api/events/ws`. `POST /api/progress` met `paused: true` stuurt een aanbod naar de andere open apparaten van dezelfde gebruiker.
- **Extra's**: `Extras/`, `Featurettes/`, `Behind The Scenes/`, `Trailers/`, `Deleted Scenes/`, `Interviews/` en bestanden met `-trailer` e.d. komen in de tabel `extras` en op de detailpagina, nooit als losse titel.
- **Limiet per gebruiker**: kolom `users.max_quality`. Afgedwongen in `/api/play`, bij samen kijken en bij extra's; wie begrensd is krijgt geen downloadlink naar het origineel.
- **Webhooks** (`webhooks.js`): Discord of algemene JSON, per webhook te kiezen gebeurtenissen, testknop. Het adres komt nooit volledig terug in een response.
- Migratie 1 voegt de tabellen en de kolom toe.

**Web**: beheerpagina's Back-ups en Meldingen, limiet per gebruiker, extra's op de titelpagina, timing in het ondertitelmenu, aanbod "Verder kijken".

**App**: extra's op de detailpagina, timing in het ondertitelmenu, serievoorkeuren, aanbod "Verder kijken". Beheer loopt via de bestaande webweergave.

## Keuzes
- Een bestand met een achtervoegsel als `-trailer` telt alleen als extra wanneer het hoofdbestand ernaast staat; anders zou een film als "The Other" verdwijnen.
- Een gast bij samen kijken valt onder de limiet van wie de kamer opende.
- De ondertitel-offset wordt per gebruiker én bestand bewaard.
- Een back-up bevat wachtwoord-hashes en sessies; dat staat bij de downloadknop.

## Getest
- `npm test`: 28 van 28 (8 nieuw voor deze fase). Tests gebruiken geen internet.
- `flutter analyze` schoon, `flutter test` 4 van 4.
- Beheerpagina's Back-ups, Meldingen en Gebruikers en het meldingskanaal in een headless browser.

## Zelf testen
1. Zet een bestand in een bibliotheekmap en kijk of het na ongeveer een minuut verschijnt (op een NFS/SMB-share kan dat tot de periodieke scan duren).
2. Maak een map `Extras` naast een film en scan; de extra's staan op de titelpagina.
3. Stel bij Gebruikers een limiet in en speel als die gebruiker een 1080p-film af.
4. Pauzeer op de telefoon terwijl de browser open staat: daar verschijnt "Verder kijken".
5. Voeg onder Meldingen een Discord-webhook toe en druk op Testen.
6. Verschuif ondertitels in web en app; in de app is dit niet op een toestel geprobeerd.
