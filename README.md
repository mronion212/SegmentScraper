# SegmentScraper

SegmentScraper extracts intro, recap, and outro timestamps from supported streaming services. It includes automatic IMDb lookup, JSON export, and IntroDB submission with duplicate filtering.

## Desktop media app

This branch includes a Windows desktop app with its own window, native file/folder pickers and bundled ffprobe. Connect the same TorBox account used in Nuvio to browse existing torrents, Usenet and webdownloads, inspect chapters directly from the provider or download whole season packs for local inspection. No magnet links are needed. Real-Debrid and already downloaded local files are also supported. Install it with the Setup EXE in `dist`, or use the portable EXE, or develop with `npm ci`, `npm run setup:media` and `npm run app`. See [the desktop guide](app/README.md) for build instructions and limitations.

Desktop 1.10.0 adds an English review/upload workflow, IMDb identity lookup, shared TVDB/TMDB checks, duplicate filtering, visible validation progress, an audited admin override, and required desktop-update dialogs. Users must personally review all output against the video. The app follows the official IntroDB API at `api.introdb.app`.

Desktop 1.11.0 adds automatic movie-ending analysis using FFmpeg, credit-text heuristics, a 12× overview and short boundary previews. It can submit a reviewed scene-safe outro and one mid-/post-credits scene. The online userscript captures Netflix movie outros, while movie credit capture for the other streaming providers is temporarily disabled until their markers are verified against playback. Multiple real scenes are preserved in local reports because IntroDB does not currently model them separately. Applicable future changes must be carried to both clients; shared code and CI checks enforce generated-code parity (see `AGENTS.md`).

Userscript 1.12.6 contains the provider fixes, Netflix movie boundary correction, movie scene checks, completed-export cleanup, temporary non-Netflix movie-capture gate, and the side-by-side IntroDB review with direct upload approval. The generated userscript uses `@version 1.12.6`.

Desktop Alpha 0.1 is an experimental test release based on the published 1.12.6 desktop build. Its review workflow, movie-ending analysis, uploads and local workspace are still under development; always review suggested boundaries before uploading.

Desktop 1.12.1 reduces image processing before scaling, creates boundary clips on demand, and offers an optional last-15-minute scan with explicit coverage warnings. The default remains the last quarter. Provider 4K streams still require downloading and decoding the selected source window; scan speed and approximate time remaining are displayed.

Desktop 1.12.0 adds saved workspaces and upload history, resumable inspection tasks, a single-player review timeline with boundary editing, WebM previews, and a shared decode pass for analysis and overview. Local analysis reuse verifies the source file; uploads always need fresh checks after restart.

## Supported Services

- Netflix
- Prime Video
- Videoland
- SkyShowtime

Disney+ and HBO Max are present in the provider configuration but do not yet have extraction modules.
Online movie extraction is currently enabled only for Netflix. Prime Video, Videoland and SkyShowtime retain their series extraction, while their movie credits are temporarily disabled. The desktop app keeps its separate, manually reviewed movie workflow.
SkyShowtime captures catalogue metadata automatically from page or worker network requests and maps SOI/EOI, SOR/EOR, and SOCR/runtime to intro, recap, and outro segments. Movie credits use an explicit credit end marker when available and otherwise the known media runtime. SkyShowtime can return multiple provider variants for one title (for example a short preview and the full feature); movie extraction follows the `provider_variant_id` from the active request so those variants are not mixed. Captured timestamps remain available until `Clear Data` is used, a confirmed JSON download completes, or every IntroDB submission succeeds; failed submissions keep the capture for retry. Opening multiple titles in one tab therefore intentionally keeps them together until an export or successful submission. When loading a series, wait until the UI icon has finished loading (that is, until the banner starts playing).

Crunchyroll is temporarily disabled because extraction is unreliable.

Every active provider logs each captured episode with readable timestamps and the exact raw start/end seconds. Netflix, Prime Video, Videoland, and SkyShowtime movies bypass TheTVDB and use their IMDb ID with movie metadata in JSON exports and IntroDB submissions.

## Features

- Provider-specific playback-control anchors with automatic insertion when controls appear or rerender
- Fullscreen-aware panels, keyboard focus restoration, Escape to close, and collapsible API settings
- TVDB, IntroDB and TMDB credentials grouped inside API settings
- Manual **Start here** / **End here** player marks with Intro/Recap/Outro selection, short boundary previews and explicit review before saving
- Segment-type filters for timestamp comparison, JSON export and upload approval, including desktop comparison
- Tab-scoped capture recovery after reload, including episode mapping metadata; API credentials are excluded
- Bounded duplicate-check batches and request timeouts; failed duplicate checks stop export/submission and can be retried

