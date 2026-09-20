# SegmentScraper Desktop

Een zelfstandige Windows-desktopapp met eigen venster, bestands-/mapkiezers en meegeleverde ffprobe. De bestaande userscript blijft apart beschikbaar.

## Installeren en openen

Gebruik voor een normale Windows-installatie `dist/SegmentScraper-Desktop-1.9.5-x64-Setup.exe`. De installer maakt een Startmenu-entry, optioneel een bureaubladsnelkoppeling en een uninstall-entry in Windows. Daarna open je SegmentScraper gewoon vanuit het Startmenu.

De portable variant `dist/SegmentScraper-Desktop-1.9.5-x64-Portable.exe` blijft ook beschikbaar voor gebruik zonder installatie. Beide varianten bevatten ffprobe en hebben geen losse Node.js-, browser- of FFmpeg-installatie nodig. Je hoeft geen server te starten of URL te openen. Sluiten van het venster sluit ook de backend af.

## Nuvio → TorBox → SegmentScraper

1. Kies TorBox en voer de API-sleutel in van **hetzelfde TorBox-account dat je in Nuvio gebruikt**.
2. Klik op **Verbinden**. De app leest bestaande torrents, Usenet-downloads en webdownloads via de drie TorBox-bibliotheekendpoints. Je hoeft geen magnetlinks, NZB-bestanden of links uit Nuvio over te nemen. Dit voegt geen content toe aan TorBox.
3. Zoek op naam of filter op onderdeel. **Alleen direct beschikbaar** toont downloads die volgens TorBox afgerond én aanwezig zijn. Een losse `cached`-indicator is onvoldoende: verlopen/verwijderde bestanden worden niet als beschikbaar voorgesteld.
4. Open een film of seizoenspakket en selecteer video's. **Alles selecteren** verwerkt het volledige beschikbare seizoen. Niet-video's, TorBox ZIP-items en geïnfecteerde bestanden worden overgeslagen.
5. **Chapters lezen via provider** laat ffprobe rechtstreeks via een tijdelijke providerlink lezen. Dit bewaart geen video lokaal, maar gebruikt wel providerbandbreedte. De hoeveelheid verkeer hangt van bestand en server af; het is niet gegarandeerd slechts een klein metadata-request. Werkt dit niet, kies dan **Selectie downloaden & controleren**.
6. Downloads worden per bestand in een eigen map bewaard en daarna gecontroleerd. Standaard: de Windows Downloads-map onder `SegmentScraper`. **Downloadmap kiezen** past de bestemming voor nieuwe taken aan.
7. Bekijk chapters in de wachtrij en exporteer rapporten via het native Opslaan-venster.

De app toont wat TorBox via jouw accountbibliotheek beschikbaar stelt. Hij leest Nuvio's kijkgeschiedenis niet en doorzoekt niet de volledige gedeelde TorBox-cache. Ontbreekt iets, controleer het account, zet het beschikbaarheidsfilter uit en ververs. Een fout voor één TorBox-onderdeel laat de andere onderdelen zichtbaar, met een melding over het ontbrekende onderdeel.

Real-Debrid ondersteunt bestaande torrents, inclusief bestandsselectie indien vereist. Bibliotheekitems blijven bij de provider staan. Wissen van afgeronde taken verwijdert alleen lokale wachtrijrapporten.

## Lokale bestanden en accounts

**Bestanden kiezen** selecteert films/afleveringen; **Seizoensmap kiezen** neemt submappen mee. Absolute paden plakken kan ook. Ondersteund: MKV, MP4, M4V, AVI, MOV, WebM, TS en M2TS.

**Account versleuteld onthouden** bewaart de sleutel met Electron safeStorage (Windows DPAPI) in de gebruikersgegevensmap van SegmentScraper. Zonder deze optie blijft hij alleen in geheugen. Een onthouden TorBox-account wordt bij starten verbonden. Voor andere providers kies je de provider en **Opgeslagen account verbinden**. **Loskoppelen** verwijdert ook de onthouden sleutel. Ingeplande taken behouden hun verbinding tot afronden/annuleren. Sleutels en ondertekende downloadlinks worden niet in de interface, logs of rapporten teruggegeven.

