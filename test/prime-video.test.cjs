const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));

function loadPrimeVideoExtractor(document) {
  const state = {
    allItems: [],
    imdbId: '',
    imdbIdsByShowId: {},
    showTitle: '',
    showId: null,
    providerEpisodes: [],
  };
  const detectedShows = [];
  const logs = [];
  let source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'providers', 'prime-video', 'extractor.js'),
    'utf8'
  )
    .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
    .replace(/\bexport\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/g, '');
  source += '\nglobalThis.primeExports = { extractPrimeVideoTitleId, processPrimeVideoMetadata, readPrimeVideoPlayerSnapshot, rememberPrimeVideoEpisodeSelection, scanPrimeVideoEpisodeCatalog };';

  const context = vm.createContext({
    state,
    document,
    location: document.location,
    atob(value) {
      return Buffer.from(value, 'base64').toString('utf8');
    },
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
    setTimeout() {},
  });
  vm.runInContext(source, context, { filename: 'prime-video-extractor.js' });
  return { ...context.primeExports, state, detectedShows, logs };
}

function attributeElement(attributes = {}, extras = {}) {
  return {
    ...extras,
    getAttribute(name) {
      return attributes[name] ?? null;
    },
  };
}

function episodeCard(number, title, titleId, detailId = '') {
  const heading = { textContent: `${number}. ${title}` };
  const selector = attributeElement({ id: `selector-${titleId}` }, { id: `selector-${titleId}` });
  const returnUrl = detailId
    ? Buffer.from(`/-/nl/region/eu/detail/${detailId}`).toString('base64')
    : '';
  const link = attributeElement({ href: `/-/nl/signup?return_url=${encodeURIComponent(returnUrl)}` });
  return {
    querySelector(css) {
      if (css === 'h3') return heading;
      if (css === 'input[id^="selector-"]') return selector;
      if (css === 'a[href*="return_url="]' && returnUrl) return link;
      return null;
    },
  };
}

function primeDetailDocument() {
  const ids = [
    'amzn1.dv.gti.aa66d181-e4ed-481f-9cdf-9c5ddf5f5793',
    'amzn1.dv.gti.20e0d618-3103-492b-81e4-7d5b0995f2a1',
  ];
  const seasonSelector = attributeElement({
    'aria-label': 'Season selector. Season 2 is selected',
  });
  const logo = attributeElement({ alt: 'Example Series' });
  const heading = {
    textContent: '',
    querySelector(css) {
      return css === 'img[alt]' ? logo : null;
    },
  };
  const cards = [
    episodeCard(3, 'The Arrival', ids[0]),
    episodeCard(4, 'The Choice', ids[1]),
  ];
  return {
    ids,
    document: {
      title: 'Prime Video: Example Series',
      querySelector(css) {
        if (css === '#av-droplist-av-atf-season-selector') return seasonSelector;
        if (css === 'main h1') return heading;
        return null;
      },
      querySelectorAll() {
        return cards;
      },
      getElementById() {
        return null;
      },
    },
  };
}

test('recognizes current Prime Video GTI identifiers in requests', () => {
  const { document, ids } = primeDetailDocument();
  const prime = loadPrimeVideoExtractor(document);

  assert.equal(
    prime.extractPrimeVideoTitleId('', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(ids[0])}`),
    ids[0]
  );
  assert.equal(prime.extractPrimeVideoTitleId(JSON.stringify({ contentId: ids[1] }), ''), ids[1]);
  assert.equal(prime.extractPrimeVideoTitleId('', 'https://example.test/GetVodPlaybackResources?asin=B012345678'), 'B012345678');
});

test('caches current Prime episode cards before playback', () => {
  const { document, ids } = primeDetailDocument();
  const prime = loadPrimeVideoExtractor(document);

  assert.equal(prime.scanPrimeVideoEpisodeCatalog(), 2);
  assert.deepEqual(plain([...prime.state.primeVideoTitleMap.entries()]), [
    [ids[0], { season: 2, episode: 3, episodeTitle: 'The Arrival', showId: 'Example Series' }],
    [ids[1], { season: 2, episode: 4, episodeTitle: 'The Choice', showId: 'Example Series' }],
  ]);
  assert.deepEqual(plain(prime.state.providerEpisodes), [
    { providerId: ids[0], season: 2, episode: 3, title: 'The Arrival' },
    { providerId: ids[1], season: 2, episode: 4, title: 'The Choice' },
  ]);
  assert.deepEqual(plain(prime.detectedShows), [{ title: 'Example Series', showId: 'Example Series' }]);
});

test('uses a cached GTI to attach playback timestamps to the right episode', () => {
  const { document, ids } = primeDetailDocument();
  const prime = loadPrimeVideoExtractor(document);
  prime.scanPrimeVideoEpisodeCatalog();

  prime.processPrimeVideoMetadata({
    transitionTimecodes: {
      result: {
        events: [
          { eventType: 'SKIP_RECAP', startTimeMs: 0, endTimeMs: 12500 },
          { eventType: 'SKIP_INTRO', startTimeMs: 12500, endTimeMs: 88000 },
        ],
      },
    },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(ids[0])}`);

  assert.deepEqual(plain(prime.state.allItems.map(item => ({
    showId: item._showId,
    title: item._episodeTitle,
    type: item.segment_type,
    season: item.season,
    episode: item.episode,
    start: item.start_sec,
    end: item.end_sec,
  }))), [
    { showId: 'Example Series', title: 'The Arrival', type: 'recap', season: 2, episode: 3, start: 0, end: 12.5 },
    { showId: 'Example Series', title: 'The Arrival', type: 'intro', season: 2, episode: 3, start: 12.5, end: 88 },
  ]);
  assert.deepEqual(plain(prime.logs), [[
    '[PVE] Captured timestamps · Example Series · S02E03',
    {
      title: 'The Arrival',
      titleId: ids[0],
      segments: [
        { type: 'recap', start: '00:00.000', end: '00:12.500', start_sec: 0, end_sec: 12.5 },
        { type: 'intro', start: '00:12.500', end: '01:28.000', start_sec: 12.5, end_sec: 88 },
      ],
    },
  ]]);
});

