const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));

function loadPrimeVideoExtractor(document, { deferTimers = false } = {}) {
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
  const timers = new Map();
  let nextTimerId = 1;
  let source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'providers', 'prime-video', 'extractor.js'),
    'utf8'
  )
    .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
    .replace(/\bexport\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/g, '');
  source += '\nglobalThis.primeExports = { extractPrimeVideoTitleId, processPrimeVideoMetadata, readPrimeVideoPlayerSnapshot, rememberPrimeVideoEpisodeSelection, scanPrimeVideoEpisodeCatalog, preloadPrimeVideoSeasonCatalogs };';

  const contextValues = {
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
    setTimeout(callback) {
      if (!deferTimers) return 0;
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    URL,
  };
  if (deferTimers) contextValues.window = {};
  const context = vm.createContext(contextValues);
  vm.runInContext(source, context, { filename: 'prime-video-extractor.js' });
  return {
    ...context.primeExports,
    state,
    detectedShows,
    logs,
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach(callback => callback());
    },
  };
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

test('preloads episode titles from every season link with the same card scanner', async () => {
  const { document } = primeDetailDocument();
  document.location = {
    href: 'https://www.primevideo.com/region/eu/detail/0RTZ57DQ6PBHH29UN5JS7U7CW4?ref_=atv_dp_season_select_s1',
  };
  const seasonTwoHref = '/-/nl/region/eu/detail/0PW27PB7O60V7NZOIXFYF68ZG8?ref_=atv_dp_season_select_s2';
  const seasonLink = attributeElement({ href: seasonTwoHref });
  const originalQuerySelectorAll = document.querySelectorAll.bind(document);
  document.querySelectorAll = css => css === 'a[href*="atv_dp_season_select_s"]'
    ? [seasonLink]
    : originalQuerySelectorAll(css);

  const seasonTwoIds = [
    'amzn1.dv.gti.061bcbdc-706b-449f-9a7b-cfff8ce622fa',
    'amzn1.dv.gti.24421417-1dc8-44a7-bcf8-1f3bcbf10b1c',
  ];
  const seasonTwoDocument = {
    title: 'Prime Video: Example Series - Season 2',
    querySelector(css) {
      if (css === '#av-droplist-av-atf-season-selector') {
        return attributeElement({ 'aria-label': 'Season selector. Season 2 is selected' });
      }
      if (css === 'main h1') return { textContent: 'Example Series' };
      return null;
    },
    querySelectorAll() {
      return [
        episodeCard(1, 'ATM', seasonTwoIds[0]),
        episodeCard(2, 'What Happens in Atlantic City', seasonTwoIds[1]),
      ];
    },
  };
  const requests = [];
  const prime = loadPrimeVideoExtractor(document);

  const found = await prime.preloadPrimeVideoSeasonCatalogs(document, {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, text: async () => '<html></html>' };
    },
    parseHtml: () => seasonTwoDocument,
  });

  assert.equal(found, 2);
  assert.deepEqual(plain(requests), [{
    url: `https://www.primevideo.com${seasonTwoHref}`,
    options: { credentials: 'same-origin' },
  }]);
  assert.deepEqual(plain(seasonTwoIds.map(id => prime.state.primeVideoTitleMap.get(id))), [
    { season: 2, episode: 1, episodeTitle: 'ATM', showId: 'Example Series' },
    { season: 2, episode: 2, episodeTitle: 'What Happens in Atlantic City', showId: 'Example Series' },
  ]);
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

