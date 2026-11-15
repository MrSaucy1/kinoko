## Fase 5 — beheer en automatisering

Gestapeld op `feat/social`.

- **Activiteit-dashboard** (`activity.js`): elke `/api/play` registreert een stream (gebruiker, apparaat, titel, direct of omgezet, kwaliteit); `/api/progress` werkt positie en pauze bij. Beheer → Activiteit ververst elke 3 s en toont ook processor, belasting, geheugen, videokaart (AMD via sysfs, NVIDIA via `nvidia-smi`; anders "onbekend") en de lopende omzettingen.
- **Stream stoppen**: sluit de omzetsessie en trekt de uitgegeven links in, zodat het ook echt stopt. Alleen het apparaat dat keek krijgt de melding (met de tekst van de beheerder) en sluit de speler.
- **Sonarr/Radarr-webhook** (`POST /api/hooks/arr/<token>`): het token wordt in het beheer aangemaakt, in constante tijd vergeleken, en is te vervangen of uit te zetten. Na een import wordt alleen de betreffende map gescand (`scanPath`); ligt het pad buiten elke bibliotheek, dan volgt een gewone scan. Padvertaling voor als Radarr/Sonarr de mappen anders ziet.
- **Verzoeken** (`requests.js`): zoeken via TMDB (met sleutel) of Cinemeta, aanvragen, eigen verzoeken bekijken en intrekken; de beheerder keurt goed of af. Bij goedkeuren optioneel doorsturen naar Radarr/Sonarr. De aanvrager krijgt een melding; webhooks `request.created` en `request.updated`. Staat de titel na een scan in de bibliotheek, dan wordt het verzoek "beschikbaar".
- Migratie 5.

## Keuzes
- Clients sturen `track: false` mee als ze alleen een downloadlink ophalen, zodat dat niet als stream telt.
- Een stream van een gekoppelde server kan niet hard worden afgebroken (de links zijn van de andere server); de kijker krijgt wel de melding en de speler sluit.
- Het webhook-adres is zelf het geheim; beheerders zien het in het beheer, omdat het in Sonarr/Radarr geplakt moet worden. API-sleutels van Radarr/Sonarr komen alleen gemaskeerd terug.
- Radarr/Sonarr: eerste rootmap en eerste kwaliteitsprofiel worden gebruikt.
- Accounts met een leeftijdsgrens kunnen niets aanvragen.
- Intel-GPU-belasting is zonder extra hulpprogramma niet uit te lezen en staat op "onbekend".

## Getest
- `npm test`: 49 van 49 (3 nieuw): streams en stoppen (link werkt daarna niet meer), webhook met echte scan van een tijdelijke map, verzoeken met een nagemaakte Radarr.
- Beheerpagina's in een headless browser; `flutter analyze` schoon, `flutter test` 4 van 4.

## Zelf testen
1. Speel iets af en kijk in Beheer → Activiteit; stop de stream met een bericht.
2. Beheer → Verzoeken: zet de webhook aan, plak het adres in Radarr/Sonarr en druk daar op Test.
3. Vul adres en API-sleutel van Radarr in, vraag als gewone gebruiker een film aan en keur hem goed. Met een echte Radarr/Sonarr is dit niet getest.
