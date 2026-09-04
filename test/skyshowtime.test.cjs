const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));

function loadSkyShowtimeExtractor(globals = {}) {
  const state = { allItems: [], imdbId: '', imdbIdsByShowId: {}, showTitle: '', providerEpisodes: [] };
  const detectedShows = [];
  const logs = [];
  let source = [
    fs.readFileSync(path.join(__dirname, '..', 'src', 'providers', 'timestamp-logger.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'src', 'normalization', 'segment-mapper.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'src', 'providers', 'skyshowtime', 'extractor.js'), 'utf8'),
  ].join('\n')
    .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
    .replace(/\bexport\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/g, '');
  source += '\nglobalThis.skyExports = { findSkyShowtimeEpisodes, findSkyShowtimeMovies, isSkyShowtimeCatalogueUrl, processSkyShowtimeMetadata, setupSkyShowtimeInterception };';

  const context = vm.createContext({
    state,
    detectedShows,
    console: { info(...args) { logs.push(args); }, warn() {}, error() {} },
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
  return { ...context.skyExports, state, detectedShows, logs };
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
    showId: item._showId,
    type: item.segment_type,
    season: item.season,
    episode: item.episode,
    start: item.start_sec,
    end: item.end_sec,
  }))), [
    { showId: 'series-123', type: 'recap', season: 2, episode: 3, start: 0, end: 12.345 },
    { showId: 'series-123', type: 'intro', season: 2, episode: 3, start: 12.345, end: 88 },
    { showId: 'series-123', type: 'outro', season: 2, episode: 3, start: 3500.123, end: 3600 },
    { showId: 'series-123', type: 'outro', season: 2, episode: 4, start: 117, end: 120 },
  ]);
  assert.deepEqual(plain(sky.logs.slice(0, 2)), [
    [
      '[SSE] Captured timestamps · Example Series · S02E03',
      {
        title: 'Third Episode',
        providerVariantId: 'episode-3',
        segments: [
          { type: 'recap', start: '00:00.000', end: '00:12.345', start_sec: 0, end_sec: 12.345 },
          { type: 'intro', start: '00:12.345', end: '01:28.000', start_sec: 12.345, end_sec: 88 },
          { type: 'outro', start: '58:20.123', end: '01:00:00.000', start_sec: 3500.123, end_sec: 3600 },
        ],
      },
    ],
    [
      '[SSE] Captured timestamps · Example Series · S02E04',
      {
        title: 'Fourth Episode',
        providerVariantId: 'episode-4',
        segments: [
          { type: 'outro', start: '01:57.000', end: '02:00.000', start_sec: 117, end_sec: 120 },
        ],
      },
    ],
  ]);
  assert.deepEqual(plain(sky.logs[2]), ['[SSE] Captured 4 segment(s) from test-response.']);
});

test('deduplicates repeated catalogue responses per episode and segment type', () => {
  const sky = loadSkyShowtimeExtractor();
  assert.equal(sky.processSkyShowtimeMetadata(cataloguePayload()), 4);
  assert.equal(sky.processSkyShowtimeMetadata(cataloguePayload()), 0);
  assert.equal(sky.state.allItems.length, 4);
  assert.equal(sky.logs.filter(([message]) => message.includes('Captured timestamps')).length, 2);
  assert.equal(sky.logs.length, 3);
});

test('captures SkyShowtime movie credits only with an explicit end marker', () => {
  const sky = loadSkyShowtimeExtractor();
  const payload = {
    data: {
      attributes: {
        providerVariantId: 'movie-123',
        type: 'MOVIE',
        titleLong: 'Example Movie',
        year: 2025,
        durationMilliseconds: 6000000,
        formats: {
          HD: {
            markers: {
              SOCR: 5400000,
              EOCR: 6000000,
              SOAC: 5680000,
              EOAC: 5800000,
            },
          },
        },
      },
    },
  };

  assert.equal(sky.processSkyShowtimeMetadata(payload), 2);
  assert.deepEqual(plain(sky.detectedShows), [{
    title: 'Example Movie',
    showId: 'movie-123',
    year: 2025,
    mediaType: 'movie',
  }]);
  assert.deepEqual(plain(sky.state.providerEpisodes), []);
  assert.deepEqual(plain(sky.state.allItems), [{
    _eid: 'movie-123::movie::outro::before_after_credits_scene',
    _episodeTitle: 'Example Movie',
    _showId: 'movie-123',
    media_type: 'movie',
    credit_part: 'before_after_credits_scene',
    imdb_id: 'IMDB_PENDING',
    segment_type: 'outro',
    season: null,
    episode: null,
    start_sec: 5400,
    end_sec: 5680,
  }, {
    _eid: 'movie-123::movie::outro::after_after_credits_scene',
    _episodeTitle: 'Example Movie',
    _showId: 'movie-123',
    media_type: 'movie',
    credit_part: 'after_after_credits_scene',
    imdb_id: 'IMDB_PENDING',
    segment_type: 'outro',
    season: null,
    episode: null,
    start_sec: 5800,
    end_sec: 6000,
  }]);
});

