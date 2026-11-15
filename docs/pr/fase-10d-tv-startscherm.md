## Fase 10d — Android TV-startscherm

Gestapeld op `feat/cast`.

- **Rijen op het startscherm van de tv**: "Verder kijken" en "Nieuw op Kinoko", gevuld telkens als de home van de tv-app laadt. Een kaart opent de titel in de app (`kinoko://title/<id>`).
- Alleen in de **tv-variant**: de code staat in `app/android/app/src/tv/kotlin/…/TvHome.kt` met `androidx.tvprovider` als `tvImplementation`; de telefoonvariant krijgt een lege versie (`src/mobile/kotlin`), zodat de telefoon-APK er niets van meekrijgt.
- De app begrijpt nu ook `kinoko://title/<id>`.

## Nieuwe dependency
- `androidx.tvprovider:tvprovider:1.0.0` (alleen tv-variant): de officiële bibliotheek om kanalen en programma's op het tv-startscherm te zetten.

## Niet gedaan
- **Zoekintegratie** op het tv-startscherm. Dat vraagt een eigen ContentProvider die zoekvragen van het systeem beantwoordt zonder dat de app draait, met de inloggegevens van de gebruiker. Dat is niet te testen zonder tv en staat als open in het logboek.

## Niet getest
- **Niet gecompileerd en niet op een tv bekeken.** Een fout in deze Kotlin-code breekt de build van de tv-APK (en, door de gedeelde `MainActivity`, mogelijk ook die van de telefoon). Draai de Actions-workflow op deze branch voordat je mergt.
- Android TV toont één rij zonder vragen; de tweede zet de gebruiker zelf aan onder "Kanalen aanpassen".
- Of het startscherm posters via `http://` laadt, verschilt per tv; met een `https`-adres voor de server is dat geen punt.
