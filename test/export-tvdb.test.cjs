const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('large exports limit concurrent duplicate checks to four', async () => {
  let active = 0;
  let peak = 0;
  const bootstrap = loadBootstrap({
    stateOverrides: { allItems: Array.from({ length:10 }, (_, index) => ({ imdb_id:'ttmovie' + index, media_type:'movie', segment_type:'outro', start_sec:100, end_sec:130 })), tvdbApiKey:'' },
    existingSegmentsByKey: { get() {
      active++; peak = Math.max(peak, active);
      return new Promise(resolve => setTimeout(() => { active--; resolve(new Set()); }, 2));
    } },
  });
  await bootstrap.exportJSON();
  assert.equal(peak, 4);
  assert.equal(bootstrap.calls.dedup.length, 10);
  assert.equal(bootstrap.calls.previews[0].items.length, 10);
});

test('export and submission stop on unknown duplicate status and allow a later retry', async () => {
  let fail = true;
  const bootstrap = loadBootstrap({
    stateOverrides: { allItems: [{ imdb_id: 'ttmovie', media_type: 'movie', segment_type: 'outro', start_sec: 100, end_sec: 130 }], tvdbApiKey: '' },
    existingSegmentsByKey: { get() { if (fail) throw new Error('Duplicate check timed out'); return new Set(); } },
  });
  await bootstrap.exportJSON();
  await bootstrap.submitToIntroDB();
  assert.equal(bootstrap.calls.previews.length, 0);
  assert.equal(bootstrap.calls.submissions.length, 0);
  assert.equal(bootstrap.calls.confirmations.length, 0);
  assert.ok(bootstrap.calls.toasts.some(message => message.includes('timed out')));
  fail = false;
  await bootstrap.exportJSON();
  assert.equal(bootstrap.calls.previews.length, 1);
});