test('uses SkyShowtime movie runtime when no explicit credits end is present', () => {
  const sky = loadSkyShowtimeExtractor();
  const payload = {
    data: {
      attributes: {
        providerVariantId: 'movie-456',
        type: 'MOVIE',
        title: 'Movie without end marker',
        durationMilliseconds: 6000000,
        formats: { HD: { markers: { SOCR: 5400000 } } },
      },
    },
  };

  assert.equal(sky.processSkyShowtimeMetadata(payload), 1);
  assert.deepEqual(plain(sky.state.allItems.map(item => [item.start_sec, item.end_sec])), [[5400, 6000]]);
});

test('uses a marker-bearing quality format and JSON-API movie id', () => {
  const sky = loadSkyShowtimeExtractor();
  const payload = {
    data: {
      id: 'movie-wrapped-123',
      attributes: {
        entityType: 'Movie',
        titleLong: 'Wrapped Movie',
        releaseYear: 2024,
        durationMilliseconds: 6000000,
        formats: {
          HD: { markers: {} },
          UHDSDR: { markers: { startOfCredits: 5400000, endOfCredits: 6000000 } },
        },
      },
    },
  };

  assert.equal(sky.processSkyShowtimeMetadata(payload), 1);
  assert.deepEqual(plain(sky.detectedShows), [{
    title: 'Wrapped Movie',
    showId: 'movie-wrapped-123',
    year: 2024,
    mediaType: 'movie',
  }]);
  assert.deepEqual(plain(sky.state.allItems.map(item => [item._showId, item.start_sec, item.end_sec])), [
    ['movie-wrapped-123', 5400, 6000],
  ]);
});

test('keeps only the requested movie variant from a mixed SkyShowtime response', () => {
  const sky = loadSkyShowtimeExtractor();
  const payload = {
    data: {
      attributes: {
        items: [
          {
            id: 'opening-credit-variant',
            attributes: {
              entityType: 'Movie',
              titleLong: 'Movie with alternate variants',
              durationMilliseconds: 6000000,
              formats: { HD: { markers: { SOCR: 54000, EOCR: 174000 } } },
            },
          },
          {
            id: 'full-movie-variant',
            attributes: {
              entityType: 'Movie',
              titleLong: 'Movie with alternate variants',
              durationMilliseconds: 6000000,
              formats: { HD: { markers: { SOCR: 4993238, EOCR: 6000000 } } },
            },
          },
        ],
      },
    },
  };

  assert.equal(sky.processSkyShowtimeMetadata(
    payload,
    'page-fetch: https://atom.skyshowtime.com/adapter-calypso/v3/catalogue/provider_variant_id/full-movie-variant'
  ), 1);
  assert.deepEqual(plain(sky.state.allItems.map(item => ({
    id: item._showId,
    start: item.start_sec,
    end: item.end_sec,
  }))), [{ id: 'full-movie-variant', start: 4993.238, end: 6000 }]);
});

test('matches SkyShowtime series and movie catalogue endpoints only', () => {
  const sky = loadSkyShowtimeExtractor();
  assert.equal(sky.isSkyShowtimeCatalogueUrl(
    'https://atom.skyshowtime.com/adapter-calypso/v3/catalogue/provider_series_id/series-123?country=NL'
  ), true);
  assert.equal(sky.isSkyShowtimeCatalogueUrl(
    'https://atom.skyshowtime.com/adapter-calypso/v3/catalogue/provider_variant_id/episode-3'
  ), true);
  assert.equal(sky.isSkyShowtimeCatalogueUrl(
    'https://atom.skyshowtime.com/adapter-calypso/v3/catalogue/uuid/movie-123'
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

test('captures a SkyShowtime movie response from a provider-variant fetch', async () => {
  const payload = {
    data: {
      attributes: {
        providerVariantId: 'movie-fetch-123',
        type: 'MOVIE',
        titleLong: 'Fetched Movie',
        year: 2025,
        durationMilliseconds: 6000000,
        formats: { HD: { markers: { SOCR: 5400000, EOCR: 6000000 } } },
      },
    },
  };
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
    'https://atom.skyshowtime.com/adapter-calypso/v3/catalogue/provider_variant_id/movie-fetch-123'
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(sky.state.allItems.map(item => ({
    id: item._showId,
    type: item.media_type,
    start: item.start_sec,
    end: item.end_sec,
  }))), [{ id: 'movie-fetch-123', type: 'movie', start: 5400, end: 6000 }]);
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
  assert.match(workerSource, /provider_variant_id/);
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
