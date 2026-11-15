# Roadmap — voortgang

Dit bestand is het logboek van de roadmap. Wie verder werkt (ook na een
onderbroken sessie) leest dit eerst en gaat verder bij de eerste fase die niet
"klaar" is.

## Algemene keuzes

- **Branchnamen:** de opdracht noemt zowel `fase-N-<naam>` als per fase een
  eigen naam (`fix/security-hardening`, `feat/quick-wins`, …). De namen per fase
  zijn gebruikt; elke branch is gestapeld op die van de vorige fase.
- **PR's:** het token van deze werkomgeving mag geen pull requests aanmaken
  (`Resource not accessible by personal access token (createPullRequest)`).
  Per fase staat daarom de vergelijk-link waarmee de PR met één klik te openen
  is, en de PR-tekst staat in `docs/pr/fase-N.md`. Kan het later wel, dan komt
  hier de echte PR-link.
- **Builds:** APK's worden alleen door GitHub Actions gebouwd, en die workflow
  draait bij een push naar `main`. De apps zijn in deze fases dus gecontroleerd
  met `flutter analyze` en `flutter test`, niet op een toestel.

## Fase 0 — Security-fixes

- Status: **klaar**
- Branch: `fix/security-hardening` (vanaf `main`)
- PR: https://github.com/MrSaucy1/kinoko/compare/main...fix/security-hardening?expand=1 — tekst in `docs/pr/fase-0.md`

Gedaan:
- Update-knop kan niet meer naar root escaleren (helper + `install.sh`).
- Sessies verlopen (`session_idle_days`, standaard 90), zijn te bekijken en in te trekken; "Apparaten" in web en app.
- `which()` zonder shell.
- Migratiesysteem met `PRAGMA user_version` (`MIGRATIONS` in `server/src/db.js`).

Keuzes:
- **Helper niet uit de werkmap.** Gevraagd was `git show HEAD:install/kinoko-helper`
  in `/opt/kinoko`. Die map, inclusief `.git`, is van `kinoko`; een aanvaller kan
  daar lokaal committen of `origin` omleiden. Root haalt daarom dezelfde commit
  zelf op bij het adres in `/etc/kinoko/repo` (alleen root schrijfbaar) en
  installeert de helper daaruit. Lukt dat niet, dan blijft de oude helper staan.
- **Sessie-id** = eerste 12 tekens van sha256(token).
- **Migraties:** het bestaande `CREATE TABLE IF NOT EXISTS`-schema is de basis
  (versie 0); elke latere wijziging is een genummerde stap die alleen toevoegt.

