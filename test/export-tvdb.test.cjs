const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('large exports limit concurrent duplicate checks to four', async () => {
  let active = 0;
  let peak = 0;
  const bootstrap = loadBootstrap({
    stateOverrides: { allItems: Array.from({ length:10 }, (_, index) => ({ imdb_id:'ttmovie' + index, season: 1, episode: 1, segment_type:'outro', start_sec:100, end_sec:130 })), tvdbApiKey:'test-key' },
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
    stateOverrides: { allItems: [{ imdb_id: 'ttmovie', season: 1, episode: 1, segment_type: 'outro', start_sec: 100, end_sec: 130 }], tvdbApiKey:'test-key' },
    existingSegmentsByKey: { get() { if (fail) throw new Error('Duplicate check timed out'); return new Set(); } },
  });
  await bootstrap.exportJSON();
  await bootstrap.submitToIntroDB();
  assert.equal(bootstrap.calls.previews.length, 1);
  assert.equal(bootstrap.calls.previews[0].items.length, 0);
  assert.equal(bootstrap.calls.previews[0].rows[0].status, 'Unavailable');
  assert.equal(bootstrap.calls.submissions.length, 0);
  assert.equal(bootstrap.calls.confirmations.length, 0);
  assert.ok(bootstrap.calls.toasts.some(message => message.includes('timed out')));
  fail = false;
  await bootstrap.exportJSON();
  assert.equal(bootstrap.calls.previews.length, 2);
});

function loadBootstrap({ mappingResult = items => ({ success: true, method: 'title', items, stats: {} }), stateOverrides = {}, existingSegmentsByKey = new Map(), tmdbResult = { status: 'unknown' } }) {
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
    checkTmdbExtraScenes: async () => tmdbResult,
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
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/core/output-policy.js'), 'utf8').replace(/^export /gm, ''), context);
  vm.runInContext(source, context, { filename: 'bootstrap.js' });
  return {
    exportJSON: context.bootstrapExports.exportJSON,
    submitToIntroDB: context.bootstrapExports.submitToIntroDB,
    calls,
  };
}

test('overview retains originals and marks canonical duplicates, new items and failed checks separately', async () => {
  const allItems = [1, 2, 3, 4].map(episode => ({
    _eid: `episode-${episode}`, imdb_id: 'tt14507354', season: 2, episode,
    segment_type: 'outro', start_sec: 100, end_sec: 120,
  }));
  const bootstrap = loadBootstrap({
    stateOverrides: { allItems },
    mappingResult: items => ({ success: true, method: 'title',
      items: items.slice(0, 3).map(item => ({ ...item, season: 1 })),
      stats: {},
    }),
    existingSegmentsByKey: { get(key) {
      if (key.endsWith('|3')) throw new Error('HTTP 400 for tt14507354 S1E3');
      return key.endsWith('|1') ? new Set(['outro']) : new Set();
    } },
  });
  await bootstrap.exportJSON();
  const view = bootstrap.calls.previews[0];
  assert.deepEqual(Array.from(view.rows, row => row.status), ['In IntroDB', 'NEW', 'Unavailable', 'Unavailable']);
  assert.equal(view.rows[0].item.season, 2);
  assert.equal(view.rows[0].canonical.season, 1);
  assert.match(view.rows[2].reason, /HTTP 400/);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].episode, 2);
  assert.equal(view.duplicateCount, 1);
  assert.equal(view.checking, false);
});

test('overview is available without a TVDB API key', async () => {
  const bootstrap = loadBootstrap({ stateOverrides: { tvdbApiKey:'' } });
  await bootstrap.exportJSON();
  const view = bootstrap.calls.previews[0];
  assert.equal(view.rows.length, 2);
  assert.equal(view.items.length, 0);
  assert.equal(view.onConfirm, undefined);
  assert.equal(view.checking, false);
  assert.match(view.message, /key missing/);
});

test('all existing timestamps remain visible without a download', async () => {
  const bootstrap = loadBootstrap({
    stateOverrides: { allItems: [{ imdb_id: 'tt14507354', season: 1, episode: 1, segment_type: 'outro', start_sec: 100, end_sec: 120 }] },
    existingSegmentsByKey: { get: () => new Set(['outro']) },
  });
  await bootstrap.exportJSON();
  const view = bootstrap.calls.previews[0];
  assert.equal(view.rows[0].status, 'In IntroDB');
  assert.equal(view.items.length, 0);
  assert.equal(view.onConfirm, undefined);
});

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

