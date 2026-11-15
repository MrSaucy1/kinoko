## Fase 4 — sociaal

Gestapeld op `feat/viewing`.

- **Chat en reacties** bestonden al in samen kijken; nieuw: een limiet per deelnemer (5 berichten en 10 reacties per 10 s, de afzender krijgt een melding), de laatste 50 berichten voor wie later binnenkomt, en strengere invoercontrole. Berichten staan alleen in het geheugen van de kamer.
- **Watch Night-stemmen**: `POST /api/watch/vote` opent een kamer zonder film met de drie gedobbelde titels. Iedereen (ook gasten) stemt via de bestaande WebSocket; bij meer dan de helft van de aanwezigen of na 90 s start de winnaar voor iedereen. Gelijkspel of geen stemmen: loting.
- **Gedeelde lijsten** (`lists.js`): lijsten met een naam, te delen per gebruiker als "bekijken" of "bewerken". Een lijst die niet van jou is en niet met je gedeeld, bestaat voor jou niet (404). Titels die de kijker niet mag zien (bibliotheekrechten, kindermodus) ontbreken voor die kijker in de lijst.
- **Kinoko Wrapped** (`wrapped.js`, `watchlog.js`): kijktijd per gebruiker, titel en dag in `watch_log`, gevuld vanuit `/api/progress` (alleen stappen vooruit die bij de klok passen, dus spoelen telt niet). Overzicht: uren, kijkdagen, top-titels, top-genres, langste sessie, favoriete dag, verdeling per maand. Alleen het eigen overzicht is op te vragen; delen gaat met een link die de gebruiker zelf maakt en weer intrekt.
- Migratie 4 vult `watch_log` eenmalig vanuit de bestaande voortgang, zodat het eerste overzicht niet leeg is.

## Keuzes
- "Langste kijksessie" = de meeste tijd aan één titel op één dag.
- `GET /api/users/directory` geeft elke ingelogde gebruiker de namen van de anderen (nodig om te delen). Op een server voor vrienden lijkt dat acceptabel.
- De gedeelde Wrapped-pagina toont naam, titels en posters, geen interne id's.
- Wrapped is uitbreidbaar (`addWrappedSection`); muziek haakt daar in fase 9 op in.

## Getest
- `npm test`: 46 van 46 (6 nieuw), waaronder echte WebSocket-verbindingen voor chat, limiet en stemmen, en IDOR-pogingen op lijsten.
- Lijsten, Wrapped en de stemkamer in een headless browser.
- `flutter analyze` schoon, `flutter test` 4 van 4.

## Zelf testen
1. Watch Night → "Samen stemmen", nodig iemand uit via de link en stem.
2. Maak een lijst, deel hem met een ander account als "bekijken" en probeer daar iets toe te voegen.
3. Profiel → Jouw jaar; maak een deellink en open hem in een privévenster.
