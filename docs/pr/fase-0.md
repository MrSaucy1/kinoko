## Wat dit oplost

**1. Root via de update-knop** (`install/kinoko-helper`, `install/install.sh`)

Wie code kon draaien als `kinoko`, kon `install/kinoko-helper` in de werkmap aanpassen, in het beheer op "bijwerken" drukken en zo root worden.

- De helper weigert bij te werken als de werkmap afwijkt: gewijzigde of onbekende bestanden, geen upstream-branch, of commits die niet op de upstream-branch staan.
- Alle git- en npm-opdrachten in `/opt/kinoko` draaien als `kinoko`. De oude code draaide `git log` als root in een map van `kinoko`; de git-config van die map kan programma's laten starten.
- De nieuwe helper komt niet meer uit de werkmap. Root haalt dezelfde commit opnieuw op vanaf het adres in `/etc/kinoko/repo` (root, 600), in een map die alleen root kan schrijven, en installeert daaruit `git show <commit>:install/kinoko-helper` met `install -o root -g root -m 755`.
- `install.sh` installeert de helper root-owned vanaf een bron die `kinoko` niet kan schrijven en schrijft `/etc/kinoko/repo`.
- `KINOKO_DIR` uit de omgeving en het vaste bestand `/tmp/kinoko-update.err` zijn weg.
- `/etc/sudoers.d/kinoko` stond al alleen `/usr/local/bin/kinoko-helper` toe; dat is ongewijzigd. `kinoko-lxc.sh` installeert via `install.sh` en is ongewijzigd.

**Afwijking van de opdracht:** gevraagd was `git show HEAD:install/kinoko-helper` in de werkmap. Dat sluit het gat niet, want ook `.git` is van `kinoko`: die kan lokaal committen, `origin/main` verzetten of `origin` naar een eigen repository laten wijzen, waarna de werkmap schoon is en HEAD "op upstream" staat. Daarom haalt root het bestand zelf op bij de echte repository.

**2. Sessies verlopen en zijn in te trekken** (`server/src/auth.js`, `index.js`)

- Een sessie die langer dan `session_idle_days` (standaard 90) niet is gebruikt, wordt geweigerd en verwijderd; elke 6 uur en bij het starten wordt opgeruimd.
- `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `POST /api/auth/sessions/revoke-others`. Het id is de eerste 12 tekens van de sha256 van het token; het token zelf komt nooit terug.
- Wachtwoord wijzigen logt de andere sessies uit (was al zo, nu met test). `foreign_keys` staat aan, dus een verwijderde gebruiker verliest zijn sessies (test toegevoegd).
- Web: "Apparaten" in het accountmenu. App: "Apparaten" in het profielscherm. Beheer → Overzicht: veld voor het aantal dagen.

**3. `which()` zonder shell** (`server/src/remote.js`): zoekt zelf in PATH.

**4. Migratiesysteem** (`server/src/db.js`): genummerde stappen met `PRAGMA user_version`; het bestaande schema is versie 0. Een stap draait één keer in een transactie en voegt alleen toe.

## Getest

- `npm test`: 19 van 19 geslaagd (7 nieuw).
- `flutter analyze`: geen meldingen; `flutter test`: 4 van 4.
- `bash -n` op de helper en `install.sh`; shellcheck was niet beschikbaar.
- De update-opdracht van de helper in een zandbak met nagemaakte `sudo`/`npm`: actueel, achterlopend, gewijzigd bestand, onbekend bestand, lokale commit, vervalste `origin/main` en `origin` omgeleid naar een eigen repository. In het laatste geval wordt de helper niet vervangen.
- De web-dialoog en het beheerveld in headless Chromium.

## Niet getest

- De helper en `install.sh` op een echte installatie als root.
- Het scherm "Apparaten" in de app op een toestel.

## Na het mergen op een bestaande installatie

1. Druk één keer op "Kinoko bijwerken". Die run gebruikt nog de oude helper en zet de nieuwe neer.
2. Controleer in de container: `ls -l /usr/local/bin/kinoko-helper` moet `root root` en `-rwxr-xr-x` tonen.
3. Draait de server van een eigen fork, voer dan `install.sh` opnieuw uit als root, zodat `/etc/kinoko/repo` naar die fork wijst. Zonder dat bestand gebruikt de helper de standaardrepository.
4. Sessies die al langer dan 90 dagen stil liggen, zijn na de update uitgelogd.
