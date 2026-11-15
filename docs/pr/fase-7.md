## Fase 7 — Kinoko Music-app: basis en Android Auto

Gestapeld op `feat/music-server`.

- **`packages/kinoko_core`**: de API-client/sessie, het thema en de basiswidgets zijn uit `app/` verhuisd naar een lokaal package dat beide apps gebruiken, plus een gedeeld inlogscherm (serveradres, naam/wachtwoord, 2FA-code). In `app/` staan op de oude plekken doorverwijzingen, zodat geen enkele import in de bestaande app hoefde te veranderen.
- **`music/`**: nieuwe Flutter-app (`nl.kinoko.music`).
  - **Afspelen**: `just_audio` + `audio_service`: achtergrond, mediamelding, vergrendelscherm, koptelefoon- en Bluetooth-knoppen. De hele wachtrij staat als één afspeellijst in de speler (basis voor gapless in fase 8). Echte luistertijd wordt geteld en gemeld; de wachtrij wordt op de server bewaard en bij de start hersteld. Verlopen links worden één keer vanzelf vernieuwd.
  - **Android Auto**: `MediaBrowserService` met de boom Home (recent + nieuwe albums), Playlists, Albums, Artiesten, Gelikete nummers, met hoezen; een nummer starten zet de rest van zijn album/playlist in de wachtrij. Spraak: "speel … af" zoekt en speelt een artiest, album of de best passende nummers. `automotive_app_desc.xml` en de manifest-regels staan erin.
  - **UI**: home, zoeken, bibliotheek (playlists/albums/artiesten/likes), album-, artiest- en playlistpagina, volledige speler, mini-speler, wachtrij (slepen, wegvegen, "speel hierna"), shuffle/herhalen, liken, playlist maken, hernoemen, delen en herordenen.
  - **Snelheid**: hoezen worden op schijf bewaard, lange lijsten laden per pagina, liken en bewerken van playlists is direct zichtbaar en wordt teruggedraaid als de server weigert.
- **Server**: `POST /api/music/play` geeft in één verzoek een link per nummer voor een hele wachtrij; een nummer van een gekoppelde server wordt bij het openen doorgestuurd.
- **CI**: `kinoko-music-vX.Y.Z.apk` wordt meegebouwd en met dezelfde keystore-secrets ondertekend. De release-stap draait alleen nog op `main`, zodat een handmatige run op een branch alleen bouwt. De servertests installeren nu ffmpeg.
- README: Kinoko Music en "Onbekende bronnen" voor Android Auto.

## Nieuwe dependencies (alleen in `music/`)
- `just_audio`: de speler (ExoPlayer), met afspeellijsten en gapless.
- `audio_service`: achtergrondafspelen, mediamelding, mediaknoppen en de Android Auto-koppeling. Zelf schrijven zou een eigen native service betekenen.

## Keuzes
- De bestaande app houdt zijn eigen onboarding; alleen de muziek-app gebruikt het nieuwe gedeelde inlogscherm. Zo verandert er niets aan wat al werkt.
- Het icoon van Kinoko Music is voorlopig hetzelfde als dat van Kinoko.
- Hoezen-cache is een eigen kleine implementatie in plaats van een extra pakket.

## Getest
- `flutter analyze` schoon en `flutter test` geslaagd voor `app/` (4) en `music/` (2).
- `npm test`: 55 van 55.
- **Niet op een toestel of in een auto.** Er is hier geen build gedraaid; of de APK bouwt blijkt in GitHub Actions.

## Zelf testen
1. Installeer `kinoko-music-…apk`, log in, speel een album af, vergrendel het scherm en gebruik de knoppen van je koptelefoon.
2. Android Auto: zet "Onbekende bronnen" aan (zie README) en blader in de auto; probeer "speel … af".
3. Controleer dat de gewone Kinoko-app na deze wijziging nog normaal werkt (de gedeelde code is verhuisd).
