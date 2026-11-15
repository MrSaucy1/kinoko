# Kinoko

Je eigen streamingdienst: een mediaserver met web-GUI, een Android-app en een
Android TV-app. Zwart en paars, Netflix-achtig, en gemaakt om met vrienden te
delen.

```
server/   Node.js-server (API, scanner, transcoding, samen kijken, koppelingen, muziek)
web/      Web-GUI: onboarding, kijken in de browser, beheer (geen build-stap)
app/      Flutter-app — één codebase, twee varianten: mobiel en tv
music/    Kinoko Music: de muziek-app (telefoon, Android Auto)
packages/ kinoko_core: code die beide apps delen (API-client, thema, inlogscherm)
install/  Proxmox-helperscript, installer en de root-beheerhulp
```

## Wat het kan

| | |
|---|---|
| **Films & series** | Scant mappen, herkent titels en afleveringen, leest technische details met ffprobe. |
| **Metadata** | Eerst lokale `.nfo`/posters, daarna open bronnen zonder sleutel (Cinemeta, Wikidata). Een TMDB-sleutel is optioneel (Nederlandse teksten, acteursfoto's). |
| **Slimme collecties** | Films die bij elkaar horen (MCU, Spider-Man, Toy Story…) worden automatisch gegroepeerd. |
| **Home** | Uitgelicht, verder kijken, aanbevelingen, rijen per genre, collecties. |
| **Versies** | Staat een film op meerdere (gekoppelde) servers, dan kiest Kinoko de hoogste bitrate; je ziet per versie van welke server hij komt en kunt zelf wisselen. |
| **Transcoderen** | Lagere kwaliteit wordt live omgezet (HLS) met VA-API, Quick Sync, NVENC of V4L2; valt terug op software. HDR wordt daarbij omgezet naar SDR. |
| **Samen kijken** | Uitnodigen via link of code; afspelen, pauzeren en spoelen is voor iedereen gelijk. Chat en emoji-reacties, ook voor gasten zonder account. |
| **Servers koppelen** | Koppellink maken, bij de ander plakken: elkaars bibliotheken verschijnen als eigen titels. |
| **Intro overslaan / volgende aflevering** | Intro's en aftiteling worden herkend via hoofdstukken en geluidsvergelijking binnen een seizoen. |
| **Ondertitels** | Ingebed, los bestand, of online zoeken en downloaden. |
| **Downloads** | In de mobiele app, hervatbaar, offline af te spelen. |
| **Watch Night** | Thema op basis van seizoen/feestdag en drie gedobbelde films. Samen stemmen: de winnaar start voor iedereen in de kamer. |
| **Lijsten** | Lijsten met een naam, te delen met andere gebruikers om te bekijken of samen te vullen. |
| **Jouw jaar** | Kinoko Wrapped: uren, top-titels, genres, langste sessie en favoriete kijkdag. Privé, tot je zelf een deellink maakt. |
| **Muziek** | Eigen muziekbibliotheek: tags en hoezen uit de bestanden, ontbrekende hoezen en artiestfoto's optioneel via MusicBrainz/Cover Art Archive/Wikidata. Albums, artiesten, genres, zoeken met typfouten, playlists (privé of gedeeld), likes, wachtrij en geschiedenis. Afspelen in het origineel of omgezet naar Opus/AAC (96/160/320 kbps). |
| **Kinoko Music** | Muziek-app in Spotify-stijl: home met dagmixen, zoeken, bibliotheek, album- en artiestpagina's, speler met wachtrij, shuffle/herhalen, liken, playlists maken en delen. Naadloos afspelen en overvloeien, volume gelijktrekken (ReplayGain), meescrollende songteksten, radio en doorspelen, offline downloads, aparte kwaliteit voor wifi en mobiel, scrobbelen naar ListenBrainz/Last.fm, en Kinoko Connect (afspelen overzetten naar een ander apparaat). Android Auto met spraakzoeken. |
| **Live tv** | Xtream Codes of M3U, één keer ingesteld door de beheerder. |
| **Extra's** | Trailers, featurettes en making-ofs (`Extras/`, `Trailers/`, `Film-trailer.mkv`…) staan op de pagina van de titel. |
| **Nieuwe bestanden** | Mappen worden bewaakt: een nieuw of verwijderd bestand is binnen ongeveer een minuut verwerkt. De periodieke scan blijft als vangnet voor netwerkschijven. |
| **Voorkeuren per serie** | De gekozen audiotaal en ondertitel gelden vanzelf voor de volgende afleveringen. Ondertitels zijn per 0,1 s te verschuiven. |
| **Verder op een ander apparaat** | Pauzeer je ergens, dan vraagt een ander open apparaat of je daar verder wilt kijken. |
| **Limiet per gebruiker** | De beheerder stelt per account een maximale streamkwaliteit in. |
| **Back-ups** | Dagelijks een kopie van de database; in het beheer te maken en te downloaden. |
| **Meldingen** | Webhooks (Discord of algemene JSON) bij een nieuwe titel, een kijker, een afgeronde scan of een fout. |
| **Kindermodus** | Leeftijdsclassificatie per titel (Kijkwijzer: AL/6/9/12/14/16/18, uit TMDB, Wikidata of `.nfo`). Per gebruiker een maximale leeftijd; alles daarboven is overal verborgen. Optioneel een eenvoudige home. |
| **Spoel-previews** | Voorbeeldplaatjes bij het spoelen in web, mobiel en tv; per bibliotheek aan te zetten. |
| **Activiteit** | Live in het beheer: wie wat kijkt (direct of omgezet, apparaat, voortgang), belasting van processor/videokaart en lopende omzettingen. Een stream is te stoppen met een bericht voor de kijker. |
| **Verzoeken** | Gebruikers vragen een film of serie aan, de beheerder keurt goed of af. Optioneel gaat een goedgekeurd verzoek door naar Radarr/Sonarr. |
| **Sonarr/Radarr-webhook** | Een geheim adres dat na een import meteen de betreffende map scant. |
| **Tweestapsverificatie** | Optioneel per account (TOTP, elke authenticator-app), met herstelcodes. De beheerder kan het verplichten voor beheerders. |
| **Rechten per bibliotheek** | Per gebruiker kiest de beheerder welke bibliotheken (en gekoppelde servers) zichtbaar zijn; de rest bestaat voor die gebruiker niet. |
| **Logboek** | Inlogpogingen, wijzigingen aan gebruikers en instellingen, koppelingen en updates; te filteren in het beheer. |
| **Apparaten** | Per account zie je waar je bent ingelogd en log je een apparaat uit; ongebruikte sessies verlopen vanzelf. |
| **Externe toegang** | Tailscale, Cloudflare Tunnel of eigen domein, in te stellen vanuit het beheer. |

## Installeren op Proxmox

Op de Proxmox-host, als root:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/MrSaucy1/kinoko/main/install/kinoko-lxc.sh)"
```

Het script vraagt om container-ID, opslag, de map met je media en of de
videokaart doorgegeven moet worden, maakt een Debian-container en installeert
Kinoko. Open daarna `http://<ip>:8096` en doorloop de onboarding.