function loadBootstrap({ mappingResult, stateOverrides = {}, existingSegmentsByKey = new Map() }) {
  const calls = { map: [], dedup: [], toasts: [], previews: [], submissions: [], confirmations: [], infoLogs: [], warnLogs: [] };
  const state = {
    allItems: [
      { _eid: 'regular', _episodeTitle: 'Regular', imdb_id: 'tt123', segment_type: 'intro', season: 4, episode: 8, start_sec: 1, end_sec: 2 },
      { _eid: 'special', _episodeTitle: 'Bonus', imdb_id: 'tt123', segment_type: 'intro', season: 0, episode: 1, start_sec: 3, end_sec: 4 },
    ],
    imdbId: 'tt123',
    introdbApiKey: 'introdb-key',
    tvdbApiKey: 'local-key',
    providerEpisodes: [{ season: 4, episode: 8, title: 'Regular' }, { season: 0, episode: 1, title: 'Bonus', isSpecial: true }],
    providerEpisodesByShowId: {},
    submitInProgress: false,
    dedupCacheV2: {},
    showIds: new Set(),
    imdbIdsByShowId: {},
    ...stateOverrides,
  };
  let source = fs.readFileSync(path.join(__dirname, '..', 'src', 'providers', 'bootstrap.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  source += '\nglobalThis.bootstrapExports = { exportJSON, submitToIntroDB };';

  const context = vm.createContext({
    state,
    console: {
      log() {},
      info: message => calls.infoLogs.push(message),
      warn: message => calls.warnLogs.push(message),
      error() {},
    },
    Blob,
    URL,
    setTimeout,
    clearTimeout,
    location: { pathname: '' },
    window: {},
    document: {
      getElementById: () => null,
      addEventListener: () => {},
      createElement: () => ({ click() {} }),
      body: { appendChild() {}, removeChild() {} },
      querySelector: () => null,
    },
    createState: () => ({}),
    createEpisodeCacheKey: (imdbId, season, episode) => `${imdbId}|${season}|${episode}`,
    createMediaCacheKey: (imdbId, mediaType, season, episode) => String(mediaType).toLowerCase() === 'movie'
      ? `${imdbId}|movie`
      : `${imdbId}|${season}|${episode}`,
    searchImdbByTitle: async () => ({ success: false }),
    lookupImdbTitle: async () => ({ success: false }),
    loadExistingSegments: async () => [],
    loadExistingSegmentsForEpisode: async (key, apiKey, options) => {
      calls.dedup.push({ key, apiKey, options });
      return existingSegmentsByKey.get(key) || new Set();
    },
    submitSegment: async item => {
      calls.submissions.push(item);
      return { success: true };
    },
    injectBtn: () => {},
    getNextEpBtn: () => null,
    setProviderName: () => {},
    closePanel: () => {},
    updateCounters: () => {},
    updatePanelTitle: () => {},
    toast: message => calls.toasts.push(message),
    setIntrodbStatus: () => {},
    setTvdbStatus: () => {},
    confirm: message => {
      calls.confirmations.push(message);
      return true;
    },
    updateImdbInput: () => {},
    showExportPreview: options => calls.previews.push(options),
    getProviderConfig: () => ({ name: 'Netflix' }),
    loadTvdbSettings: () => ({ apiKey: 'local-key', pin: '' }),
    saveTvdbSettings: () => {},
    mapSeriesItemsToTvdb: async (items, catalog) => {
      calls.map.push({ items, catalog });
      return typeof mappingResult === 'function' ? mappingResult(items, catalog) : mappingResult;
    },
  });
  vm.runInContext(source, context, { filename: 'bootstrap.js' });
  return {
    exportJSON: context.bootstrapExports.exportJSON,
    submitToIntroDB: context.bootstrapExports.submitToIntroDB,
    calls,
  };
}

test('JSON export uses TVDB mapping and canonical episode numbers before deduplication', async () => {
  const mappedItem = { imdb_id: 'tt123', segment_type: 'intro', season: 1, episode: 2, start_sec: 1, end_sec: 7 };
  const bootstrap = loadBootstrap({
    mappingResult: {
      success: true,
      method: 'order',
      reason: 'regular-episode counts match',
      items: [mappedItem],
      stats: { providerRegular: 1, tvdbRegular: 1, providerSpecialsExcluded: 1, tvdbSpecialsExcluded: 1, capturedSpecialsExcluded: 1 },
    },
  });

  await bootstrap.exportJSON();

  assert.equal(bootstrap.calls.map.length, 1);
  assert.equal(bootstrap.calls.map[0].items.length, 2);
  assert.equal(bootstrap.calls.dedup.length, 1);
  assert.equal(bootstrap.calls.dedup[0].key, 'tt123|1|2');
  assert.equal(bootstrap.calls.dedup[0].apiKey, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(bootstrap.calls.dedup[0].options)), { useCache: false, writeCache: false });
  assert.equal(bootstrap.calls.previews.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(bootstrap.calls.previews[0].items)), [mappedItem]);
});

test('JSON export keeps separate SkyShowtime series and uses each provider catalog', async () => {
  const seriesAItem = { _eid: 'a', _showId: 'series-a', _episodeTitle: 'A1', imdb_id: 'tt111', segment_type: 'intro', season: 1, episode: 1, start_sec: 0, end_sec: 10 };
  const seriesBItem = { _eid: 'b', _showId: 'series-b', _episodeTitle: 'B1', imdb_id: 'tt222', segment_type: 'intro', season: 1, episode: 1, start_sec: 0, end_sec: 10 };
  const catalogs = {
    'series-a': [{ season: 1, episode: 1, title: 'A1' }],
    'series-b': [{ season: 1, episode: 1, title: 'B1' }],
  };
  const bootstrap = loadBootstrap({
    stateOverrides: {
      allItems: [seriesAItem, seriesBItem],
      imdbId: 'tt222',
      showId: 'series-b',
      providerEpisodes: catalogs['series-b'],
      providerEpisodesByShowId: catalogs,
    },
    mappingResult: (items) => ({
      success: true,
      method: 'order',
      reason: 'regular-episode counts match',
      items: items.map(({ _eid, _episodeTitle, _showId, ...item }) => item),
      stats: {
        providerRegular: 1,
        tvdbRegular: 1,
        providerSpecialsExcluded: 0,
        tvdbSpecialsExcluded: 0,
        capturedSpecialsExcluded: 0,
        regularEpisodesMatched: 1,
        regularEpisodesSkipped: 0,
        regularEpisodeSkipReasons: {},
        capturedRegularSegmentsSkipped: 0,
      },
    }),
  });

  await bootstrap.exportJSON();

  assert.equal(bootstrap.calls.map.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(bootstrap.calls.map.map(call => call.catalog))), [catalogs['series-a'], catalogs['series-b']]);
  assert.equal(bootstrap.calls.previews.length, 1);
  assert.equal(bootstrap.calls.previews[0].fileCount, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(bootstrap.calls.previews[0].items.map(item => item.imdb_id))), ['tt111', 'tt222']);
});