test('reads season and episode from the current generic player metadata', () => {
  const metadataNode = attributeElement({ 'aria-label': 'Season 3 Episode 7 - The Visitor' }, {
    textContent: '',
    querySelector() {
      return null;
    },
  });
  const player = {
    offsetWidth: 1280,
    offsetHeight: 720,
    textContent: '',
    querySelectorAll() {
      return [metadataNode];
    },
    querySelector() {
      return null;
    },
  };
  const document = {
    title: 'Prime Video: Example Series Season 3',
    getElementById(id) {
      return id === 'dv-web-player' ? player : null;
    },
    querySelector() {
      return null;
    },
  };
  const prime = loadPrimeVideoExtractor(document);

  assert.deepEqual(plain(prime.readPrimeVideoPlayerSnapshot()), {
    isPlayerActive: true,
    season: 3,
    episode: 7,
    title: 'Prime Video: Example Series Season 3',
    episodeTitle: 'The Visitor',
  });
});

test('maps a single-season playable GTI through its current episode detail URL', () => {
  const catalogId = 'amzn1.dv.gti.f86ceb23-af32-4492-a2b7-ca3f7acd56e2';
  const playbackId = 'amzn1.dv.gti.20e0d618-3103-492b-81e4-7d5b0995f2a1';
  const detailId = '0TV2PUCPJXDKZGGBPN8PUABM5E';
  const logo = attributeElement({ alt: 'Undercover Lover' });
  const heading = {
    textContent: '',
    querySelector(css) {
      return css === 'img[alt]' ? logo : null;
    },
  };
  const document = {
    title: 'Prime Video: Undercover Lover - Seizoen 1',
    location: { href: `https://www.primevideo.com/-/nl/region/eu/detail/${detailId}` },
    querySelector(css) {
      if (css === 'main h1') return heading;
      return null;
    },
    querySelectorAll() {
      return [episodeCard(1, 'Aflevering 1', catalogId, detailId)];
    },
    getElementById() {
      return null;
    },
  };
  const prime = loadPrimeVideoExtractor(document);

  assert.equal(prime.scanPrimeVideoEpisodeCatalog(), 1);
  assert.deepEqual(plain(prime.state.primeVideoDetailMap.get(detailId)), {
    season: 1,
    episode: 1,
    episodeTitle: 'Aflevering 1',
    showId: 'Undercover Lover',
    seriesTitle: 'Undercover Lover',
  });

  prime.processPrimeVideoMetadata({
    transitionTimecodes: {
      result: { events: [{ eventType: 'SKIP_INTRO', startTimeMs: 15000, endTimeMs: 75000 }] },
    },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(playbackId)}`);

  assert.deepEqual(plain(prime.state.allItems.map(item => ({
    type: item.segment_type,
    season: item.season,
    episode: item.episode,
    title: item._episodeTitle,
  }))), [{ type: 'intro', season: 1, episode: 1, title: 'Aflevering 1' }]);
});

test('maps a playable GTI through the episode card selected immediately before playback', () => {
  const catalogId = 'amzn1.dv.gti.f86ceb23-af32-4492-a2b7-ca3f7acd56e2';
  const playbackId = 'amzn1.dv.gti.b6b20f6f-f428-4a57-a606-e7918dde3bb5';
  const card = episodeCard(4, 'Aflevering 4', catalogId);
  const heading = {
    textContent: 'Undercover Lover',
    querySelector() {
      return null;
    },
  };
  const document = {
    title: 'Prime Video: Undercover Lover - Seizoen 1',
    location: { href: 'https://www.primevideo.com/region/eu/detail/0P65LWGA4TQ3YKUU0M0STU09PD' },
    querySelector(css) {
      if (css === 'main h1') return heading;
      return null;
    },
    querySelectorAll() {
      return [card];
    },
    getElementById() {
      return null;
    },
  };
  const prime = loadPrimeVideoExtractor(document);

  assert.equal(prime.rememberPrimeVideoEpisodeSelection(card), true);
  prime.processPrimeVideoMetadata({
    transitionTimecodes: {
      result: { events: [{ eventType: 'SKIP_RECAP', startTimeMs: 0, endTimeMs: 10000 }] },
    },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(playbackId)}`);

  assert.deepEqual(plain(prime.state.allItems.map(item => ({
    type: item.segment_type,
    season: item.season,
    episode: item.episode,
    title: item._episodeTitle,
  }))), [{ type: 'recap', season: 1, episode: 4, title: 'Aflevering 4' }]);
});