Al een Debian/Ubuntu-machine of -container? Dan alleen:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/MrSaucy1/kinoko/main/install/install.sh)"
```

Beide scripts werken ook vanuit een `git clone`; dan wordt die checkout
geïnstalleerd. Een fork gebruiken: zet `KINOKO_REPO=https://github.com/<jij>/kinoko.git`
voor het commando.

**Let op bij een unprivileged container:** de mediamap wordt alleen-lezen
gekoppeld op `/mnt/media`; de bestanden moeten voor "anderen" leesbaar zijn.

Bijwerken kan via *Beheer → Overzicht → Kinoko bijwerken*.

## Apps

De APK's staan bij de [release `latest`](../../releases/tag/latest):
`kinoko-vX.Y.Z.apk` (telefoon/tablet) en `kinoko-tv-vX.Y.Z.apk` (Android TV).
Bij de eerste start vul je het adres van je server in.

Voor muziek is er een eigen app: `kinoko-music-vX.Y.Z.apk`. Die speelt door op
de achtergrond, met bediening in de melding, op het vergrendelscherm en via
koptelefoon- of Bluetooth-knoppen.

De apps worden door GitHub Actions gebouwd (`.github/workflows/build.yml`).

### Kinoko Music in de auto (Android Auto)

Kinoko Music komt niet uit de Play Store, en Android Auto toont standaard
alleen apps die daar vandaan komen. Eén keer instellen op je telefoon:

