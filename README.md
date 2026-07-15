# SegmentScraper

SegmentScraper extracts intro, recap, and outro timestamps from supported streaming services. It includes automatic IMDb lookup, JSON export, and IntroDB submission with duplicate filtering.

## Supported Services

- Netflix
- Prime Video
- Videoland
- SkyShowtime

Disney+ and HBO Max are present in the provider configuration but do not yet have extraction modules.
SkyShowtime captures catalogue metadata automatically from page or worker network requests and maps SOI/EOI, SOR/EOR, and SOCR/runtime to intro, recap, and outro segments.

## Features

- Captures and normalizes provider-specific segment metadata
- Automatically looks up IMDb series IDs
- Exports captured timestamps as JSON
- Previews JSON before download
- Submits timestamps to IntroDB
- Removes segments already present in IntroDB from exports and submissions
- Maps regular provider episodes to canonical TheTVDB season/episode numbers before JSON export or submission
- Excludes provider specials and TheTVDB Season 0 from count checks and normal submission mapping
- Uses one shared provider panel based on the Netflix layout

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
|       |-- netflix/
|       |   |-- index.js
|       |   `-- extractor.js
|       |-- prime-video/
|       |   |-- index.js
|       |   `-- extractor.js
|       `-- videoland/
|           |-- index.js
|           `-- extractor.js
|       `-- skyshowtime/
|           |-- index.js
|           `-- extractor.js             # Provider scaffold; extraction mapping pending
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

## Usage

1. Install [Tampermonkey](https://www.tampermonkey.net/) or another compatible userscript manager.
2. Install the generated `SegmentScraper.user.js`.
3. Open a supported streaming service and start playback.
4. Open the SegmentScraper panel from the injected player button.
5. Set the IMDb ID if automatic lookup did not resolve it.
6. Enter your own TheTVDB v4 API key and, when required, your optional subscriber PIN. These credentials and the reusable bearer token are stored locally by the userscript manager.
7. Download the JSON export, or save an IntroDB API key locally and submit directly. The stored key is not rendered back into the panel or written to logs.

Before a JSON export or IntroDB submission, SegmentScraper compares regular-episode counts against TheTVDB. Equal counts map by order. When counts differ, every regular provider episode is checked for an exact normalized, one-to-one, non-generic title match. Reliable matches are retained and unmatched episodes are skipped; the series is skipped only when no reliable mappings exist. Specials remain outside this normal mapping, export, and submission flow.

Episode metadata provided by [TheTVDB](https://thetvdb.com/).

## Acknowledgements

Thanks to [Comasss](https://github.com/Comasss) for the initial idea behind this scraping project and for contributing as the first person involved.
