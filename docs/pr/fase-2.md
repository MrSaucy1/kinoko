## Fase 2 — beveiliging en rechten

Gestapeld op `feat/quick-wins`.

- **2FA (TOTP)** (`totp.js`, routes in `auth.js`): eigen implementatie van RFC 6238, geen nieuwe dependency. Instellen met QR-code (bestaande `qrcode-generator`) of sleutel, tien herstelcodes (alleen de hashes worden bewaard), een code werkt één keer. Inloggen zonder code geeft `{ totpRequired: true }` zonder token. De inlog-throttle telt ook verkeerde codes. Instelling "verplicht voor beheerders"; een beheerder kan iemands 2FA resetten.
- **Audit-log** (`audit.js`): tabel `audit_log`, pagina Logboek met zoeken en filter, bewaartermijn instelbaar (standaard 90 dagen).
- **fail2ban/CrowdSec**: één vaste regel per mislukte poging, filter en jail in `install/fail2ban/`, uitleg in de README.
- **Rechten per bibliotheek** (`access.js`): `users.all_libraries`, `users.allow_peers` en tabel `library_access`. Afgedwongen in home, browse/zoeken, titeldetails, collecties, Mijn lijst, serievoorkeuren, play, extra's, ondertitel-offset, voortgang, ondertitels zoeken/downloaden, Watch Night en samen kijken. Iets wat verborgen is antwoordt als iets wat niet bestaat (404).
- **`trustProxy`**: doorgegeven adressen (X-Forwarded-For) worden alleen nog geloofd van een proxy op deze machine of het lokale netwerk. Anders kon iedereen zelf het adres kiezen dat in de throttle en in de fail2ban-regel terechtkomt.
- Migratie 2.

## Keuzes
- De federatie-catalogus werkt met de sleutel van een gekoppelde server, niet met een gebruiker; daar blijft de instelling "delen" per bibliotheek gelden. Wat een gebruiker van gekoppelde servers ziet is één schakelaar per gebruiker.
- Posters en afbeeldingen blijven zonder inloggen opvraagbaar (bestaand ontwerp, staat in de README). Wie een titel-id raadt kan dus een poster zien, maar geen titel, beschrijving of bestand.
- Beheerders zijn nooit beperkt.
- De TOTP-sleutel staat leesbaar in de database (dat kan niet anders); hij komt alleen bij het instellen één keer terug naar de eigenaar.

## Getest
- `npm test`: 35 van 35 (7 nieuw). De rechtentest probeert met een beperkt account 9 lijsten en 16 directe routes op een verborgen bibliotheek.
- TOTP tegen de testvectoren van RFC 6238.
- `flutter analyze` schoon, `flutter test` 4 van 4.
- Logboek, toegangsdialoog en 2FA-instellen in een headless browser.

## Zelf testen
1. Zet 2FA aan in het accountmenu, log uit en weer in (web en app). Bewaar de herstelcodes.
2. Beperk een testgebruiker tot één bibliotheek en kijk als die gebruiker rond.
3. Kijk in Beheer → Logboek na een mislukte inlogpoging.
4. Met fail2ban: `fail2ban-regex systemd-journal /etc/fail2ban/filter.d/kinoko.conf` na een mislukte poging.
5. **Let op bij een reverse proxy buiten je netwerk:** zet dan `KINOKO_TRUST_PROXY`, anders ziet Kinoko het adres van de proxy als bezoeker.
