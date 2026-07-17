const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadBootstrap({ mappingResult, stateOverrides = {} }) {
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
    searchImdbByTitle: async () => ({ success: false }),
    lookupImdbTitle: async () => ({ success: false }),
    loadExistingSegments: async () => [],
    loadExistingSegmentsForEpisode: async (key, apiKey, options) => {
      calls.dedup.push({ key, apiKey, options });
      return new Set();
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
