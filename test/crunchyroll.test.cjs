const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));

function loadCrunchyrollExtractor(globals = {}) {
  const state = {
    allItems: [],
    imdbIdsByShowId: {},
    providerEpisodes: [],
    providerEpisodesByShowId: {},
  };
  const detectedShows = [];
  const catalogs = [];
  let source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'providers', 'crunchyroll', 'extractor.js'),
    'utf8'
  )
    .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
    .replace(/\bexport\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/g, '');
  source += '\nglobalThis.crunchyrollExports = { getCrunchyrollWatchId, readCrunchyrollPageMetadata, processCrunchyrollEpisode, isCrunchyrollPlayerPage, setupCrunchyrollInterception };';

  const context = vm.createContext({
    state,
    console: { info() {}, warn() {}, error() {} },
    handleDetectedShow(show) {
      detectedShows.push(show);
      state.showId = show.showId;
      state.showTitle = show.title;
    },
    recordProviderEpisode(episode, showId) {
      catalogs.push({ episode, showId });
    },
    recordExtractedSegments(items) {
      state.allItems.push(...items);
    },
    createNormalizedSegment(params) {
      const types = { recap: 'recap', intro: 'intro', credits: 'outro' };
      const segmentType = types[params.providerSegmentType];
      if (!segmentType) return null;
      return {
        _eid: params.episodeId,
        _episodeTitle: params.episodeTitle,
        _showId: params.showId,
        imdb_id: params.imdbId,
        segment_type: segmentType,
        season: params.season,
        episode: params.episode,
        start_sec: params.startSec,
        end_sec: params.endSec,
      };
    },
    Set,
    ...globals,
  });
  vm.runInContext(source, context, { filename: 'crunchyroll-extractor.js' });
  return { ...context.crunchyrollExports, state, detectedShows, catalogs, context };
}

