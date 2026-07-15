const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadTvdb({ searchIds = ['101'], episodes = [], translations = {} } = {}) {
  const storage = new Map();
  const requests = [];
  const logs = [];
  const state = { tvdbApiKey: 'test-api-key', tvdbPin: 'test-pin', providerEpisodes: [] };
  let source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'tvdb.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  source += '\nglobalThis.tvdbExports = { mapSeriesItemsToTvdb, loadTvdbSettings, saveTvdbSettings, fetchTvdbEpisodeList };';

  const testConsole = {
    ...console,
    info: (...args) => logs.push(args),
  };

  const context = vm.createContext({
    state,
    URL,
    console: testConsole,
    GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
    GM_setValue: (key, value) => storage.set(key, value),
    GM_xmlhttpRequest: options => {
      requests.push({ method: options.method, url: options.url });
      let body;
      if (options.url.endsWith('/login')) {
        assert.deepEqual(JSON.parse(options.data), { apikey: state.tvdbApiKey, pin: state.tvdbPin });
        body = { data: { token: 'local-test-token' } };
      } else if (options.url.includes('/search/remoteid/')) {
        body = { data: searchIds.map(id => ({ series: { id } })) };
      } else if (options.url.endsWith('/series/101/episodes/default/eng?page=0') ||
        options.url.endsWith('/series/101/episodes/default/spa?page=0')) {
        body = { data: { series: { episodes } } };
      } else if (/\/episodes\/[^/]+\/translations\/[^/]+$/.test(options.url)) {
        const [, episodeId, language] = options.url.match(/\/episodes\/([^/]+)\/translations\/([^/]+)$/);
        const original = episodes.find(episode => String(episode.id) === decodeURIComponent(episodeId));
        body = { data: translations[decodeURIComponent(episodeId)] || {
          name: original?.name || '',
          language: decodeURIComponent(language),
        } };
      } else {
        throw new Error(`Unexpected request: ${options.url}`);
      }
      queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify(body) }));
    },
    queueMicrotask,
  });
  vm.runInContext(source, context, { filename: 'tvdb.js' });
  return { ...context.tvdbExports, requests, logs, state, storage };
}