- Captures and normalizes provider-specific segment metadata
- Automatically looks up IMDb series IDs
- Exports captured timestamps as JSON
- Previews JSON before download
- Submits timestamps to IntroDB
- Shows current IntroDB ranges next to the Scraper ranges before export or submission; exact duplicates are removed from the output
- Requires an explicit manual comparison approval before any IntroDB upload, so provider offsets such as Netflix timing differences cannot be accepted silently
- Maps regular provider episodes to canonical TheTVDB season/episode numbers before JSON export or submission; movies bypass TheTVDB
- Excludes provider specials and TheTVDB Season 0 from count checks and normal submission mapping
- Uses one shared provider panel based on the Netflix layout
- Checks GitHub for a newer release and blocks normal use until a confirmed update is installed
- Lets compatible userscript managers update automatically through `@updateURL` and `@downloadURL`

The panel layout, dimensions, typography, controls, counters, backgrounds, borders, and spacing are identical for every provider. A provider may only customize:

- Button colors
- Provider name and provider-name color
- Text above the JSON export
- Info-box text and accent color

## Project Structure

```text
SegmentScraper/
|-- src/
|   |-- core/
|   |   |-- state.js             # Shared state and cache management
|   |   |-- network.js           # IMDb and IntroDB requests
|   |   `-- tvdb.js              # TVDB authentication and canonical episode mapping
|   |-- ui/
|   |   |-- panel.js             # Shared Netflix-based provider panel
|   |   `-- button.js            # Shared player trigger button
|   |-- config/
|   |   `-- provider-config.js    # Shared styling and allowed provider overrides
|   |-- normalization/
|   |   `-- segment-mapper.js     # Provider segment normalization
|   `-- providers/
|       |-- bootstrap.js          # Shared provider initialization and actions
|       |-- timestamp-logger.js   # Shared per-episode timestamp logging
|       |-- netflix/
|       |   |-- index.js
|       |   `-- extractor.js
|       |-- prime-video/
|       |   |-- index.js
|       |   `-- extractor.js
|       |-- videoland/
|       |   |-- index.js
|       |   `-- extractor.js
|       |-- skyshowtime/
|       |   |-- index.js
|       |   `-- extractor.js
|       `-- crunchyroll/
|           |-- index.js
|           `-- extractor.js
|-- build/
|   `-- bundler.js                # Userscript bundler
|-- SegmentScraper.user.js        # Generated Tampermonkey userscript
|-- package.json
`-- README.md
```

## Architecture

The shared core handles state, IMDb lookup, IntroDB communication, export, duplicate filtering, and panel actions. Each active provider supplies only its detection, interception, extraction, and player-control integration.

Provider metadata is normalized into the common intro, recap, and outro format before it enters shared state. The Netflix panel is the visual source of truth, with sizing and native controls isolated from streaming-site CSS so Prime Video and Videoland render identically.

## Adding a Provider

1. Create `src/providers/{provider-name}/index.js`.
2. Create `src/providers/{provider-name}/extractor.js`.
3. Register the provider with the shared bootstrap.
4. Add its configuration to `src/config/provider-config.js`.
5. Add any required mappings to `src/normalization/segment-mapper.js`.
6. Add the provider modules to the bundler input list and add the required userscript `@match` entries.

New provider panels must retain the shared Netflix layout. Only the documented provider overrides may differ.

## Build

Branch testing for timestamp evidence, validation and conflict review: [test guide](docs/timestamp-testing.md).

```bash
npm run build
```

The generated userscript is written to `SegmentScraper.user.js`.

## Player UI and Recovery Checks

Run `node --test` for regression tests and `node benchmark/serve-player-ui.cjs` for the local browser fixture at `http://127.0.0.1:8096`. The fixture runs 63 DOM checks across the five provider adapters, with controls for rerendering, waiting for controls, hidden controls, fullscreen, and a sample JSON preview. `http://127.0.0.1:8096/compact` embeds it in a 360 × 480 viewport. Prime Video, Videoland, and SkyShowtime fixtures reproduce the supplied control nesting with simulated native styles. Additional cases cover a fixed-width Netflix fullscreen wrapper, provider CSS that recolors SVG paths, an isolated white logo with Netflix sizing and alignment matched to the native icon, and overlap at narrow/wide player widths. Checks also cover hidden controls and rerendering; they are not live provider compatibility tests.