function crunchyrollDocument() {
  const structuredData = [
    {
      '@context': ['https://schema.org', { '@language': 'en-us' }],
      '@id': 'https://www.crunchyroll.com/watch/G7PU403GE/nopperabo',
      '@type': 'TVEpisode',
      datePublished: '2018-04-16T14:00:00.000Z',
      episodeNumber: 2,
      name: 'Golden Kamuy (English Dub) | E2 - Nopperabo',
      partOfSeason: {
        '@id': 'https://www.crunchyroll.com/series/GY8DWQN5Y/golden-kamuy',
        '@type': 'TVSeason',
        name: 'Golden Kamuy (English Dub)',
        seasonNumber: 1,
      },
      partOfSeries: {
        '@id': 'https://www.crunchyroll.com/series/GY8DWQN5Y/golden-kamuy',
        '@type': 'TVSeries',
        name: 'Golden Kamuy',
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: 'Nopperabo',
    },
  ];
  return {
    querySelectorAll(selector) {
      assert.equal(selector, 'script[type="application/ld+json"]');
      return structuredData.map(item => ({ textContent: JSON.stringify(item) }));
    },
    addEventListener() {},
  };
}

function skipEventsPayload() {
  return {
    intro: { end: 198, seriesId: 'GY8DWQN5Y', start: 109, type: 'intro' },
    credits: { end: 1444, seriesId: 'GY8DWQN5Y', start: 1349, type: 'credits' },
    preview: {},
    recap: {},
    mediaId: 'G4GFQZWG9',
  };
}

test('recognizes normal and localized Crunchyroll watch URLs', () => {
  const crunchyroll = loadCrunchyrollExtractor();

  assert.equal(crunchyroll.getCrunchyrollWatchId('/watch/G7PU403GE/nopperabo'), 'G7PU403GE');
  assert.equal(crunchyroll.getCrunchyrollWatchId('/nl/watch/g7pu403ge/nopperabo'), 'G7PU403GE');
  assert.equal(crunchyroll.getCrunchyrollWatchId('/series/GY8DWQN5Y/golden-kamuy'), null);
});

test('reads canonical episode metadata from the supplied Crunchyroll example page', () => {
  const crunchyroll = loadCrunchyrollExtractor();

  const metadata = crunchyroll.readCrunchyrollPageMetadata(
    crunchyrollDocument(),
    '/watch/G7PU403GE/nopperabo'
  );

  assert.deepEqual(plain(metadata), {
    watchId: 'G7PU403GE',
    providerId: 'G7PU403GE',
    showId: 'GY8DWQN5Y',
    seriesTitle: 'Golden Kamuy',
    season: 1,
    episode: 2,
    episodeTitle: 'Nopperabo',
    year: '2018',
    isSpecial: false,
  });
});

test('maps Crunchyroll intro and credits to normalized intro and outro segments', () => {
  const crunchyroll = loadCrunchyrollExtractor();
  crunchyroll.state.imdbIdsByShowId.GY8DWQN5Y = 'tt8225204';
  const metadata = crunchyroll.readCrunchyrollPageMetadata(
    crunchyrollDocument(),
    '/watch/G7PU403GE/nopperabo'
  );

  assert.equal(crunchyroll.processCrunchyrollEpisode(metadata, skipEventsPayload()), 2);
  assert.deepEqual(plain(crunchyroll.detectedShows[0]), {
    title: 'Golden Kamuy',
    showId: 'GY8DWQN5Y',
    year: '2018',
  });
  assert.deepEqual(plain(crunchyroll.catalogs), [{
    showId: 'GY8DWQN5Y',
    episode: {
      providerId: 'G7PU403GE',
      season: 1,
      episode: 2,
      title: 'Nopperabo',
      isSpecial: false,
    },
  }]);
  assert.deepEqual(plain(crunchyroll.state.allItems.map(item => ({
    id: item._eid,
    type: item.segment_type,
    start: item.start_sec,
    end: item.end_sec,
    title: item._episodeTitle,
    showId: item._showId,
    imdbId: item.imdb_id,
    languages: item._tvdbEpisodeLanguages,
    requireTitleMatch: item._tvdbRequireTitleMatch,
  }))), [
    {
      id: 'G4GFQZWG9:intro',
      type: 'intro',
      start: 109,
      end: 198,
      title: 'Nopperabo',
      showId: 'GY8DWQN5Y',
      imdbId: 'tt8225204',
      languages: ['eng'],
      requireTitleMatch: true,
    },
    {
      id: 'G4GFQZWG9:credits',
      type: 'outro',
      start: 1349,
      end: 1444,
      title: 'Nopperabo',
      showId: 'GY8DWQN5Y',
      imdbId: 'tt8225204',
      languages: ['eng'],
      requireTitleMatch: true,
    },
  ]);

  assert.equal(crunchyroll.processCrunchyrollEpisode(metadata, skipEventsPayload()), 0);
  assert.equal(crunchyroll.catalogs.length, 1);
  assert.equal(crunchyroll.state.allItems.length, 2);
});

test('requests the public skip-event JSON for the active watch id', () => {
  const document = crunchyrollDocument();
  const location = { pathname: '/watch/G7PU403GE/nopperabo' };
  const requests = [];
  const window = { fetch: () => Promise.reject(new Error('fetch fallback should not run')) };
  const crunchyroll = loadCrunchyrollExtractor({
    document,
    location,
    window,
    setInterval() {},
    GM_xmlhttpRequest(request) {
      requests.push(request.url);
      request.onload({ status: 200, responseText: JSON.stringify(skipEventsPayload()) });
    },
  });

  crunchyroll.setupCrunchyrollInterception();

  assert.deepEqual(requests, [
    'https://static.crunchyroll.com/skip-events/production/G7PU403GE.json',
  ]);
  assert.equal(crunchyroll.state.allItems.length, 2);
  assert.equal(crunchyroll.catalogs.length, 1);
});
