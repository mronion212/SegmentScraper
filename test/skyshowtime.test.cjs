const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));

function loadSkyShowtimeExtractor(globals = {}) {
  const state = { allItems: [], imdbId: '', showTitle: '', providerEpisodes: [] };
  const detectedShows = [];
  let source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'providers', 'skyshowtime', 'extractor.js'),
    'utf8'
  )
    .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
    .replace(/\bexport\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/g, '');
  source += '\nglobalThis.skyExports = { findSkyShowtimeEpisodes, isSkyShowtimeCatalogueUrl, processSkyShowtimeMetadata, setupSkyShowtimeInterception };';

  const context = vm.createContext({
    state,
    detectedShows,
    console: { info() {}, warn() {}, error() {} },
    handleDetectedShow(show) {
      detectedShows.push(show);
      state.showTitle = show.title;
    },
    recordExtractedSegments(items) {
      state.allItems.push(...items);
    },
    setProviderEpisodeCatalog(episodes) {
      state.providerEpisodes = episodes;
    },
    ...globals,
  });
  vm.runInContext(source, context, { filename: 'skyshowtime-extractor.js' });
  return { ...context.skyExports, state, detectedShows };
}

function cataloguePayload() {
  return {
    data: {
      attributes: {
        providerSeriesId: 'series-123',
        seriesName: 'Example Series',
        year: 2025,
      },
      relationships: {
        items: {
          data: [{
            attributes: {
              providerSeriesId: 'series-123',
              seasonNumber: 2,
            },
            relationships: {
              items: {
                data: [
                  {
                    attributes: {
                      providerVariantId: 'episode-3',
                      episodeNumber: 3,
                      episodeName: 'Third Episode',
                      durationMilliseconds: 3600000,
                      formats: {
                        HD: {
                          markers: {
                            SOR: 0,
                            EOR: 12345,
                            SOI: 12345,
                            EOI: 88000,
                            SOCR: 3500123,
                          },
                        },
                      },
                    },
                  },
                  {
                    attributes: {
                      providerVariantId: 'episode-4',
                      episodeNumber: '4',
                      episodeName: 'Fourth Episode',
                      durationSeconds: '120',
                      formats: {
                        HD: {},
                        UHDSDR: { startOfCredits: '117000' },
                      },
                    },
                  },
                ],
              },
            },
          }],
        },
      },
    },
  };
}

test('maps SkyShowtime marker names and inherited season metadata', () => {
  const sky = loadSkyShowtimeExtractor();
  const count = sky.processSkyShowtimeMetadata(cataloguePayload(), 'test-response');

  assert.equal(count, 4);
  assert.deepEqual(plain(sky.detectedShows), [{
    title: 'Example Series',
    showId: 'series-123',
    year: 2025,
  }]);
  assert.deepEqual(plain(sky.state.providerEpisodes.map(item => ({
    providerId: item.providerId,
    season: item.season,
    episode: item.episode,
    title: item.title,
    isSpecial: item.isSpecial,
  }))), [
    { providerId: 'episode-3', season: 2, episode: 3, title: 'Third Episode', isSpecial: false },
    { providerId: 'episode-4', season: 2, episode: 4, title: 'Fourth Episode', isSpecial: false },
  ]);
  assert.deepEqual(plain(sky.state.allItems.map(item => ({
    type: item.segment_type,
    season: item.season,
    episode: item.episode,
    start: item.start_sec,
    end: item.end_sec,
  }))), [
    { type: 'recap', season: 2, episode: 3, start: 0, end: 12.345 },
    { type: 'intro', season: 2, episode: 3, start: 12.345, end: 88 },
    { type: 'outro', season: 2, episode: 3, start: 3500.123, end: 3600 },
    { type: 'outro', season: 2, episode: 4, start: 117, end: 120 },
  ]);
});

test('deduplicates repeated catalogue responses per episode and segment type', () => {
  const sky = loadSkyShowtimeExtractor();
  assert.equal(sky.processSkyShowtimeMetadata(cataloguePayload()), 4);
  assert.equal(sky.processSkyShowtimeMetadata(cataloguePayload()), 0);
  assert.equal(sky.state.allItems.length, 4);
});

test('matches only the SkyShowtime provider-series catalogue endpoint', () => {
  const sky = loadSkyShowtimeExtractor();
  assert.equal(sky.isSkyShowtimeCatalogueUrl(
    'https://atom.skyshowtime.com/adapter-calypso/v3/catalogue/provider_series_id/series-123?country=NL'
  ), true);
  assert.equal(sky.isSkyShowtimeCatalogueUrl(
    'https://atom.skyshowtime.com/adapter-calypso/v3/catalogue/provider_variant_id/episode-3'
  ), false);
  assert.equal(sky.isSkyShowtimeCatalogueUrl('https://www.netflix.com/memberapi/metadata'), false);
});

test('captures a SkyShowtime catalogue response from page fetch automatically', async () => {
  const payload = cataloguePayload();
  const response = {
    clone: () => ({ json: async () => payload }),
  };
  const pageWindow = {
    fetch: async () => response,
    performance: { getEntriesByType: () => [] },
  };
  const sky = loadSkyShowtimeExtractor({ unsafeWindow: pageWindow, window: pageWindow });
  sky.setupSkyShowtimeInterception();

  await pageWindow.fetch(
    'https://atom.skyshowtime.com/adapter-calypso/v3/catalogue/provider_series_id/series-123'
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sky.state.allItems.length, 4);
});

test('captures metadata forwarded by the SkyShowtime dedicated-worker bridge', () => {
  let workerSource = '';
  class FakeBlob {
    constructor(parts) {
      workerSource = parts.join('');
    }
  }
  class FakeUrl extends URL {}
  FakeUrl.createObjectURL = () => 'blob:segment-scraper-worker';
  FakeUrl.revokeObjectURL = () => {};
  class FakeWorker {
    constructor(url) {
      this.url = url;
      this.listeners = [];
    }
    addEventListener(type, listener) {
      if (type === 'message') this.listeners.push(listener);
    }
  }
  const pageWindow = {
    Worker: FakeWorker,
    Blob: FakeBlob,
    URL: FakeUrl,
    document: { baseURI: 'https://www.skyshowtime.com/watch/playback/example' },
    performance: { getEntriesByType: () => [] },
  };
  const sky = loadSkyShowtimeExtractor({
    unsafeWindow: pageWindow,
    window: pageWindow,
    setTimeout(callback) { callback(); },
  });
  sky.setupSkyShowtimeInterception();

  const worker = new pageWindow.Worker('/assets/player-worker.js');
  assert.equal(worker.url, 'blob:segment-scraper-worker');
  assert.match(workerSource, /worker-fetch/);
  assert.match(workerSource, /https:\/\/www\.skyshowtime\.com\/assets\/player-worker\.js/);
  let stopped = false;
  worker.listeners[0]({
    data: {
      __segmentScraperSkyShowtime: true,
      type: 'metadata',
      via: 'worker-fetch',
      url: 'https://atom.skyshowtime.com/adapter-calypso/v3/catalogue/provider_series_id/series-123',
      data: cataloguePayload(),
    },
    stopImmediatePropagation() { stopped = true; },
  });

  assert.equal(stopped, true);
  assert.equal(sky.state.allItems.length, 4);
});