Before releasing, verify each provider with a series: open the panel from the playback controls, hide/show the native controls, enter/exit fullscreen, navigate to another title, allow autoplay to advance, and reload after capture. Confirm that the button stays out of the timeline and recovered segments are not captured twice. Cross-origin iframe players and native video-only fullscreen may restrict custom overlays; the icon is only shown when a lower playback-control anchor is available. No floating fallback is displayed. Prime Video receives a separate slot beside its rewind wrapper, SkyShowtime places the icon immediately right of subtitles, and Videoland reserves a separate slot before the bottom volume/fullscreen group in both fullscreen modes. Netflix inserts outside single-button wrappers. Native controls retain their original wrappers and styles. Temporarily hiding controls does not discard an existing mount; the icon follows native visibility and returns with the controls.

Captured sessions are stored in browser session storage, separately per provider and tab. Reloading the same tab restores captures and common episode-mapping metadata. Closing the tab normally ends that session; this is recovery storage, not a permanent backup. The panel shows the last saved time or a storage failure notice. Use **Clear data** to remove the saved capture; a confirmed JSON download and a fully successful IntroDB submission also clear it, while failed submissions preserve it for retry. API credentials remain in userscript-manager storage. An update notice preserves the recovery copy.

IntroDB errors and malformed responses are not cached as empty records. Export or submission stops when its duplicate check fails; use the same action again to retry. Requests made by SegmentScraper have timeouts, and duplicate checks for export/submission use batches of at most four. POST submissions are not automatically retried after an uncertain network result; a later submission checks IntroDB again first. The players' own network requests are left under provider control.

## Releasing an Update

Every published change must have a higher semantic version in `package.json`. The bundler uses that single value for `@version` and the runtime version check. Never put the version in `@name` and do not change `@name` or `@namespace` between releases: Tampermonkey uses that stable identity to recognize existing installations.

Version 1.5.7 changes the legacy versioned name to the permanent name `SegmentScraper - Multi-Provider Timestamps Extractor`. Existing users may need to remove the old versioned installation once and install 1.5.7 manually. Releases after that use the stable name and update in place.

```bash
npm version patch --no-git-tag-version
npm run build
npm test
```

Use `minor` or `major` instead of `patch` when appropriate. Commit and push both `package.json` and the generated `SegmentScraper.user.js` to `main`; users only see the required-update screen after the newer generated userscript is available there.

## Usage