test('does not reuse stale click or detail metadata when autoplay crosses into a new season', () => {
  const catalogId = 'amzn1.dv.gti.f86ceb23-af32-4492-a2b7-ca3f7acd56e2';
  const firstPlaybackId = 'amzn1.dv.gti.b6b20f6f-f428-4a57-a606-e7918dde3bb5';
  const secondPlaybackId = 'amzn1.dv.gti.20e0d618-3103-492b-81e4-7d5b0995f2a1';
  const detailId = '0P65LWGA4TQ3YKUU0M0STU09PD';
  const card = episodeCard(8, 'Season finale', catalogId, detailId);
  const heading = {
    textContent: 'Example Series',
    querySelector() {
      return null;
    },
  };
  let playerText = 'S1 E8 - Season finale';
  const player = {
    offsetWidth: 1280,
    offsetHeight: 720,
    get textContent() {
      return playerText;
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
  };
  const document = {
    title: 'Prime Video: Example Series - Season 1',
    location: { href: `https://www.primevideo.com/region/eu/detail/${detailId}` },
    querySelector(css) {
      if (css === '#av-droplist-av-atf-season-selector') {
        return attributeElement({ 'aria-label': 'Season selector. Season 1 is selected' });
      }
      if (css === 'main h1') return heading;
      return null;
    },
    querySelectorAll(css) {
      if (css === '[data-testid="episode-list-item"], li[id^="av-ep-episode-"]') return [card];
      return [];
    },
    getElementById(id) {
      return id === 'dv-web-player' ? player : null;
    },
  };
  const prime = loadPrimeVideoExtractor(document, { deferTimers: true });
  const payload = (startTimeMs, endTimeMs) => ({
    transitionTimecodes: {
      result: { events: [{ eventType: 'SKIP_INTRO', startTimeMs, endTimeMs }] },
    },
  });

  prime.scanPrimeVideoEpisodeCatalog();
  assert.equal(prime.rememberPrimeVideoEpisodeSelection(card), true);
  prime.processPrimeVideoMetadata(
    payload(1000, 11000),
    '',
    `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(firstPlaybackId)}`
  );
  prime.runTimers();

  prime.processPrimeVideoMetadata(
    payload(2000, 12000),
    '',
    `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(secondPlaybackId)}`
  );
  assert.equal(prime.state.allItems.length, 1);

  playerText = 'S2 E1 - A new beginning';
  document.title = 'Prime Video: Example Series - Season 2';
  prime.runTimers();
  prime.runTimers();

  assert.deepEqual(plain(prime.state.allItems.map(item => ({
    season: item.season,
    episode: item.episode,
    title: item._episodeTitle,
    start: item.start_sec,
    end: item.end_sec,
  }))), [
    { season: 1, episode: 8, title: 'Season finale', start: 1, end: 11 },
    { season: 2, episode: 1, title: '', start: 2, end: 12 },
  ]);
  assert.equal(prime.state.primeVideoTitleMap.get(secondPlaybackId).season, 2);
  assert.equal(prime.state.primeVideoTitleMap.get(secondPlaybackId).episode, 1);
});

test('infers S02E01 after the last scanned episode and ignores non-segment season resources', () => {
  const { document, ids } = primeDetailDocument();
  const lastSeasonOneId = 'amzn1.dv.gti.434853c4-dd86-4b46-a02c-44a443cc5f51';
  const seasonTwoEpisodeOneId = 'amzn1.dv.gti.061bcbdc-706b-449f-9a7b-cfff8ce622fa';
  const seasonTwoEpisodeTwoId = 'amzn1.dv.gti.24421417-1dc8-44a7-bcf8-1f3bcbf10b1c';
  const seasonResourceId = 'amzn1.dv.gti.d62095f9-f33c-429b-a8a6-fd74c0461704';
  let selectedSeason = 1;
  let cards = [episodeCard(7, 'Reacher Said Nothing', ids[0]), episodeCard(8, 'Pie', lastSeasonOneId)];
  const originalQuerySelector = document.querySelector.bind(document);
  document.querySelector = css => css === '#av-droplist-av-atf-season-selector'
    ? attributeElement({ 'aria-label': `Season selector. Season ${selectedSeason} is selected` })
    : originalQuerySelector(css);
  document.querySelectorAll = css => css === '[data-testid="episode-list-item"], li[id^="av-ep-episode-"]'
    ? cards
    : [];
  const prime = loadPrimeVideoExtractor(document);
  prime.scanPrimeVideoEpisodeCatalog();

  prime.processPrimeVideoMetadata({
    transitionTimecodes: { result: { events: [{ eventType: 'END_CREDITS', startTimeMs: 3000000, endTimeMs: 3200000 }] } },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(lastSeasonOneId)}`);
  prime.processPrimeVideoMetadata({
    transitionTimecodes: { result: { events: [{ eventType: 'END_CREDITS', startTimeMs: 2400000, endTimeMs: 2600000 }] } },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(ids[0])}`);
  prime.processPrimeVideoMetadata({
    catalogMetadata: { catalog: { type: 'EPISODE', title: 'ATM' } },
    transitionTimecodes: { result: { events: [] } },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(seasonTwoEpisodeOneId)}`);
  prime.processPrimeVideoMetadata({
    transitionTimecodes: { result: { events: [{ eventType: 'SKIP_RECAP', startTimeMs: 6000, endTimeMs: 68000 }] } },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(seasonTwoEpisodeOneId)}`);
  prime.processPrimeVideoMetadata({
    catalogMetadata: { catalog: { title: 'Reacher Season 1' } },
    transitionTimecodes: { result: { events: [] } },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(seasonResourceId)}`);

  assert.deepEqual(plain(prime.state.primeVideoTitleMap.get(seasonTwoEpisodeOneId)), {
    season: 2,
    episode: 1,
    episodeTitle: 'ATM',
    showId: 'Example Series',
  });
  assert.equal(prime.state.primeVideoPendingByTitleId.has(seasonResourceId), false);
  assert.equal(prime.state.primeVideoPollingTitleIds.has(seasonResourceId), false);

  prime.processPrimeVideoMetadata({
    transitionTimecodes: { result: { events: [{ eventType: 'SKIP_INTRO', startTimeMs: 10000, endTimeMs: 70000 }] } },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(seasonTwoEpisodeTwoId)}`);
  prime.processPrimeVideoMetadata({
    catalogMetadata: { catalog: { type: 'EPISODE', title: 'What Happens in Atlantic City' } },
    transitionTimecodes: { result: { events: [] } },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(seasonTwoEpisodeTwoId)}`);
  assert.equal(prime.state.primeVideoTitleMap.get(seasonTwoEpisodeTwoId).episodeTitle, 'What Happens in Atlantic City');
  assert.equal(prime.state.allItems.find(item => item._eid.startsWith(seasonTwoEpisodeTwoId))._episodeTitle, 'What Happens in Atlantic City');

  selectedSeason = 2;
  cards = [episodeCard(1, 'ATM', 'amzn1.dv.gti.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')];
  prime.scanPrimeVideoEpisodeCatalog();
  assert.equal(prime.state.primeVideoTitleMap.get(seasonTwoEpisodeOneId).episodeTitle, 'ATM');
  assert.equal(prime.state.allItems.find(item => item._eid.startsWith(seasonTwoEpisodeOneId))._episodeTitle, 'ATM');
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

test('batches Prime segments arriving in separate playback responses', () => {
  const { document, ids } = primeDetailDocument();
  const prime = loadPrimeVideoExtractor(document, { deferTimers: true });
  prime.scanPrimeVideoEpisodeCatalog();

  prime.processPrimeVideoMetadata({
    transitionTimecodes: {
      result: { events: [{ eventType: 'NEXT_UP', startTimeMs: 3229000, endTimeMs: 3701000 }] },
    },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(ids[0])}`);
  prime.processPrimeVideoMetadata({
    transitionTimecodes: {
      result: { events: [{ eventType: 'SKIP_RECAP', startTimeMs: 0, endTimeMs: 73000 }] },
    },
  }, '', `https://example.test/GetVodPlaybackResources?titleId=${encodeURIComponent(ids[0])}`);

  assert.equal(prime.state.allItems.length, 0);
  prime.runTimers();
  assert.deepEqual(plain(prime.state.allItems.map(item => ({
    type: item.segment_type,
    start: item.start_sec,
    end: item.end_sec,
  }))), [
    { type: 'outro', start: 3229, end: 3701 },
    { type: 'recap', start: 0, end: 73 },
  ]);
  assert.equal(prime.logs.length, 1);
  assert.equal(prime.logs[0][1].segments.length, 2);
});