test('timestamps remain visible when TVDB rejects the series mapping', async () => {
  const bootstrap = loadBootstrap({ mappingResult: { success: false, reason: 'episode titles are missing' } });

  await bootstrap.exportJSON();

  assert.equal(bootstrap.calls.previews.length, 1);
  assert.equal(bootstrap.calls.previews[0].rows.length, 2);
  assert.equal(bootstrap.calls.previews[0].items.length, 0);
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
  assert.ok(bootstrap.calls.toasts.some(message => message.includes('invalid or unsupported segment(s) removed')));
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
  assert.ok(bootstrap.calls.toasts.some(message => message.includes('invalid or unsupported segment(s) skipped')));
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
    is_movie: true,
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

test('a captured extra scene excludes the entire movie from export and submission', async () => {
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
    segment_type: 'post-credits',
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

  await bootstrap.submitToIntroDB();
  assert.equal(bootstrap.calls.previews.length, 1);
  assert.equal(bootstrap.calls.previews[0].items.length, 0);
  assert.equal(bootstrap.calls.previews[0].onConfirm, undefined);
  assert.equal(bootstrap.calls.submissions.length, 0);
  assert.ok(bootstrap.calls.toasts.some(message => message.includes('entire movie temporarily excluded')));
});

test('movie export enforces documented segment types and inclusive duration limits', async () => {
  const rows = [
    ['outro', 5], ['outro', 900], ['post-credits', 5], ['post-credits', 600],
    ['outro', 901], ['post-credits', 601], ['post-credits', 4], ['intro', 30],
  ].map(([segment_type, duration], index) => ({ imdb_id: `tt123456${index}`,  media_type: 'movie', segment_type, start_sec: 100, end_sec: 100 + duration }));
  const bootstrap = loadBootstrap({ stateOverrides: { allItems: rows, tvdbApiKey: '' } });
  await bootstrap.exportJSON();
  assert.deepEqual(JSON.parse(JSON.stringify(bootstrap.calls.previews[0].items)), rows.slice(0, 2).map(({ media_type, ...row }) => ({ ...row, is_movie: true })));
  assert.equal(bootstrap.calls.map.length, 0);
});

test('an existing scene blocks even a full movie outro', async () => {
  const existing = new Set(['post-credits']);
  existing.rangesByType = new Map([['post-credits', [{ startSec: 5600, endSec: 5700 }]]]);
  const bootstrap = loadBootstrap({ stateOverrides: { tvdbApiKey: '', allItems: [
    { media_type: 'movie', imdb_id: 'tt1234567', segment_type: 'outro', start_sec: 5400, end_sec: 6000 },
  ] }, existingSegmentsByKey: new Map([['tt1234567|movie', existing]]) });
  await bootstrap.exportJSON();
  await bootstrap.submitToIntroDB();
  assert.equal(bootstrap.calls.previews.length, 1);
  assert.equal(bootstrap.calls.previews[0].items.length, 0);
  assert.equal(bootstrap.calls.previews[0].onConfirm, undefined);
  assert.equal(bootstrap.calls.submissions.length, 0);
  assert.equal(bootstrap.calls.confirmations.length, 0);
});

test('scene presence without ranges excludes only the matching movie', async () => {
  const rows = ['tt1234567', 'tt1234568'].map(imdb_id => ({
    media_type: 'movie', imdb_id, segment_type: 'outro', start_sec: 5400, end_sec: 6000,
  }));
  const bootstrap = loadBootstrap({ stateOverrides: { tvdbApiKey: '', allItems: rows },
    existingSegmentsByKey: new Map([['tt1234567|movie', new Set(['post-credits'])]]) });
  await bootstrap.exportJSON();
  assert.deepEqual(Array.from(bootstrap.calls.previews[0].items, item => item.imdb_id), ['tt1234568']);
});

test('a scene removed by duration validation still excludes its movie', async () => {
  const bootstrap = loadBootstrap({ stateOverrides: { tvdbApiKey: '', allItems: [
    { media_type: 'movie', imdb_id: 'tt1234567', segment_type: 'outro', start_sec: 5400, end_sec: 6000 },
    { media_type: 'movie', imdb_id: 'tt1234567', segment_type: 'post-credits', start_sec: 5700, end_sec: 5703 },
  ] } });
  await bootstrap.exportJSON();
  await bootstrap.submitToIntroDB();
  assert.equal(bootstrap.calls.previews.length, 1);
  assert.equal(bootstrap.calls.previews[0].items.length, 0);
  assert.equal(bootstrap.calls.previews[0].onConfirm, undefined);
  assert.equal(bootstrap.calls.submissions.length, 0);
});

for (const status of ['present', 'unavailable']) {
  test(`TMDB ${status} blocks movie export and upload`, async () => {
    const bootstrap = loadBootstrap({ tmdbResult: { status }, stateOverrides: { tvdbApiKey: '', allItems: [
      { media_type: 'movie', imdb_id: 'tt1234567', segment_type: 'outro', start_sec: 5400, end_sec: 6000 },
    ] } });
    await bootstrap.exportJSON();
    await bootstrap.submitToIntroDB();
    assert.equal(bootstrap.calls.previews.length, 1);
  assert.equal(bootstrap.calls.previews[0].items.length, 0);
  assert.equal(bootstrap.calls.previews[0].onConfirm, undefined);
    assert.equal(bootstrap.calls.submissions.length, 0);
    assert.equal(bootstrap.calls.confirmations.length, 0);
  });
}
