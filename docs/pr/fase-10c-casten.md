## Fase 10c — casten

Gestapeld op `feat/archive`.

Casten loopt via de **server**: die vindt de apparaten in huis en vertelt ze wat ze moeten afspelen; het apparaat haalt de stream daarna rechtstreeks bij Kinoko op (met een afspeelticket, nooit met een sessietoken). Daardoor werkt het hetzelfde vanuit de web-GUI, de app en Kinoko Music, zonder Cast-SDK in de apps.

- **Chromecast** (`cast.js`): het Cast-protocol zelf geïmplementeerd (protobuf over TLS, een handvol berichten), met de standaard media-ontvanger van Google. Vinden via mDNS.
- **DLNA/UPnP**: vinden via SSDP, aansturen met AVTransport (SetAVTransportURI, Play, Pause, Stop, Seek).
- **Profielen**: een Chromecast krijgt het origineel als hij het aankan (mp4/webm, H.264/VP9, AAC/MP3/Opus/FLAC) en anders HLS (H.264/AAC) van de bestaande transcoder; DLNA krijgt het origineel. Muziek die een Chromecast niet kent gaat als AAC 320 kbps. De kwaliteitslimiet per gebruiker geldt ook hier.
- **Bediening**: pauze, verder, stoppen, spoelen; alleen wie het startte (of een beheerder).
- **UI**: "Afspelen op…" in de web-speler, de app (mobiel) en Kinoko Music; gedeelde sheet in `packages/kinoko_core/lib/cast.dart`.

## Keuzes
- Geen Cast-SDK en geen extra pakket in de apps: dat zou native code en een geregistreerde ontvanger vragen, en is hier niet te bouwen of te testen. De prijs: de server en het apparaat moeten in hetzelfde netwerk zitten (multicast), dus casten werkt niet als je buitenshuis bent.
- Het certificaat van een Chromecast wordt niet gecontroleerd (de apparaten gebruiken eigen certificaten); er wordt alleen verbonden met adressen uit het eigen netwerk die bij het zoeken zijn gevonden.
- Titels en nummers van een gekoppelde server zijn nog niet te casten.
- Ondertitels gaan niet mee naar het apparaat.

## Getest
- `npm test`: 67 van 67 (1 nieuw): het berichtformaat (heen en terug), een mDNS-antwoord, een SSDP-antwoord en apparaatbeschrijving, en een volledige DLNA-ronde tegen een nagemaakte renderer (adres met ticket, metadata, spoelen, bediening alleen door de starter).

## Niet getest
- **Geen echte Chromecast en geen echt DLNA-apparaat.** Het vinden via multicast vanuit een LXC-container en het afspelen zelf moeten bij jou blijken.

## Zelf testen
1. Open een film in de browser → "Afspelen op…". Verschijnt je Chromecast of tv niet, dan komt multicast waarschijnlijk niet in de container aan.
2. Start, pauzeer en stop vanaf het scherm.
