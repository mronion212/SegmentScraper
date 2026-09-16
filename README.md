# SegmentScraper

SegmentScraper extracts intro, recap, and outro timestamps from supported streaming services. It includes automatic IMDb lookup, JSON export, and IntroDB submission with duplicate filtering.

## Supported Services

- Netflix
- Prime Video
- Videoland
- SkyShowtime
- Crunchyroll

Disney+ and HBO Max are present in the provider configuration but do not yet have extraction modules.
Movie extraction in this branch is enabled for Prime Video, Videoland, and SkyShowtime; the other providers retain their existing TV behavior.
SkyShowtime captures catalogue metadata automatically from page or worker network requests and maps SOI/EOI, SOR/EOR, and SOCR/runtime to intro, recap, and outro segments. Movie credits use an explicit credit end marker when available and otherwise the known media runtime. SkyShowtime can return multiple provider variants for one title (for example a short preview and the full feature); movie extraction follows the `provider_variant_id` from the active request so those variants are not mixed. Captured timestamps remain available until `Clear Data` is used, so opening multiple titles in one tab intentionally keeps them together for export. When loading a series, wait until the UI icon has finished loading (that is, until the banner starts playing).

Crunchyroll reads the current episode metadata from the watch page and maps its public recap, intro, and credits markers to recap, intro, and outro segments. Episodes are captured as they are opened.

Every active provider logs each captured episode with readable timestamps and the exact raw start/end seconds. Prime Video, Videoland, and SkyShowtime movies bypass TheTVDB and use their IMDb ID with movie metadata in JSON exports and IntroDB submissions.

## Features

- Captures and normalizes provider-specific segment metadata
- Automatically looks up IMDb series IDs
- Exports captured timestamps as JSON
- Previews JSON before download
- Submits timestamps to IntroDB
- Removes segments already present in IntroDB from exports and submissions
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

```bash
npm run build
```

The generated userscript is written to `SegmentScraper.user.js`.

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
7. Download the JSON export, or save an IntroDB API key locally and submit directly. The stored key is not rendered back into the panel or written to logs.

At startup, SegmentScraper compares its installed semantic version with the `@version` in the userscript on the `main` branch. If GitHub confirms that a newer version exists, a non-dismissible update screen replaces the normal panel. The update link opens the raw userscript so Tampermonkey or Violentmonkey can install it. After installation, reload the streaming page. If GitHub is temporarily unreachable, the check fails open and the installed version remains usable.

Before a JSON export or IntroDB submission, SegmentScraper compares regular-episode counts against TheTVDB. Equal counts map by order. When counts differ, every regular provider episode is checked for an exact normalized, one-to-one, non-generic title match. Reliable matches are retained and unmatched episodes are skipped; the series is skipped only when no reliable mappings exist. Specials remain outside this normal mapping, export, and submission flow.

Episode metadata provided by [TheTVDB](https://thetvdb.com/).

## Acknowledgements

Thanks to [Comasss](https://github.com/Comasss) for the initial idea behind this scraping project and for contributing as the first person involved.

## Movie timestamps and post-credits scenes

Movie support is implemented for Prime Video, Videoland and SkyShowtime. Movie exports and submissions use `is_movie: true` without season/episode; duplicate lookups use `GET /segments?imdb_id=...&is_movie=true`. TVDB mapping is not used for movies.

Movie exports use a full `outro` from the first credits through the credits end (including extra scenes), with `post-credits` containing only the explicitly timed scene. This follows the requested convention and the worked example in [IntroDB movie documentation](https://introdb.app/docs/movies); the mid-credits prose on that page currently describes a conflicting convention. Movie outros must last 5–900 seconds, and scenes 5–600 seconds. Read responses use `post_credits`; submissions use `post-credits`.

The extractor recognizes explicit provider markers (Prime after/post-credits events, Videoland after/post-credits chapters, and SkyShowtime SOAC/EOAC or named equivalents). These shapes are tested with fixtures; availability and timing still need verification against actual playback. A scene without an explicit end is not submitted, and the movie runtime is never used to invent that end. An outro without scene markers does not prove that the film has no extra scene. Multiple scenes are not fully modeled by this integration.

[AfterCredits](https://aftercredits.com/about/) can help check whether extra scenes exist, but that information alone does not establish exact timestamps for a particular streaming version. Do not turn a presence flag into an uploaded timestamp or re-submit another database's timestamps as a fresh observation. Review the actual scene boundaries before contributing uncertain data.

Netflix movies are detected but are not submitted from `creditsOffset` alone. The console entry `[NFE] Netflix movie markers require playback verification` contains the title, movie ID, creditsOffset, runtime and skipMarkers for inspection. This does not affect TV extraction. No authenticated Netflix movie response was available during this review; fixture tests are not evidence that Netflix exposes scene boundaries.

TMDB's [movie keywords endpoint](https://developer.themoviedb.org/reference/movie-keywords) provides another possible presence check: [Spider-Man: Far From Home](https://www.themoviedb.org/movie/429617-spider-man-far-from-home?language=fr-FR) has both `aftercreditsstinger` and `duringcreditsstinger`. Keyword absence must remain unknown, not be interpreted as confirmed absence of a scene. This external check is not automatically integrated yet. Existing IntroDB scene ranges are already used to withhold an outro that starts after a known scene; those ranges are never copied into a new submission.
