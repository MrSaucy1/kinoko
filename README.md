# Kinoko

Je eigen streamingdienst: een mediaserver met web-GUI, een Android-app en een
Android TV-app. Zwart en paars, Netflix-achtig, en gemaakt om met vrienden te
delen.

```
server/   Node.js-server (API, scanner, transcoding, samen kijken, koppelingen)
web/      Web-GUI: onboarding, kijken in de browser, beheer (geen build-stap)
app/      Flutter-app — één codebase, twee varianten: mobiel en tv
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
| **Transcoderen** | Lagere kwaliteit wordt live omgezet (HLS) met VA-API, Quick Sync, NVENC of V4L2; valt terug op software. |
| **Samen kijken** | Uitnodigen via link of code; afspelen, pauzeren en spoelen is voor iedereen gelijk. Gasten hebben geen account nodig. |
| **Servers koppelen** | Koppellink maken, bij de ander plakken: elkaars bibliotheken verschijnen als eigen titels. |
| **Intro overslaan / volgende aflevering** | Intro's en aftiteling worden herkend via hoofdstukken en geluidsvergelijking binnen een seizoen. |
| **Ondertitels** | Ingebed, los bestand, of online zoeken en downloaden. |
| **Downloads** | In de mobiele app, hervatbaar, offline af te spelen. |
| **Watch Night** | Thema op basis van seizoen/feestdag en drie gedobbelde films. |
| **Live tv** | Xtream Codes of M3U, één keer ingesteld door de beheerder. |
| **Externe toegang** | Tailscale, Cloudflare Tunnel of eigen domein, in te stellen vanuit het beheer. |

## Installeren op Proxmox

De repository is privé: je hebt toegang nodig (uitnodiging als collaborator)
en logt bij het clonen in met je GitHub-account of een token.

Op de Proxmox-host, als root:

```bash
apt-get install -y git
git clone https://github.com/MrSaucy1/kinoko.git
bash kinoko/install/kinoko-lxc.sh
```

Het script vraagt om container-ID, opslag, de map met je media en of de
videokaart doorgegeven moet worden, maakt een Debian-container en installeert
Kinoko daarin vanuit je clone. Open daarna `http://<ip>:8096` en doorloop de
onboarding.

Al een Debian/Ubuntu-machine of -container? Clone daar en voer uit:

```bash
sudo bash kinoko/install/install.sh
```

**Bijwerken.** Zonder meer: `git pull` in je clone en het script opnieuw
uitvoeren (bij een LXC: `install.sh` in de container; je instellingen en
bibliotheek blijven staan in `/var/lib/kinoko`). Wil je de knop *Kinoko
bijwerken* in het beheer gebruiken, geef dan bij het installeren een
GitHub-token met alleen leesrechten op deze repository mee:
`KINOKO_TOKEN=github_pat_… bash kinoko/install/kinoko-lxc.sh`.

**Let op bij een unprivileged container:** de mediamap wordt alleen-lezen
gekoppeld op `/mnt/media`; de bestanden moeten voor "anderen" leesbaar zijn.

## Apps

De APK's staan bij de [release `latest`](../../releases/tag/latest) (zichtbaar voor wie toegang heeft tot de repository):
`kinoko-vX.Y.Z.apk` (telefoon/tablet) en `kinoko-tv-vX.Y.Z.apk` (Android TV).
Bij de eerste start vul je het adres van je server in.

De apps worden door GitHub Actions gebouwd (`.github/workflows/build.yml`).

## Ontwikkelen

```bash
cd server && npm install
KINOKO_DATA=./data npm start        # http://localhost:8096
npm test

cd app && flutter pub get && flutter analyze && flutter test
```

Instellingen via omgevingsvariabelen: `KINOKO_PORT`, `KINOKO_DATA`,
`KINOKO_FFMPEG`, `KINOKO_FFPROBE`.

## Goed om te weten

- Posters en afbeeldingen zijn zonder inloggen op te vragen; al het andere vraagt een account, een gast-token of een tijdelijke afspeellink.
- Streams van een gekoppelde server lopen via je eigen server.
- HDR-naar-SDR-tonemapping bij transcoderen zit er nog niet in.
- Live tv in de browser werkt alleen bij providers die HLS aanbieden; in de apps speelt alles.
