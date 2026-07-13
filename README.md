# SegmentScraper

Extracts and organizes intro, recap, and outro segments from streaming services. Auto IMDb lookup. Submits to IntroDB with deduplication.

## Project Structure

```
SegmentScraper/
├── src/
│   ├── core/
│   │   ├── state.js       # Shared state management
│   │   └── network.js     # Shared network utilities (IMDb, IntroDB)
│   ├── ui/
│   │   ├── panel.js       # Shared UI panel component
│   │   └── button.js      # Shared button component
│   ├── config/
│   │   └── provider-config.js  # Provider-specific theming and settings
│   ├── normalization/
│   │   └── segment-mapper.js   # Segment type normalization layer
│   └── providers/
│       └── netflix/
│           ├── index.js       # Netflix provider entry point
│           └── extractor.js   # Netflix-specific extraction logic
├── build/
│   └── bundler.js         # Build script to bundle into .user.js
├── SegmentScraper.user.js # Generated userscript (Tampermonkey compatible)
└── package.json
```

## Architecture

### Core Modules
- **state.js**: Manages captured timestamps, UI state, and deduplication cache
- **network.js**: Handles API requests, IMDb lookups, and IntroDB integration

### UI Components
- **panel.js**: Creates a reusable panel with provider-configurable styling
- **button.js**: Injects a trigger button into the player UI

### Configuration Layer
- **provider-config.js**: Defines UI themes, branding, and service-specific settings for each provider

### Normalization Layer
- **segment-mapper.js**: Maps provider-specific segment names to shared internal format (intro, recap, outro)

### Provider Modules
Each provider has its own extraction module that knows how to:
- Detect the service
- Fetch segment data (via XHR/fetch interception, DOM parsing, etc.)
- Parse and normalize the data

## Adding a New Provider

1. Create a new folder under `src/providers/{provider-name}/`
2. Create `index.js` with provider-specific initialization
3. Create `extractor.js` with segment extraction logic
4. Add provider configuration to `src/config/provider-config.js`
5. Add segment mappings to `src/normalization/segment-mapper.js`

## Development

```bash
# Install dependencies
npm install

# Build the userscript
npm run build

# The output will be in SegmentScraper.user.js
```

## Usage

1. Install [Tampermonkey](https://www.tampermonkey.net/) or a compatible userscript manager
2. Add the generated `SegmentScraper.user.js` to Tampermonkey
3. Configure your IntroDB API key in the script
4. Navigate to a supported streaming service to use the extension

## Supported Services

- Netflix
- Disney+ (planned)
- Prime Video (planned)
- HBO Max (planned)