function segment(season, episode, title = '') {
  return {
    _eid: `${season}-${episode}`,
    _episodeTitle: title,
    imdb_id: 'tt1234567',
    segment_type: 'intro',
    season,
    episode,
    start_sec: 1,
    end_sec: 2,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('excludes both Season 0 catalogs and maps equal regular counts by order', async () => {
  const tvdb = loadTvdb({ episodes: [
    { id: 90, seasonNumber: 0, number: 1, name: 'Special' },
    { id: 11, seasonNumber: 1, number: 1, name: 'First' },
    { id: 12, seasonNumber: 1, number: 2, name: 'Second' },
  ] });
  const result = await tvdb.mapSeriesItemsToTvdb(
    [segment(0, 1, 'Special'), segment(3, 7, 'First'), segment(3, 8, 'Second')],
    [
      { providerId: 's', season: 0, episode: 1, title: 'Special' },
      { providerId: 'a', season: 3, episode: 7, title: 'First' },
      { providerId: 'b', season: 3, episode: 8, title: 'Second' },
    ],
  );

  assert.equal(result.success, true);
  assert.equal(result.method, 'order');
  assert.deepEqual(plain(result.items.map(item => [item.season, item.episode])), [[1, 1], [1, 2]]);
  assert.deepEqual(plain(result.stats), {
    providerRegular: 2,
    tvdbRegular: 2,
    providerSpecialsExcluded: 1,
    tvdbSpecialsExcluded: 1,
    capturedSpecialsExcluded: 1,
    regularEpisodesMatched: 2,
    regularEpisodesSkipped: 0,
    regularEpisodeSkipReasons: {},
    capturedRegularSegmentsMatched: 2,
    capturedRegularSegmentsSkipped: 0,
  });
});

test('uses exact normalized one-to-one titles only when regular counts differ', async () => {
  const tvdb = loadTvdb({ episodes: [
    { id: 11, seasonNumber: 1, number: 1, name: 'Caf\u00e9 & Friends!' },
    { id: 12, seasonNumber: 1, number: 2, name: 'Second' },
    { id: 13, seasonNumber: 1, number: 3, name: 'Uncaptured' },
  ] });
  const result = await tvdb.mapSeriesItemsToTvdb(
    [segment(4, 9, 'Cafe and Friends')],
    [
      { providerId: 'a', season: 4, episode: 9, title: 'Cafe and Friends' },
      { providerId: 'b', season: 4, episode: 10, title: 'Second' },
    ],
  );

  assert.equal(result.success, true);
  assert.equal(result.method, 'title');
  assert.deepEqual(plain(result.items.map(item => [item.season, item.episode])), [[1, 1]]);
});

test('keeps reliable title mappings when generic and unmatched provider titles are skipped', async () => {
  const tvdb = loadTvdb({ episodes: [
    { id: 11, seasonNumber: 1, number: 1, name: 'The Arrival' },
    { id: 12, seasonNumber: 1, number: 2, name: 'The Choice' },
    { id: 13, seasonNumber: 1, number: 3, name: 'TVDB Only' },
    { id: 14, seasonNumber: 1, number: 4, name: 'Another TVDB Episode' },
    { id: 15, seasonNumber: 1, number: 5, name: 'Final TVDB Episode' },
  ] });
  const result = await tvdb.mapSeriesItemsToTvdb(
    [
      segment(7, 1, 'Episode 1'),
      segment(7, 2, 'The Arrival'),
      segment(7, 3, 'Provider Only'),
      segment(7, 4, 'The Choice'),
    ],
    [
      { providerId: 'a', season: 7, episode: 1, title: 'Episode 1' },
      { providerId: 'b', season: 7, episode: 2, title: 'The Arrival' },
      { providerId: 'c', season: 7, episode: 3, title: 'Provider Only' },
      { providerId: 'd', season: 7, episode: 4, title: 'The Choice' },
    ],
  );

  assert.equal(result.success, true);
  assert.equal(result.method, 'title');
  assert.deepEqual(plain(result.items.map(item => [item.season, item.episode])), [[1, 1], [1, 2]]);
  assert.equal(result.stats.regularEpisodesMatched, 2);
  assert.equal(result.stats.regularEpisodesSkipped, 2);
  assert.deepEqual(plain(result.stats.regularEpisodeSkipReasons), { genericTitle: 1, noExactMatch: 1 });
  assert.equal(result.stats.capturedRegularSegmentsMatched, 2);
  assert.equal(result.stats.capturedRegularSegmentsSkipped, 2);
});

test('blocks count mismatches with missing, inexact, or ambiguous titles', async t => {
  const episodes = [
    { id: 11, seasonNumber: 1, number: 1, name: 'A New Hope Part One' },
    { id: 12, seasonNumber: 1, number: 2, name: 'Duplicate' },
    { id: 13, seasonNumber: 1, number: 3, name: 'Duplicate' },
  ];

  await t.test('missing title', async () => {
    const tvdb = loadTvdb({ episodes });
    const result = await tvdb.mapSeriesItemsToTvdb([segment(1, 1)], [{ season: 1, episode: 1, title: '' }]);
    assert.equal(result.success, false);
    assert.match(result.reason, /missing titles: 1/);
  });

  await t.test('similar but inexact title', async () => {
    const tvdb = loadTvdb({ episodes });
    const result = await tvdb.mapSeriesItemsToTvdb([segment(1, 1)], [{ season: 1, episode: 1, title: 'A New Hope Part 1' }]);
    assert.equal(result.success, false);
    assert.match(result.reason, /no exact normalized TVDB match: 1/);
  });

  await t.test('ambiguous title', async () => {
    const tvdb = loadTvdb({ episodes });
    const result = await tvdb.mapSeriesItemsToTvdb([segment(1, 1)], [{ season: 1, episode: 1, title: 'Duplicate' }]);
    assert.equal(result.success, false);
    assert.match(result.reason, /ambiguous TVDB titles: 1/);
  });
});

test('excludes explicitly flagged provider specials even outside Season 0', async () => {
  const tvdb = loadTvdb({ episodes: [{ id: 11, seasonNumber: 1, number: 1, name: 'Regular' }] });
  const result = await tvdb.mapSeriesItemsToTvdb(
    [segment(1, 1, 'Regular'), segment(9, 1, 'Bonus')],
    [
      { providerId: 'a', season: 1, episode: 1, title: 'Regular' },
      { providerId: 's', season: 9, episode: 1, title: 'Bonus', isSpecial: true },
    ],
  );

  assert.equal(result.success, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.stats.capturedSpecialsExcluded, 1);
});

test('rejects ambiguous IMDb-to-TVDB results and reuses a stored bearer token', async () => {
  const ambiguous = loadTvdb({ searchIds: ['101', '202'], episodes: [] });
  const rejected = await ambiguous.mapSeriesItemsToTvdb([segment(1, 1)], [{ season: 1, episode: 1, title: 'First' }]);
  assert.equal(rejected.success, false);
  assert.match(rejected.reason, /multiple TVDB series/);

  const tvdb = loadTvdb({ episodes: [{ id: 11, seasonNumber: 1, number: 1, name: 'First' }] });
  const items = [segment(1, 1, 'First')];
  const catalog = [{ season: 1, episode: 1, title: 'First' }];
  assert.equal((await tvdb.mapSeriesItemsToTvdb(items, catalog)).success, true);
  assert.equal((await tvdb.mapSeriesItemsToTvdb(items, catalog)).success, true);
  assert.equal(tvdb.requests.filter(request => request.url.endsWith('/login')).length, 1);
  assert.equal(tvdb.storage.get('segmentScraper.tvdb.token'), 'local-test-token');
  assert.equal(tvdb.requests.filter(request => request.url.endsWith('/series/101/episodes/default/eng?page=0')).length, 1);
});

test('sends language on the episode list request and separates cached responses by language', async () => {
  const tvdb = loadTvdb({ episodes: [{ id: 11, seasonNumber: 1, number: 1, name: 'First' }] });

  await tvdb.fetchTvdbEpisodeList('101', 'eng');
  await tvdb.fetchTvdbEpisodeList('101', 'eng');
  await tvdb.fetchTvdbEpisodeList('101', 'spa');

  assert.equal(tvdb.requests.filter(request => request.url.endsWith('/series/101/episodes/default/eng?page=0')).length, 1);
  assert.equal(tvdb.requests.filter(request => request.url.endsWith('/series/101/episodes/default/spa?page=0')).length, 1);
});

test('retries non-English episode names through the explicit English translation endpoint before matching', async () => {
  const tvdb = loadTvdb({
    episodes: [
      { id: 11, seasonNumber: 1, number: 1, name: 'La llegada' },
      { id: 12, seasonNumber: 1, number: 2, name: 'TVDB Only' },
    ],
    translations: {
      11: { name: 'The Arrival', language: 'eng' },
      12: { name: 'TVDB Only', language: 'eng' },
    },
  });
  const result = await tvdb.mapSeriesItemsToTvdb(
    [segment(1, 1, 'The Arrival')],
    [{ providerId: 'a', season: 1, episode: 1, title: 'The Arrival' }],
  );

  assert.equal(result.success, true);
  assert.equal(result.method, 'title');
  assert.deepEqual(plain(result.items.map(item => [item.season, item.episode])), [[1, 1]]);
  assert.equal(tvdb.requests.filter(request => request.url.endsWith('/episodes/11/translations/eng')).length, 1);
  assert.equal(tvdb.requests.filter(request => request.url.endsWith('/episodes/12/translations/eng')).length, 0);
  const audit = tvdb.logs.find(args => args[0] === '[TVDB] Series episode language audit');
  assert.equal(audit[1].requestedLanguage, 'eng');
  assert.match(audit[1].endpointUrlShape, /\/series\/\{seriesId\}\/episodes\/\{seasonType\}\/\{language\}\?page=\{page\}$/);
  assert.deepEqual(plain(audit[1].returnedEpisodeNameLanguages), { eng: 2 });
});

test('stores the user API key and optional PIN locally and clears an old token on change', () => {
  const tvdb = loadTvdb();
  tvdb.storage.set('segmentScraper.tvdb.token', 'old-token');
  tvdb.storage.set('segmentScraper.tvdb.tokenCreatedAt', 123);
  tvdb.saveTvdbSettings('  user-api-key  ', '  2468  ');

  assert.equal(tvdb.storage.get('segmentScraper.tvdb.apikey'), 'user-api-key');
  assert.equal(tvdb.storage.get('segmentScraper.tvdb.pin'), '2468');
  assert.equal(tvdb.storage.get('segmentScraper.tvdb.token'), '');
  assert.equal(tvdb.storage.get('segmentScraper.tvdb.tokenCreatedAt'), 0);
  tvdb.state.tvdbApiKey = '';
  tvdb.state.tvdbPin = '';
  assert.deepEqual(plain(tvdb.loadTvdbSettings()), { apiKey: 'user-api-key', pin: '2468' });
});
