const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadBootstrap({ mappingResult }) {
  const calls = { map: [], dedup: [], toasts: [], previews: [], infoLogs: [], warnLogs: [] };
  const state = {
    allItems: [
      { _eid: 'regular', _episodeTitle: 'Regular', imdb_id: 'tt123', segment_type: 'intro', season: 4, episode: 8, start_sec: 1, end_sec: 2 },
      { _eid: 'special', _episodeTitle: 'Bonus', imdb_id: 'tt123', segment_type: 'intro', season: 0, episode: 1, start_sec: 3, end_sec: 4 },
    ],
    imdbId: 'tt123',
    tvdbApiKey: 'local-key',
    providerEpisodes: [{ season: 4, episode: 8, title: 'Regular' }, { season: 0, episode: 1, title: 'Bonus', isSpecial: true }],
    submitInProgress: false,
    dedupCacheV2: {},
    showIds: new Set(),
  };
  let source = fs.readFileSync(path.join(__dirname, '..', 'src', 'providers', 'bootstrap.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  source += '\nglobalThis.bootstrapExports = { exportJSON };';

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
    submitSegment: async () => ({ success: true }),
    injectBtn: () => {},
    getNextEpBtn: () => null,
    setProviderName: () => {},
    closePanel: () => {},
    updateCounters: () => {},
    updatePanelTitle: () => {},
    toast: message => calls.toasts.push(message),
    updateImdbInput: () => {},
    showExportPreview: options => calls.previews.push(options),
    getProviderConfig: () => ({ name: 'Netflix' }),
    loadTvdbSettings: () => ({ apiKey: 'local-key', pin: '' }),
    saveTvdbSettings: () => {},
    mapSeriesItemsToTvdb: async (items, catalog) => {
      calls.map.push({ items, catalog });
      return mappingResult;
    },
  });
  vm.runInContext(source, context, { filename: 'bootstrap.js' });
  return { exportJSON: context.bootstrapExports.exportJSON, calls };
}

test('JSON export uses TVDB mapping and canonical episode numbers before deduplication', async () => {
  const mappedItem = { imdb_id: 'tt123', segment_type: 'intro', season: 1, episode: 2, start_sec: 1, end_sec: 2 };
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

test('JSON export produces no preview when TVDB rejects the series mapping', async () => {
  const bootstrap = loadBootstrap({ mappingResult: { success: false, reason: 'episode titles are missing' } });

  await bootstrap.exportJSON();

  assert.equal(bootstrap.calls.previews.length, 0);
  assert.ok(bootstrap.calls.toasts.some(message => message.includes('nothing was exported')));
});

test('partial title mapping logs regular episode match and skip counts with reasons', async () => {
  const mappedItem = { imdb_id: 'tt123', segment_type: 'intro', season: 1, episode: 2, start_sec: 1, end_sec: 2 };
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
