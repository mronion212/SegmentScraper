const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));

function loadAppleTvExtractor() {
  const state = {
    allItems: [],
    imdbIdsByShowId: { 'umc.cmc.show123': 'tt1234567' },
    showTitle: '',
    showId: null,
    providerEpisodes: [],
  };
  const detectedShows = [];
  const logs = [];
  let source = [
    fs.readFileSync(path.join(__dirname, '..', 'src', 'providers', 'timestamp-logger.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'src', 'providers', 'apple-tv', 'extractor.js'), 'utf8'),
  ].join('\n')
    .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
    .replace(/\bexport\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/g, '');
  source += '\nglobalThis.appleTvExports = { parseAppleTvHlsMetadata, extractAppleTvMarkers, processAppleTvMetadata, processAppleTvHlsManifest };';

  const document = {
    title: 'Lucky - Apple TV',
    location: { href: 'https://tv.apple.com/nl/episode/geen-half-werk/umc.cmc.episode1?showId=umc.cmc.show123' },
    querySelector() { return null; },
  };
  const context = vm.createContext({
    state,
    document,
    location: document.location,
    URL,
    console: {
      info(...args) { logs.push(args); },
      warn() {},
      error() {},
    },
    handleDetectedShow(show) {
      detectedShows.push(show);
      state.showTitle = show.title;
      state.showId = show.showId;
    },
    recordExtractedSegments(items) {
      state.allItems.push(...items);
    },
    recordProviderEpisode(episode) {
      if (!state.providerEpisodes.some(item => item.providerId === episode.providerId)) {
        state.providerEpisodes.push(episode);
      }
    },
  });
  vm.runInContext(source, context, { filename: 'apple-tv-extractor.js' });
  return { ...context.appleTvExports, state, detectedShows, logs };
}

function sessionData(key, value) {
  return `#EXT-X-SESSION-DATA:DATA-ID="com.apple.hls.${key}",VALUE="${value}"`;
}

function luckyManifest() {
  return [
    '#EXTM3U',
    sessionData('skip.count', '2'),
    sessionData('skip.0.start', '0'),
    sessionData('skip.0.duration', '10'),
    sessionData('skip.0.target', '42.5'),
    sessionData('skip.0.label', 'Sla samenvatting over'),
    sessionData('skip.1.start', '42.5'),
    sessionData('skip.1.duration', '12'),
    sessionData('skip.1.target', '104.25'),
    sessionData('skip.1.label', 'Sla intro over'),
    sessionData('up-next.start', '2700'),
    sessionData('watched.time', '2780'),
  ].join('\n');
}

test('parses Apple HLS session data into recap, intro, and outro markers', () => {
  const apple = loadAppleTvExtractor();

  assert.deepEqual(plain(apple.parseAppleTvHlsMetadata(luckyManifest())), {
    'skip.count': '2',
    'skip.0.start': '0',
    'skip.0.duration': '10',
    'skip.0.target': '42.5',
    'skip.0.label': 'Sla samenvatting over',
    'skip.1.start': '42.5',
    'skip.1.duration': '12',
    'skip.1.target': '104.25',
    'skip.1.label': 'Sla intro over',
    'up-next.start': '2700',
    'watched.time': '2780',
  });
  assert.deepEqual(plain(apple.extractAppleTvMarkers(luckyManifest(), 2850)), [
    { type: 'recap', start: 0, end: 42.5, label: 'Sla samenvatting over' },
    { type: 'intro', start: 42.5, end: 104.25, label: 'Sla intro over' },
    { type: 'outro', start: 2700, end: 2850, label: 'up-next' },
  ]);
});

test('captures a whole Apple TV episode catalogue from one response', () => {
  const apple = loadAppleTvExtractor();
  const payload = {
    data: {
      episodes: [
        { id: 'umc.cmc.episode1', seasonNumber: 1, episodeNumber: 1, title: 'Geen half werk', duration: 2850 },
        { id: 'umc.cmc.episode2', seasonNumber: 1, episodeNumber: 2, title: 'Laat ze dansen', duration: 2881 },
      ],
      episodesPlayables: {
        'umc.cmc.episode1': { playableId: 'playable-1' },
        'umc.cmc.episode2': { playableId: 'playable-2' },
      },
      playables: {
        'playable-1': {
          id: 'playable-1',
          canonicalId: 'umc.cmc.episode1',
          duration: 2850,
          canonicalMetadata: { showTitle: 'Lucky', seasonNumber: 1, episodeNumber: 1, episodeTitle: 'Geen half werk' },
        },
        'playable-2': {
          id: 'playable-2',
          canonicalId: 'umc.cmc.episode2',
          duration: 2881,
          canonicalMetadata: { showTitle: 'Lucky', seasonNumber: 1, episodeNumber: 2, episodeTitle: 'Laat ze dansen' },
        },
      },
    },
  };

  assert.deepEqual(
    plain(apple.processAppleTvMetadata(payload, 'https://tv.apple.com/api/uts/v3/shows/umc.cmc.show123/episodes', 'umc.cmc.show123')),
    { episodeCount: 2, manifestCount: 0 }
  );
  assert.deepEqual(plain(apple.state.providerEpisodes), [
    { providerId: 'umc.cmc.episode1', season: 1, episode: 1, title: 'Geen half werk' },
    { providerId: 'umc.cmc.episode2', season: 1, episode: 2, title: 'Laat ze dansen' },
  ]);
  assert.deepEqual(plain(apple.detectedShows), [{ title: 'Lucky', showId: 'umc.cmc.show123' }]);
});

test('logs exact Apple TV timestamps in the same per-episode shape as Prime Video', () => {
  const apple = loadAppleTvExtractor();
  apple.processAppleTvMetadata({
    data: {
      episodes: [{ id: 'umc.cmc.episode1', seasonNumber: 1, episodeNumber: 1, title: 'Geen half werk', duration: 2850 }],
      episodesPlayables: { 'umc.cmc.episode1': { playableId: 'playable-1' } },
      playables: {
        'playable-1': {
          id: 'playable-1',
          canonicalId: 'umc.cmc.episode1',
          duration: 2850,
          canonicalMetadata: { showTitle: 'Lucky', seasonNumber: 1, episodeNumber: 1, episodeTitle: 'Geen half werk' },
        },
      },
    },
  }, '', 'umc.cmc.show123');

  assert.equal(apple.processAppleTvHlsManifest(luckyManifest()), 3);
  assert.deepEqual(plain(apple.state.allItems.map(item => ({
    showId: item._showId,
    title: item._episodeTitle,
    type: item.segment_type,
    season: item.season,
    episode: item.episode,
    start: item.start_sec,
    end: item.end_sec,
    imdb: item.imdb_id,
  }))), [
    { showId: 'umc.cmc.show123', title: 'Geen half werk', type: 'recap', season: 1, episode: 1, start: 0, end: 42.5, imdb: 'tt1234567' },
    { showId: 'umc.cmc.show123', title: 'Geen half werk', type: 'intro', season: 1, episode: 1, start: 42.5, end: 104.25, imdb: 'tt1234567' },
    { showId: 'umc.cmc.show123', title: 'Geen half werk', type: 'outro', season: 1, episode: 1, start: 2700, end: 2850, imdb: 'tt1234567' },
  ]);
  assert.deepEqual(plain(apple.logs), [[
    '[ATVE] Captured timestamps · Lucky · S01E01',
    {
      title: 'Geen half werk',
      canonicalId: 'umc.cmc.episode1',
      segments: [
        { type: 'recap', start: '00:00.000', end: '00:42.500', start_sec: 0, end_sec: 42.5 },
        { type: 'intro', start: '00:42.500', end: '01:44.250', start_sec: 42.5, end_sec: 104.25 },
        { type: 'outro', start: '45:00.000', end: '47:30.000', start_sec: 2700, end_sec: 2850 },
      ],
    },
  ]]);

  assert.equal(apple.processAppleTvHlsManifest(luckyManifest()), 0);
  assert.equal(apple.logs.length, 1);
});