test('JSON export produces no preview when TVDB rejects the series mapping', async () => {
  const bootstrap = loadBootstrap({ mappingResult: { success: false, reason: 'episode titles are missing' } });

  await bootstrap.exportJSON();

  assert.equal(bootstrap.calls.previews.length, 0);
  assert.ok(bootstrap.calls.toasts.some(message => message.includes('nothing was exported')));
});

test('partial title mapping logs regular episode match and skip counts with reasons', async () => {
  const mappedItem = { imdb_id: 'tt123', segment_type: 'intro', season: 1, episode: 2, start_sec: 1, end_sec: 7 };
  const bootstrap = loadBootstrap({
    mappingResult: {
      success: true,
      method: 'title',
      reason: 'regular-episode counts differ; 1 matched and 1 skipped',
      items: [mappedItem],
      stats: {
        providerRegular: 2,
        tvdbRegular: 3,
        providerSpecialsExcluded: 1,
        tvdbSpecialsExcluded: 0,
        capturedSpecialsExcluded: 1,
        regularEpisodesMatched: 1,
        regularEpisodesSkipped: 1,
        regularEpisodeSkipReasons: { genericTitle: 1 },
        capturedRegularSegmentsMatched: 1,
        capturedRegularSegmentsSkipped: 0,
      },
    },
  });

  await bootstrap.exportJSON();

  assert.equal(bootstrap.calls.previews.length, 1);
  assert.ok(bootstrap.calls.infoLogs.some(message =>
    message.includes('Regular episodes matched: 1; skipped: 1; reasons: generic title: 1.')));
});

test('JSON export removes segments shorter than five seconds and keeps exact boundary', async () => {
  const shortItem = { imdb_id: 'tt123', segment_type: 'recap', season: 1, episode: 2, start_sec: 10, end_sec: 14.999 };
  const boundaryItem = { imdb_id: 'tt123', segment_type: 'intro', season: 1, episode: 2, start_sec: 20, end_sec: 25 };
  const bootstrap = loadBootstrap({
    mappingResult: {
      success: true,
      method: 'order',
      reason: 'regular-episode counts match',
      items: [shortItem, boundaryItem],
      stats: { providerRegular: 1, tvdbRegular: 1 },
    },
  });

  await bootstrap.exportJSON();

  assert.deepEqual(JSON.parse(JSON.stringify(bootstrap.calls.previews[0].items)), [boundaryItem]);
  assert.ok(bootstrap.calls.toasts.some(message => message.includes('shorter than 5 seconds removed')));
});

test('IntroDB submission removes segments shorter than five seconds', async () => {
  const shortItem = { imdb_id: 'tt123', segment_type: 'recap', season: 1, episode: 2, start_sec: 10, end_sec: 12 };
  const eligibleItem = { imdb_id: 'tt123', segment_type: 'intro', season: 1, episode: 2, start_sec: 20, end_sec: 27 };
  const bootstrap = loadBootstrap({
    mappingResult: {
      success: true,
      method: 'order',
      reason: 'regular-episode counts match',
      items: [shortItem, eligibleItem],
      stats: { providerRegular: 1, tvdbRegular: 1 },
    },
  });

  await bootstrap.submitToIntroDB();
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.deepEqual(JSON.parse(JSON.stringify(bootstrap.calls.submissions)), [eligibleItem]);
  assert.match(bootstrap.calls.confirmations[0], /Submit 1 timestamp/);
  assert.ok(bootstrap.calls.toasts.some(message => message.includes('shorter than 5 seconds skipped')));
});

