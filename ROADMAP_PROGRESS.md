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