1. Install [Tampermonkey](https://www.tampermonkey.net/) or another compatible userscript manager.
2. Install the generated `SegmentScraper.user.js`.
3. Open a supported streaming service and start playback.
4. Open the SegmentScraper panel from the injected player button.
5. Set the IMDb ID if automatic lookup did not resolve it.
6. Enter your own TheTVDB v4 API key and, when required, your optional subscriber PIN. These credentials and the reusable bearer token are stored locally by the userscript manager.
7. To capture a range yourself, expand **Mark timestamps from video**, choose Intro/Recap/Outro and confirm the playing title and episode. Use **Start here** and **End here**, preview both boundaries, tick the review checkbox and save the local candidate.
8. Open **Show timestamps** and select a segment-type filter if needed. Download the visible JSON timestamps, or save an IntroDB API key locally and submit directly. Before uploading, compare the clearly labelled **Scraper** and **IntroDB** ranges and approve the reviewed timestamps. Switching filters clears approvals. After a complete confirmed export or fully successful submission, captured timestamps are cleared; partial exports and failed submissions remain available. The stored key is not rendered back into the panel or written to logs.

At startup, SegmentScraper compares its installed semantic version with the `@version` in the userscript on the `main` branch. If GitHub confirms that a newer version exists, a non-dismissible update screen replaces the normal panel. The update link opens the raw userscript so Tampermonkey or Violentmonkey can install it. After installation, reload the streaming page. If GitHub is temporarily unreachable, the check fails open and the installed version remains usable.

Before a JSON export or IntroDB submission, SegmentScraper compares regular-episode counts against TheTVDB. Equal counts map by order. When counts differ, every regular provider episode is checked for an exact normalized, one-to-one, non-generic title match. Reliable matches are retained and unmatched episodes are skipped; the series is skipped only when no reliable mappings exist. Specials remain outside this normal mapping, export, and submission flow.

Episode metadata provided by [TheTVDB](https://thetvdb.com/).

## Acknowledgements

Thanks to [Comasss](https://github.com/Comasss) for the initial idea behind this scraping project and for contributing as the first person involved.

## Movie timestamps and post-credits scenes

The online userscript currently captures movie credits only from Netflix. Prime Video, Videoland and SkyShowtime movie captures are held offline while their provider markers are being verified; their series extraction remains active. The desktop app keeps its separate reviewed movie workflow. Movie exports and submissions use `is_movie: true` without season/episode; duplicate lookups use `GET /segments?imdb_id=...&is_movie=true`. TVDB mapping is not used for movies.

**Temporary exclusion policy (v1.9.4):** JSON export and IntroDB submission exclude the entire movie when captured post-credits data or existing IntroDB data confirms an extra scene. This applies across providers, even when a full outro is available. An incomplete provider scene range also withholds the outro. Missing markers remain unknown: this is not a complete catalogue of films with extra scenes, and films without known scene data may still have one.

The online userscript submits only a scene-safe movie `outro`. If captured data, existing IntroDB data, or TMDB confirms a mid-/post-credits scene, the entire movie is withheld. This avoids submitting an outro whose boundary crosses an extra scene. Movie outros must last 5–900 seconds, and scenes 5–600 seconds. Read responses use `post_credits`; submissions use `post-credits`. The desktop app keeps its separate reviewed-scene workflow.

The extractor recognizes explicit provider markers (Netflix `creditsOffset` plus runtime, Prime after/post/mid-credits events, Videoland after/post-credits chapters, and SkyShowtime SOAC/EOAC or named equivalents). Only Netflix movie markers currently enter the online capture state; the other provider movie markers remain available for later investigation but are not recorded or exported. Netflix movie credits starts are currently recorded six seconds before the supplied `creditsOffset`, based on the observed provider-wide six-second lag; the runtime end is unchanged and Netflix series markers are unaffected. These shapes are tested with fixtures; availability and timing still need verification against actual playback. A scene without an explicit end is not submitted, and the movie runtime is never used to invent that scene end. An outro without scene markers does not prove that the film has no extra scene. Multiple scenes are not fully modeled by this integration.

[AfterCredits](https://aftercredits.com/about/) can help check whether extra scenes exist, but that information alone does not establish exact timestamps for a particular streaming version. Do not turn a presence flag into an uploaded timestamp or re-submit another database's timestamps as a fresh observation. Review the actual scene boundaries before contributing uncertain data.

Netflix movie metadata is accepted when it provides an ordered `creditsOffset` and runtime. The movie start is corrected six seconds earlier to compensate for Netflix's observed credits-marker lag. The runtime is required as the known media boundary; the script does not invent an end when Netflix omits it. The captured outro still passes through the shared TMDB and IntroDB duplicate checks before export or upload. This does not affect TV extraction.

From v1.9.5, movie export and upload also check TMDB. Enter your own **API Read Access Token** from [TMDB API settings](https://www.themoviedb.org/settings/api) in the panel and save it locally. The token is never included in public state, logs, exports or request URLs; saving a blank field removes it. The script resolves the exact IMDb ID using TMDB's find endpoint, then checks the [movie keywords endpoint](https://developer.themoviedb.org/reference/movie-keywords) for `aftercreditsstinger` and `duringcreditsstinger`. Either keyword excludes the entire movie. Missing credentials, lookup ambiguity, unmatched IDs, malformed responses and network/API failures withhold movie export/upload. TV processing is unaffected.

A successful keyword response without these markers remains **unknown**, not confirmed scene absence; such movies may proceed through the other checks. Successful TMDB results are cached for 15 minutes (up to 200 movies); failures are retried on the next export/upload. Existing IntroDB scene data also excludes the entire movie; its ranges are never copied into a new submission. This product uses the TMDB API but is not endorsed or certified by TMDB. Automated checks cover mocked API responses; an authenticated live check requires a user token.

### SkyShowtime marker investigation (v1.9.4)

The reported exports for Nobody, The Naked Gun and Five Nights at Freddy's 2 cover only the final ~7 seconds. The supplied catalogue response confirms Nobody has only HD SOCR/startOfCredits=5495000 with duration=5502000 milliseconds and no scene markers. Nobody 2 supplies SOCR/startOfCredits=4993238 with duration=5365000, matching its reported good export. The Naked Gun supplies SOCR=5106893, SOLC=4454241 and EOLC=5106893 with duration=5114000. SOLC/EOLC are retained for diagnosis but their interpretation as credits or scene boundaries has not been verified. Movie markers within the final 10 seconds are now withheld as a review heuristic; this is not a correction of their start time. Longer ranges can still start too late (the reported Scream 7 case).

Use **Download movie diagnostics** in the SkyShowtime panel after opening affected and unaffected films. The separate JSON records numeric timing metadata for every format, the selected range, scene-marker presence (or unknown), and review reasons. It excludes playback URLs and credentials and is not an IntroDB submission. It retains up to 100 distinct observations during the session. Clear data or a page reload clears the report. Later movie boundary observations can now replace earlier captured boundaries.

The seven boundary fixtures reproduce the user's exported boundaries. Additional reduced fixtures preserve the relevant fields from the supplied catalogue responses for Nobody, Nobody 2 and The Naked Gun. Playback comparison or another source of exact boundaries is still required to fix missing first-credits and scene boundaries. Do not infer timestamps by subtracting a typical credits duration or combining markers from different quality versions.
