## Fase 9 — widgets en Wrapped

Gestapeld op `feat/music-polish`.

- **Widgets (Android)**, zonder extra pakket:
  - *Kinoko Music*: huidig nummer, artiest, hoes, afspelen/pauzeren en volgende. De knoppen sturen dezelfde mediaknop-berichten als een koptelefoon naar de afspeeldienst.
  - *Kinoko*: de eerste titel uit "Verder kijken" met poster; tikken opent de app.
  - Native code: `NowPlayingWidget.kt` / `ContinueWidget.kt`, layouts en `appwidget-provider` in `res/`, een `MethodChannel` (`kinoko/widget`) in `MainActivity`. De Flutter-kant staat in `packages/kinoko_core/lib/home_widget.dart`.
- **Wrapped met muziek**: `musicWrapped` haakt in op het bestaande jaaroverzicht: minuten geluisterd, aantal nummers en artiesten, top-artiesten, top-nummers en top-genres. Web en app tonen het in hetzelfde overzicht als video; een jaar met alleen muziek is niet meer "leeg".

## Keuzes
- Geen `home_widget`-pakket: een klein eigen kanaal en twee kleine Kotlin-klassen geven minder onbekenden in de build dan een extra plugin.
- De widget van Kinoko opent de app; hij start niet zelf het afspelen.
- De widget-ontvanger staat ook in de tv-variant in het manifest; een tv toont geen widgets, dus dat heeft daar geen effect.

## Getest
- `npm test`: 62 van 62 (1 nieuw, voor Wrapped met muziek).
- `flutter analyze` schoon en `flutter test` geslaagd voor `app/` en `music/`.

## Niet getest
- **De Kotlin-code is niet gecompileerd.** Hier wordt niet gebouwd. Draai vóór het mergen de Actions-workflow op deze branch ("Run workflow"); die bouwt de APK's zonder release.
- De widgets zelf op een startscherm.

## Zelf testen
1. Houd het startscherm ingedrukt → Widgets → Kinoko Music; speel iets af en gebruik de knoppen.
2. Zet de widget van Kinoko neer, kijk een stuk van een film en open daarna home in de app; de widget toont de titel.