test('movie JSON export bypasses TVDB and uses a movie deduplication key', async () => {
  const movieItem = {
    _eid: 'movie-internal-id',
    _episodeTitle: 'Primate',
    _showId: 'skyshowtime-variant-id',
    imdb_id: 'ttmovie1',
    media_type: 'movie',
    segment_type: 'outro',
    season: null,
    episode: null,
    start_sec: 5400,
    end_sec: 5700,
  };
  const bootstrap = loadBootstrap({
    stateOverrides: {
      allItems: [movieItem],
      imdbId: 'ttmovie1',
      tvdbApiKey: '',
    },
    mappingResult: { success: false, reason: 'TVDB must not be called for movies' },
  });

  await bootstrap.exportJSON();

  assert.equal(bootstrap.calls.map.length, 0);
  assert.deepEqual(bootstrap.calls.dedup.map(call => call.key), ['ttmovie1|movie']);
  assert.deepEqual(JSON.parse(JSON.stringify(bootstrap.calls.previews[0].items)), [{
    imdb_id: 'ttmovie1',
    media_type: 'movie',
    segment_type: 'outro',
    start_sec: 5400,
    end_sec: 5700,
  }]);
});

test('movie IntroDB submission bypasses TVDB mapping', async () => {
  const movieItem = {
    imdb_id: 'ttmovie2',
    media_type: 'movie',
    segment_type: 'outro',
    season: null,
    episode: null,
    start_sec: 5400,
    end_sec: 5700,
  };
  const bootstrap = loadBootstrap({
    stateOverrides: {
      allItems: [movieItem],
      imdbId: 'ttmovie2',
      tvdbApiKey: '',
    },
    mappingResult: { success: false, reason: 'TVDB must not be called for movies' },
  });

  await bootstrap.submitToIntroDB();
  await new Promise(resolve => setTimeout(resolve, 200));

  assert.equal(bootstrap.calls.map.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(bootstrap.calls.submissions)), [movieItem]);
});

test('movie export keeps the credit part that is not already present in IntroDB', async () => {
  const before = {
    imdb_id: 'ttmovie3',
    media_type: 'movie',
    segment_type: 'outro',
    credit_part: 'before_after_credits_scene',
    season: null,
    episode: null,
    start_sec: 5400,
    end_sec: 5600,
  };
  const after = {
    ...before,
    _eid: 'after',
    credit_part: 'after_after_credits_scene',
    start_sec: 5800,
    end_sec: 6000,
  };
  const existing = new Set(['outro']);
  existing.rangesByType = new Map([['outro', [{
    startSec: before.start_sec,
    endSec: before.end_sec,
    creditPart: before.credit_part,
  }]]]);
  const bootstrap = loadBootstrap({
    stateOverrides: {
      allItems: [before, after],
      imdbId: 'ttmovie3',
      tvdbApiKey: '',
    },
    mappingResult: { success: false, reason: 'TVDB must not be called for movies' },
    existingSegmentsByKey: new Map([['ttmovie3|movie', existing]]),
  });

  await bootstrap.exportJSON();

  assert.deepEqual(JSON.parse(JSON.stringify(bootstrap.calls.previews[0].items)), [{
    imdb_id: 'ttmovie3',
    media_type: 'movie',
    segment_type: 'outro',
    credit_part: 'after_after_credits_scene',
    start_sec: 5800,
    end_sec: 6000,
  }]);
  assert.ok(bootstrap.calls.toasts.some(message => message.includes('1 duplicate')));
});