1. Open de instellingen van **Android Auto** (Instellingen → Verbonden apparaten → Android Auto, of zoek op "Android Auto").
2. Scroll naar beneden en tik **tien keer op "Versie"**, tot er staat dat de ontwikkelaarsinstellingen aan zijn.
3. Tik rechtsboven op de drie puntjes → **Ontwikkelaarsinstellingen**.
4. Zet **Onbekende bronnen** aan.
5. Verbind je telefoon opnieuw met de auto. Kinoko Music staat nu bij de media-apps.

In de auto blader je door Home, Playlists, Albums, Artiesten en Gelikete
nummers, en werkt spraak: "speel Queen af op Kinoko Music".

## Ontwikkelen

```bash
cd server && npm install
KINOKO_DATA=./data npm start        # http://localhost:8096
npm test

cd app && flutter pub get && flutter analyze && flutter test
cd music && flutter pub get && flutter analyze && flutter test
```

Instellingen via omgevingsvariabelen: `KINOKO_PORT`, `KINOKO_DATA`,
`KINOKO_FFMPEG`, `KINOKO_FFPROBE`.

## fail2ban / CrowdSec

Bij elke mislukte inlogpoging schrijft Kinoko precies één regel naar het
logboek van de service (`journalctl -u kinoko`):

```
kinoko: auth failure ip=203.0.113.7 reason=password
```

`reason` is `password`, `totp` of `throttled`. In de regel staat niets wat de
bezoeker zelf heeft ingetypt. Een kant-en-klaar filter en een voorbeeld-jail
staan in `install/fail2ban/`:

```bash
cp install/fail2ban/kinoko.conf  /etc/fail2ban/filter.d/kinoko.conf
cp install/fail2ban/kinoko.local /etc/fail2ban/jail.d/kinoko.local
systemctl restart fail2ban
```

Staat Kinoko achter een reverse proxy op een andere machine, dan gelooft Kinoko
het doorgegeven adres alleen als die proxy op het lokale netwerk staat. Voor een
proxy elders: zet `KINOKO_TRUST_PROXY` op het adres van die proxy.

## Goed om te weten

- Een apparaat dat 90 dagen niet is gebruikt, wordt vanzelf uitgelogd (aan te passen in Beheer → Overzicht). Onder Apparaten zie je waar je bent ingelogd en log je een apparaat uit.
- Posters en afbeeldingen zijn zonder inloggen op te vragen; al het andere vraagt een account, een gast-token of een tijdelijke afspeellink.
- Streams van een gekoppelde server lopen via je eigen server.
- HDR (PQ/HLG) wordt bij transcoderen omgezet naar SDR: op VA-API met `tonemap_vaapi`, anders in software met `zscale`+`tonemap` (ffmpeg met libzimg, standaard op Debian/Ubuntu). Kan dat op jouw ffmpeg niet, dan valt Kinoko terug op omzetten zonder tonemapping. Direct afspelen blijft HDR.
- Live tv in de browser werkt alleen bij providers die HLS aanbieden; in de apps speelt alles.