test('uses the NEXT_UP response timecode as an outro without playing to the end', () => {
  const { document, ids } = primeDetailDocument();
  const prime = loadPrimeVideoExtractor(document);
  prime.scanPrimeVideoEpisodeCatalog();

  prime.processPrimeVideoMetadata({
    transitionTimecodes: {
      result: {
        events: [
          { eventType: 'SKIP_INTRO', startTimeMs: 15000, endTimeMs: 75000 },
          { eventType: 'NEXT_UP', startTimeMs: '2905250', endTimeMs: '3156000' },
        ],
      },
    },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(ids[0])}`);

  assert.deepEqual(plain(prime.state.allItems.map(item => ({
    type: item.segment_type,
    start: item.start_sec,
    end: item.end_sec,
  }))), [
    { type: 'intro', start: 15, end: 75 },
    { type: 'outro', start: 2905.25, end: 3156 },
  ]);
});

test('uses response runtime when NEXT_UP only supplies its start time', () => {
  const { document, ids } = primeDetailDocument();
  const prime = loadPrimeVideoExtractor(document);
  prime.scanPrimeVideoEpisodeCatalog();

  prime.processPrimeVideoMetadata({
    catalogMetadata: { playback: { runtimeSeconds: '3156' } },
    transitionTimecodes: {
      result: {
        events: [{ eventType: 'NEXT_UP', startTimeMs: '2905250' }],
      },
    },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(ids[0])}`);

  assert.deepEqual(plain(prime.state.allItems.map(item => ({
    type: item.segment_type,
    start: item.start_sec,
    end: item.end_sec,
  }))), [{ type: 'outro', start: 2905.25, end: 3156 }]);
});

test('uses the already-known media duration when NEXT_UP omits its end time', () => {
  const { document, ids } = primeDetailDocument();
  const originalQuerySelectorAll = document.querySelectorAll.bind(document);
  document.querySelectorAll = css => css === '#dv-web-player video, [id^="dv-web-player"] video, video'
    ? [{ duration: 3156 }]
    : originalQuerySelectorAll(css);
  const prime = loadPrimeVideoExtractor(document);
  prime.scanPrimeVideoEpisodeCatalog();

  prime.processPrimeVideoMetadata({
    transitionTimecodes: {
      result: {
        events: [{ eventType: 'NEXT_UP', startTimeMs: 2905250 }],
      },
    },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(ids[0])}`);

  assert.deepEqual(plain(prime.state.allItems.map(item => ({
    type: item.segment_type,
    start: item.start_sec,
    end: item.end_sec,
  }))), [{ type: 'outro', start: 2905.25, end: 3156 }]);
});

test('derives exact duration from Prime elapsed and remaining player clocks', () => {
  const { document, ids } = primeDetailDocument();
  const prime = loadPrimeVideoExtractor(document);
  prime.scanPrimeVideoEpisodeCatalog();
  const originalQuerySelectorAll = document.querySelectorAll.bind(document);
  document.querySelectorAll = css => {
    if (css === '#dv-web-player video, [id^="dv-web-player"] video, video') return [];
    if (css.includes('.atvwebplayersdk-timeindicator-text')) {
      return [attributeElement({ 'aria-label': '' }, { textContent: '48:25 / 04:11' })];
    }
    return originalQuerySelectorAll(css);
  };

  prime.processPrimeVideoMetadata({
    transitionTimecodes: {
      result: {
        events: [{ eventType: 'NEXT_UP', startTimeMs: 2905250 }],
      },
    },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(ids[0])}`);

  assert.deepEqual(plain(prime.state.allItems.map(item => ({
    type: item.segment_type,
    start: item.start_sec,
    end: item.end_sec,
  }))), [{ type: 'outro', start: 2905.25, end: 3156 }]);
});

test('prefers END_CREDITS over NEXT_UP when Prime supplies both outro timecodes', () => {
  const { document, ids } = primeDetailDocument();
  const prime = loadPrimeVideoExtractor(document);
  prime.scanPrimeVideoEpisodeCatalog();

  prime.processPrimeVideoMetadata({
    transitionTimecodes: {
      result: {
        events: [
          { eventType: 'NEXT_UP', startTimeMs: 2920000, endTimeMs: 3156000 },
          { eventType: 'END_CREDITS', startTimeMs: 2900000, endTimeMs: 3156000 },
        ],
      },
    },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(ids[0])}`);

  assert.deepEqual(plain(prime.state.allItems.map(item => ({
    type: item.segment_type,
    start: item.start_sec,
    end: item.end_sec,
  }))), [{ type: 'outro', start: 2900, end: 3156 }]);
});
