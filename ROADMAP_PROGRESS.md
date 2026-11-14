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