Open / niet getest:
- Helper en `install.sh` zijn niet als root op een echte installatie gedraaid (wel in een zandbak met zeven scenario's).
- Het scherm "Apparaten" is niet op een toestel bekeken.
- shellcheck is hier niet beschikbaar.

## Fase 1 — Snelle verbeteringen

- Status: **klaar**
- Branch: `feat/quick-wins` (vanaf `fix/security-hardening`)
- PR: https://github.com/MrSaucy1/kinoko/compare/fix/security-hardening...feat/quick-wins?expand=1 — tekst in `docs/pr/fase-1.md`

Gedaan: bestandswatcher, back-ups, voorkeuren per serie, ondertitel-offset, verder kijken op ander apparaat, extra's, limiet per gebruiker, webhooks. Migratie 1.

Keuzes:
- `npm test` draait nu alle bestanden in `server/test/`; `helpers.js` blokkeert internet in tests.
- Extra met achtervoegsel telt alleen als het hoofdbestand ernaast staat.
- Gasten in een kijkkamer vallen onder de limiet van de host.
- Webhook-adressen worden gemaskeerd teruggegeven (het adres is bij Discord een geheim).
- Het meldingskanaal `/api/events/ws` is algemeen opgezet; fase 5 (stream stoppen) en fase 8 (Connect) gebruiken het ook.

Open / niet getest:
- App: timing, serievoorkeuren, extra's en het aanbod "Verder kijken" zijn alleen met `flutter analyze` gecontroleerd, niet op een toestel.
- Audiotaal bij direct afspelen in de browser kan niet zonder omzetten; de browser schakelt dan naar de hoogste omgezette kwaliteit (bestaand gedrag).

## Fase 2 — Beveiliging & rechten

- Status: **klaar**
- Branch: `feat/security-features` (vanaf `feat/quick-wins`)
- PR: https://github.com/MrSaucy1/kinoko/compare/feat/quick-wins...feat/security-features?expand=1 — tekst in `docs/pr/fase-2.md`

Gedaan: 2FA (TOTP + herstelcodes, verplicht te stellen voor beheerders), audit-log, fail2ban-regel + filter, rechten per bibliotheek. Migratie 2.

Keuzes:
- TOTP zelf geïmplementeerd (60 regels), geen dependency.
- `trustProxy` beperkt tot loopback en privé-adressen; te overschrijven met `KINOKO_TRUST_PROXY`. Dit verandert bestaand gedrag voor wie een proxy buiten het eigen netwerk gebruikt.
- Rechten: `access.js` is de ene plek; fase 3 (kindermodus) en fase 6 (muziek) breiden daar de scope uit.
- Federatie-catalogus valt niet onder gebruikersrechten (server-naar-server).
- Posters blijven zonder inloggen opvraagbaar (bestaand ontwerp).

Open / niet getest:
- De regel "zet eerst je eigen 2FA aan voordat je het verplicht" zit in `index.js` en heeft geen eigen test.
- 2FA in de app (inloggen met code, instellen in het profiel) is niet op een toestel geprobeerd. De app toont de sleutel als tekst, geen QR-code.
- fail2ban zelf is hier niet geïnstalleerd; het filter is alleen tegen de regel-opmaak getest.

## Fase 3 — Kindermodus & beeld

- Status: **klaar**
- Branch: `feat/viewing` (vanaf `feat/security-features`)
- PR: https://github.com/MrSaucy1/kinoko/compare/feat/security-features...feat/viewing?expand=1 — tekst in `docs/pr/fase-3.md`

Gedaan: leeftijdsclassificatie, kindermodus, trickplay, HDR→SDR-tonemapping. Migratie 3.

Keuzes:
- Trickplay standaard uit per bibliotheek.
- Leeftijd tussen twee Kijkwijzer-stappen → de strengere stap.
- Live tv uit voor accounts met leeftijdsgrens.
- `tonemap_opencl`/`libplacebo` niet gebruikt (niet te testen zonder GPU).

Open / niet getest:
- `tonemap_vaapi` en de hardware-encodepaden met tonemapping: alleen de keuze van de keten is getest, niet op een GPU.
- Trickplay-weergave in de app (mobiel en tv) niet op een toestel.
- De eenvoudige kinder-home heeft in web en app geen eigen vormgeving; Watch Night-knop blijft zichtbaar (resultaten zijn wel gefilterd).
- Cinemeta levert geen classificatie; zonder TMDB-sleutel komt alles van Wikidata of `.nfo`, series hebben daar zelden een waarde.

## Fase 4 — Sociaal

- Status: **klaar**
- Branch: `feat/social` (vanaf `feat/viewing`)
- PR: https://github.com/MrSaucy1/kinoko/compare/feat/viewing...feat/social?expand=1 — tekst in `docs/pr/fase-4.md`

Gedaan: chat-limiet en chatgeschiedenis in de kamer, Watch Night-stemmen, gedeelde lijsten, Wrapped (video). Migratie 4.

Keuzes:
- Chatberichten alleen in het geheugen (laatste 50 per kamer).
- Stemmen: meerderheid van de aanwezigen of 90 s; loting bij gelijkspel.
- Wrapped telt alleen kijktijd die bij de klok past; oude voortgang is eenmalig overgenomen.
- Gebruikersnamen zijn voor alle ingelogde gebruikers zichtbaar (nodig om lijsten te delen).

Open / niet getest:
- App-schermen (stemmen, lijsten, Jouw jaar) niet op een toestel.
- Web: een lijst maken of hernoemen gebruikt het standaard `prompt`-venster van de browser.

## Fase 5 — Beheer & automatisering

- Status: **klaar**
- Branch: `feat/admin` (vanaf `feat/social`)
- PR: https://github.com/MrSaucy1/kinoko/compare/feat/social...feat/admin?expand=1 — tekst in `docs/pr/fase-5.md`

Gedaan: activiteit-dashboard met stream stoppen, Sonarr/Radarr-webhook met gerichte scan, verzoeken met optioneel doorsturen. Migratie 5.

Keuzes:
- `which()` is verhuisd naar `ffmpeg.js` (en wordt door `remote.js` doorgegeven) om een import-kring te voorkomen.
- Streams van gekoppelde servers: alleen melding, geen harde stop.
- Webhook-token in het adres; API-sleutels gemaskeerd.

Open / niet getest:
- Doorsturen is getest tegen een nagemaakte Radarr, niet tegen een echte Radarr of Sonarr.
- GPU-belasting: Intel wordt niet uitgelezen.
- Stopmelding en verzoeken in de app niet op een toestel.

## Fase 6 — Muziek: server

- Status: **klaar**
- Branch: `feat/music-server` (vanaf `feat/admin`)
- PR: https://github.com/MrSaucy1/kinoko/compare/feat/admin...feat/music-server?expand=1 — tekst in `docs/pr/fase-6.md`

Gedaan: bibliotheektype muziek, scanner, schema, optionele online metadata, streamen (origineel + Opus/AAC), API, rechten, federatie, webweergave. Migratie 6.

Keuzes:
- Migratie 6 herbouwt `libraries` (CHECK-constraint); `migrate()` kent daarvoor stappen met `fkOff`.
- Omgezette nummers in een cache (`KINOKO_DATA/music`, standaard 2 GB) in plaats van live transcoderen.
- Kindermodus bij muziek: alles behalve nummers met de tag "explicit".
- Uitbreidpunten voor latere fases: `addHomeRows` (mixes), `onPlay` (scrobbelen), `onMusicScanned`, `embeddedLyrics`.

Open / niet getest:
- Echte verzoeken naar MusicBrainz/Cover Art Archive/Wikidata zijn niet gedaan (alleen nagemaakte antwoorden).
- Federatie van muziek: import en export zijn getest, het afspelen via een tweede echte server niet.
- Web: playlist maken/hernoemen gebruikt het `prompt`-venster van de browser.

## Fase 7 — Kinoko Music-app: basis + Android Auto

- Status: **klaar** (code); niet op een toestel getest
- Branch: `feat/music-app` (vanaf `feat/music-server`)
- PR: https://github.com/MrSaucy1/kinoko/compare/feat/music-server...feat/music-app?expand=1 — tekst in `docs/pr/fase-7.md`

Gedaan: `packages/kinoko_core`, de app in `music/` (afspelen, Android Auto, UI), batch-afspeellinks op de server, CI bouwt de muziek-APK.

Keuzes:
- `app/lib/core/api.dart`, `theme.dart` en `widgets/common.dart` zijn doorverwijzingen naar het package.
- De bestaande app houdt zijn onboarding; de muziek-app gebruikt `SignInScreen` uit het package.
- Uitbreidpunten in de app voor fase 8: `playerExtras`, `collectionExtras`, `settingsExtras`.
- CI: release alleen op `main`; `workflow_dispatch` op een branch bouwt alleen.

Open / niet getest:
- Geen toestel, geen auto: achtergrondafspelen, melding, Android Auto en spraak zijn alleen op code-niveau gecontroleerd.
- Eigen icoon voor Kinoko Music ontbreekt.
- **De build zelf is niet geverifieerd.** Het token van deze werkomgeving mag geen workflow starten (`HTTP 403` op `workflow_dispatch`). Start in GitHub → Actions → Build → "Run workflow" op de branch `feat/music-app` (of een latere fase): die run bouwt alle drie de APK's zonder een release te maken.

## Fase 8 — Spotify-gevoel

- Status: **klaar** (code); geluid en downloads niet op een toestel getest
- Branch: `feat/music-polish` (vanaf `feat/music-app`)
- PR: https://github.com/MrSaucy1/kinoko/compare/feat/music-app...feat/music-polish?expand=1 — tekst in `docs/pr/fase-8.md`

Gedaan: gapless + crossfade, ReplayGain (met meting op de server), offline downloads, kwaliteit per netwerk, songteksten, radio/doorspelen, home-mixes, scrobbelen, Kinoko Connect. Migratie 7.

Keuzes:
- Crossfade met een tweede speler; standaard uit.
- `services/events.dart` is naar `packages/kinoko_core` verhuisd (beide apps gebruiken het meldingskanaal).
- Vergelijkbare artiesten alleen via Last.fm; ListenBrainz alleen voor scrobbelen.
- Nieuwe dependency `connectivity_plus` in `music/`.

Open / niet getest:
- **Crossfade is niet op een toestel beluisterd.** De overname tussen de twee spelers kan een tikje geven; dat is alleen met oren te beoordelen.
- Downloads, offline gebruik, songteksten-scherm en Connect in de app: alleen `flutter analyze`.
- Web: geen songteksten-scherm en geen apparatenlijst in de browser (de browser is wel een Connect-doel).
- Echte verzoeken naar LRCLIB/ListenBrainz/Last.fm zijn niet gedaan.

## Fase 9 — Widgets & Wrapped

- Status: **klaar** (code); Kotlin niet gecompileerd, widgets niet op een toestel getest
- Branch: `feat/widgets` (vanaf `feat/music-polish`)
- PR: https://github.com/MrSaucy1/kinoko/compare/feat/music-polish...feat/widgets?expand=1 — tekst in `docs/pr/fase-9.md`

Gedaan: widgets voor Kinoko Music (nu aan het spelen) en Kinoko (verder kijken), Wrapped met muziek.

Keuzes:
- Geen extra pakket voor widgets; eigen `MethodChannel` + Kotlin-providers.
- Wrapped-muziek haakt in via `addWrappedSection`.

Open / niet getest:
- **De Kotlin-code van de widgets is niet gecompileerd.** Een fout daarin breekt de APK-build; draai de Actions-workflow op deze branch vóór het mergen.
- Widget-knoppen als de app helemaal gestopt is: onbekend of de afspeeldienst dan vanzelf start.

## Fase 10 — Grotere projecten

Elk onderdeel een eigen branch, gestapeld. Volgorde: DVR → yt-dlp → casten → Android TV-startscherm → desktop-apps
(eerst wat op de server te bouwen en te testen is, daarna wat een toestel of een andere bouwomgeving nodig heeft).

### 10a — Live tv opnemen (DVR)

- Status: **klaar**
- Branch: `feat/dvr` (vanaf `feat/widgets`)
- PR: https://github.com/MrSaucy1/kinoko/compare/feat/widgets...feat/dvr?expand=1 — tekst in `docs/pr/fase-10a-dvr.md`
- Open: niet getest met een echte provider; lopende opname wordt na een herstart niet hervat; alleen in de web-GUI (de app gebruikt het beheer via de webweergave).

Plan:
- Tabellen `recordings` en `record_rules` (migratie 8).
- Opnemen met ffmpeg (`-c copy`, vaste duur) vanaf de zender-URL; een planner start en stopt opnames; na afloop wordt de map gescand.
- Opnames komen in een eigen bibliotheek "Opnames" (map `KINOKO_DATA/recordings`, aan te passen).
- Serie-opname: een regel per zender + titel; de gids wordt periodiek bekeken en passende uitzendingen worden ingepland.
- Opslaglimiet (GB) en bewaartermijn; de oudste opnames gaan eerst weg.
- Plannen en beheren is voor beheerders (opnemen gebruikt de provider-verbinding en schijfruimte).