Het venster gebruikt context isolation, renderer sandboxing en uitgeschakelde Node-integratie. Preload biedt alleen vaste native kies-/exportacties aan; IPC controleert het afzenderframe. De interne backend luistert alleen op 127.0.0.1 op een willekeurige vrije poort.

## Chaptercontrole en grenzen

- Originele chaptertijden blijven behouden; ongeldige grenzen, overlap/volgorde en grenzen buiten de speelduur worden gemeld.
- Intro, Opening, Recap, Credits en Post-credits zijn **suggesties ter beoordeling**, geen bewezen segmentgrenzen. Gewone hoofdstuknummers leveren geen verzonnen segmenten op.
- Zonder chapters volgt “Geen chapters aanwezig”. Nog geen automatische beeld-/audioherkenning, videoscrubber, IMDb/TVDB-mapping of IntroDB-upload.
- Kies Film of Serie bij **Type voor controle**. Automatisch herkent S01E01 en 1x01; andere namen blijven onbekend. Nummering is niet geverifieerd bij TVDB. Dubbelafleveringen vereisen beoordeling.
- Wachtrij/rapporten staan in geheugen: exporteer vóór afsluiten. Sluiten tijdens actieve taken geeft een waarschuwing. Voltooide downloads blijven bewaard, ook bij fouten in chaptercontrole.
- Downloads lopen één voor één. Bij normale fouten/annulering worden tijdelijke `.part`-bestanden verwijderd. Geen automatische hervatting/retries. Na geforceerd afsluiten kunnen `.part`-bestanden achterblijven. Voeg volledig gedownloade video's opnieuw lokaal toe om een controle te herhalen.
- Maximaal 5000 actieve bestanden. Probe-timeout: 2 minuten; download-timeout: 6 uur. Lezen/downloaden gebruikt providerquota.
- De EXE is een lokale, niet code-ondertekende ontwikkelbuild. Geen automatische updater.

## Bouwen en testen

Gebruik Node.js 22+ en npm:

```powershell
npm ci
npm run setup:media
npm run app
npm run dist:win
node --test
```

`start-app.cmd` start de ontwikkelversie na installatie van dependencies. De Windows-build verschijnt in `dist`. `setup:media` downloadt FFmpeg 9.0.1 essentials van Gyan, controleert de vastgelegde SHA-256 en pakt de tools lokaal uit. Alleen ffprobe plus licentie en README worden meegebouwd; ffmpeg zelf dient voor testvideo's. Ontwikkelaars kunnen `FFPROBE_PATH` instellen voor een eigen binary.

`npm run dist:win` maakt zowel de installeerbare Setup-EXE als de portable EXE. Gebruik `npm run dist:win:setup` of `npm run dist:win:portable` om slechts één variant te bouwen.

Optionele browserontwikkeling: `node app/server.mjs`. Native kiezers/accountopslag zijn alleen beschikbaar in de desktopapp. Stel daarbij `FFPROBE_PATH` en eventueel `DOWNLOAD_DIR` in; deze ontwikkelserver downloadt standaard naar `app-data/downloads`.

Tests dekken de drie bibliotheken, gescheiden IDs, gereedheid, directe links zonder toevoegen van content, fouten, chaptergrenzen, lokale/directe controles, wachtrij/annulering en accountopslag. Na `setup:media` draait ook de test met een echte gegenereerde MKV met chapters. Providerantwoorden worden gesimuleerd; een volledige live-test vereist een eigen account en beschikbare bestanden.

`desktop/main.cjs` beheert venster/native dialogen; `desktop/vault.cjs` versleutelde opslag; `media.mjs` chaptercontrole; `providers.mjs` providerbibliotheken; `server.mjs` wachtrij/backend; `public/` de interface.

Bronnen: [TorBox torrents](https://www.postman.com/torbox/torbox-api/documentation/b6l9hbv/main-api), [TorBox Usenet](https://github.com/TorBox-App/torbox-sdk-py/blob/main/documentation/services/UsenetService.md), [TorBox webdownloads](https://github.com/TorBox-App/torbox-sdk-py/blob/main/documentation/services/WebDownloadsDebridService.md), [Real-Debrid](https://api.real-debrid.com/), [ffprobe](https://ffmpeg.org/ffprobe.html), [FFmpeg Windows-build en broncode](https://www.gyan.dev/ffmpeg/builds/), [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
