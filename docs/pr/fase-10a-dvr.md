## Fase 10a — live tv opnemen (DVR)

Gestapeld op `feat/widgets`.

- **Opnemen** (`dvr.js`): ffmpeg kopieert de stream van de zender voor de duur van het programma naar een `.mkv` (geen omzetting, dus nauwelijks CPU). Eén minuut eerder beginnen, drie minuten uitloop.
- **Plannen**: uit de gids van de zender (Xtream), of met een zelf gekozen tijd (ook voor M3U-zenders zonder gids). **Serie**: een regel per zender en titel; elk half uur wordt de gids bekeken en wat past ingepland.
- **Bibliotheek "Opnames"**: wordt bij de eerste opname gemaakt (`KINOKO_DATA/recordings`, aan te passen); na een opname wordt de map meteen gescand.
- **Opslag**: limiet in GB en optioneel een bewaartermijn; de oudste opnames gaan eerst weg.
- **Beheer → Opnames**: zender zoeken, gids, opnemen/hele serie, lopende opname stoppen (wat er is blijft bewaard), opslaginstellingen.
- Migratie 8.

## Keuzes
- Plannen en beheren is voor beheerders: een opname gebruikt een verbinding bij de provider en schijfruimte. Kijken kan iedereen die de bibliotheek mag zien.
- Een opname telt bij de provider als een kijker. Bij een abonnement met één verbinding kan live kijken tijdens een opname mislukken.
- Na een herstart wordt een lopende opname niet hervat; wat er al stond blijft bewaard en wordt als "onderbroken" gemarkeerd.
- Meerdere opnames met dezelfde titel verschijnen als versies van één titel.

## Getest
- `npm test`: 65 van 65 (3 nieuw). Met echte ffmpeg: een "zender" (MPEG-TS over HTTP) wordt opgenomen en staat daarna als titel in de bibliotheek; een zender die weigert geeft "mislukt"; de limiet ruimt op; verwijderen raakt nooit een bestand buiten de opnamemap.

## Niet getest
- Een echte IPTV-provider en opnames van uren.
- Het beheerscherm in een browser (alleen syntaxcontrole).
