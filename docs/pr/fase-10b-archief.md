## Fase 10b — archiveren met yt-dlp

Gestapeld op `feat/dvr`.

- **Root-helper**: nieuwe opdrachten `ytdlp-install` en `ytdlp-update`. Ze nemen geen argumenten aan: het adres ligt vast, de download wordt gecontroleerd tegen de controlesomlijst van de release en root-owned geïnstalleerd in `/usr/local/bin/yt-dlp`.
- **Server** (`archive.js`, migratie 9): bronnen (naam, adres, video of alleen geluid, nieuwste N per keer). yt-dlp draait als de gewone `kinoko`-gebruiker met een vaste lijst opties; het adres komt als laatste, na `--`. Alleen een gewoon `https://`-adres wordt geaccepteerd.
- **Bibliotheken**: video in "Archief" (films), geluid in "Archief (audio)" (muziek). Voor video schrijft Kinoko een `movie.nfo` en `poster.jpg` uit de gegevens van yt-dlp, gemarkeerd zodat er geen filmdatabase wordt geraadpleegd voor een YouTube-video.
- **Periodiek**: standaard elke 12 uur, plus "Nu ophalen". Een bron verwijderen laat staan wat al is opgehaald.
- **Beheer → Archief**: yt-dlp installeren/bijwerken, bronnen, voortgang, interval.

## Keuzes
- Hooguit 1080p, samengevoegd tot `.mkv`; geluid in het beste beschikbare formaat met ingebedde tags.
- `--ignore-config` en `--no-exec`: geen configuratiebestand en geen opdrachten na het downloaden.
- Bij een fout in één item telt een ronde die wel iets ophaalde als geslaagd.

## Getest
- `npm test`: 66 van 66 (1 nieuw): adrescontrole (opties, `file:`, `http:`, inloggegevens, regeleinden), de opties, en een ronde met een nagemaakte yt-dlp die laat zien dat het adres na `--` aankomt en dat nfo en poster ontstaan.
- `bash -n` op de helper.

## Niet getest
- De echte yt-dlp en een echte download.
- De helper-opdrachten als root (controlesom-stap) op een echte installatie.

## Na het mergen
- De helper wordt bij "Kinoko bijwerken" vanzelf vernieuwd; daarna werkt de installatieknop voor yt-dlp.
