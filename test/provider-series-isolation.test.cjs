const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));

function loadExtractor(relativePath, exportName, globals = {}) {
  const state = {
    allItems: [],
    imdbId: '',
    imdbIdsByShowId: {},
    providerEpisodes: [],
    providerEpisodesByShowId: {},
  };
  const detectedShows = [];
  const catalogs = [];
  let source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
    .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
    .replace(/\bexport\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/g, '');
  source += `\nglobalThis.extractorExports = { ${exportName} };`;

  const context = vm.createContext({
    state,
    console: { info() {}, warn() {}, error() {} },
    handleDetectedShow(show) {
      detectedShows.push(show);
      state.showId = show.showId != null ? String(show.showId) : null;
      state.showTitle = show.title;
    },
    recordExtractedSegments(items) {
      state.allItems.push(...items);
    },
    setProviderEpisodeCatalog(episodes, showId) {
      catalogs.push({ episodes, showId });
    },
    recordProviderEpisode(episode, showId) {
      catalogs.push({ episodes: [episode], showId });
    },
    createNormalizedSegment(params) {
      return {
        _eid: params.episodeId,
        _episodeTitle: params.episodeTitle,
        _showId: params.showId,
        imdb_id: params.imdbId,
        segment_type: params.providerSegmentType,
        season: params.season,
        episode: params.episode,
        start_sec: params.startSec,
        end_sec: params.endSec,
      };
    },
    setTimeout(callback) { callback(); },
    Map,
    ...globals,
  });
  vm.runInContext(source, context, { filename: relativePath });
  return { process: context.extractorExports[exportName], state, detectedShows, catalogs, context };
}

function netflixPayload(id, title, episodeId) {
  return {
    video: {
      id,
      title,
      seasons: [{
        seq: 1,
        year: 2025,
        episodes: [{
          episodeId,
          seq: 1,
          title: `${title} episode`,
          skipMarkers: { intro: { start: 1000, end: 11000 } },
        }],
      }],
    },
  };
}

test('Netflix tags timestamps and catalogs with their own series id', () => {
  const netflix = loadExtractor('src/providers/netflix/extractor.js', 'processNetflixMetadata');
  netflix.state.imdbIdsByShowId = { '100': 'tt100', '200': 'tt200' };

  netflix.process(netflixPayload(100, 'Alpha', 'alpha-1'));
  netflix.process(netflixPayload(200, 'Beta', 'beta-1'));

  assert.deepEqual(plain(netflix.state.allItems.map(item => [item._showId, item.imdb_id])), [
    ['100', 'tt100'],
    ['200', 'tt200'],
  ]);
  assert.deepEqual(plain(netflix.catalogs.map(catalog => catalog.showId)), ['100', '200']);
});

function videolandPayload(programId, programTitle, clipId, {
  episode = 1,
  seoEpisodeTitle = `${programTitle} episode`,
  activeTitle = `${programTitle} episode`,
  entityTitle,
  extraTitle,
  activeSubtitle,
} = {}) {
  return {
    entity: { id: clipId, ...(entityTitle ? { title: entityTitle } : {}), ...(extraTitle ? { extraTitle } : {}) },
    seo: {
      parent: { id: programId, name: programTitle },
      video: { season: 1, episode, name: seoEpisodeTitle },
    },
    content: {
      itemContent: {
        title: activeTitle,
        ...(activeSubtitle ? { subtitle: activeSubtitle } : {}),
        video: {
          id: clipId,
          chapters: [{ type: 'opening_credits', tcStart: 1, tcEnd: 11 }],
        },
      },
    },
  };
}

test('Videoland tags timestamps and incremental catalogs with their own program id', () => {
  const videoland = loadExtractor('src/providers/videoland/extractor.js', 'processVideolandLayout');
  videoland.state.imdbIdsByShowId = { 'program-a': 'tt300', 'program-b': 'tt400' };

  videoland.process(videolandPayload('program-a', 'Alpha', 'clip-a'));
  videoland.process(videolandPayload('program-b', 'Beta', 'clip-b'));

  assert.deepEqual(plain(videoland.state.allItems.map(item => [item._showId, item.imdb_id])), [
    ['program-a', 'tt300'],
    ['program-b', 'tt400'],
  ]);
  assert.deepEqual(plain(videoland.state.allItems[0]._tvdbEpisodeLanguages), ['eng', 'nld']);
  assert.equal(videoland.state.allItems[0]._tvdbRequireTitleMatch, true);
  assert.deepEqual(plain(videoland.catalogs.map(catalog => catalog.showId)), ['program-a', 'program-b']);
});

test('Videoland prefers unique active episode titles over repeated SEO series titles', () => {
  const videoland = loadExtractor('src/providers/videoland/extractor.js', 'processVideolandLayout');
  videoland.state.imdbIdsByShowId = { 'program-a': 'tt300' };

  videoland.process(videolandPayload('program-a', 'Alpha', 'clip-a1', {
    episode: 1,
    seoEpisodeTitle: 'Alpha',
    activeTitle: 'First steps',
  }));
  videoland.process(videolandPayload('program-a', 'Alpha', 'clip-a2', {
    episode: 2,
    seoEpisodeTitle: 'Alpha',
    activeTitle: 'The choice',
  }));

  assert.deepEqual(plain(videoland.catalogs.map(catalog => catalog.episodes[0].title)), ['First steps', 'The choice']);
  assert.deepEqual(plain(videoland.state.allItems.map(item => item._episodeTitle)), ['First steps', 'The choice']);
});

test('Videoland uses episode-specific entity or subtitle metadata when generic title fields repeat the series name', () => {
  const videoland = loadExtractor('src/providers/videoland/extractor.js', 'processVideolandLayout');
  videoland.state.imdbIdsByShowId = { 'program-a': 'tt300' };

  videoland.process(videolandPayload('program-a', 'Kees Flodder', 'clip-a1', {
    seoEpisodeTitle: 'Kees Flodder',
    activeTitle: 'Kees Flodder',
    entityTitle: 'Vers Vlees, Vanochtend Aangereden',
  }));
  videoland.process(videolandPayload('program-a', 'Kees Flodder', 'clip-a2', {
    episode: 2,
    seoEpisodeTitle: 'Kees Flodder',
    activeTitle: 'Kees Flodder',
    activeSubtitle: "Die Pedo Jat M'n Kinderen",
  }));

  assert.deepEqual(plain(videoland.catalogs.map(catalog => catalog.episodes[0].title)), [
    'Vers Vlees, Vanochtend Aangereden',
    "Die Pedo Jat M'n Kinderen",
  ]);
  assert.deepEqual(plain(videoland.state.allItems.map(item => item._episodeTitle)), [
    'Vers Vlees, Vanochtend Aangereden',
    "Die Pedo Jat M'n Kinderen",
  ]);
});

test('Videoland never stores the series title as the episode title', () => {
  const videoland = loadExtractor('src/providers/videoland/extractor.js', 'processVideolandLayout');
  videoland.process(videolandPayload('program-a', 'Kees Flodder', 'clip-a1', {
    seoEpisodeTitle: 'Kees Flodder',
    activeTitle: 'Kees Flodder',
  }));

  assert.equal(videoland.catalogs[0].episodes[0].title, '');
  assert.equal(videoland.state.allItems[0]._episodeTitle, '');
});

test('Videoland uses extraTitle and removes its episode-number prefix for TVDB matching', () => {
  const videoland = loadExtractor('src/providers/videoland/extractor.js', 'processVideolandLayout');

  videoland.process(videolandPayload('program-a', 'Example series', 'clip-a1', {
    seoEpisodeTitle: 'Example series',
    activeTitle: 'Example series',
    extraTitle: '2. Green Birds',
  }));

  assert.equal(videoland.catalogs[0].episodes[0].title, 'Green Birds');
  assert.equal(videoland.state.allItems[0]._episodeTitle, 'Green Birds');
});

test('Prime Video keeps the series id in its ASIN cache and on extracted timestamps', () => {
  const episodeInfo = {
    textContent: 'S1 E1 - Episode one',
    querySelector: () => ({ textContent: 'Episode one' }),
  };
  const document = {
    title: 'Prime Video: Alpha Season 1',
    getElementById: () => ({ offsetWidth: 100, offsetHeight: 100 }),
    querySelector: () => episodeInfo,
  };
  const prime = loadExtractor('src/providers/prime-video/extractor.js', 'processPrimeVideoMetadata', { document });
  prime.state.imdbIdsByShowId = { Alpha: 'tt500', Beta: 'tt600' };
  const metadata = {
    transitionTimecodes: {
      result: { events: [{ eventType: 'SKIP_INTRO', startTimeMs: 1000, endTimeMs: 11000 }] },
    },
  };

  prime.process(metadata, '', 'https://example.test/?titleId=ALPHA00001');
  document.title = 'Prime Video: Beta Season 1';
  prime.process(metadata, '', 'https://example.test/?titleId=BETA000001');

  assert.deepEqual(plain(prime.state.allItems.map(item => [item._showId, item.imdb_id])), [
    ['Alpha', 'tt500'],
    ['Beta', 'tt600'],
  ]);
  assert.deepEqual(plain(prime.catalogs.map(catalog => catalog.showId)), ['Alpha', 'Beta']);
  assert.equal(prime.state.asinMap.get('ALPHA00001').showId, 'Alpha');
  assert.equal(prime.state.asinMap.get('BETA000001').showId, 'Beta');
});

test('Prime Video prefers response episode metadata while the player DOM is stale', () => {
  const episodeInfo = {
    textContent: 'S2 E1 - Stale episode',
    querySelector: () => ({ textContent: 'Stale episode' }),
  };
  const document = {
    title: 'Prime Video: Gamma Season 2',
    getElementById: () => ({ offsetWidth: 100, offsetHeight: 100 }),
    querySelector: () => episodeInfo,
  };
  const prime = loadExtractor('src/providers/prime-video/extractor.js', 'processPrimeVideoMetadata', { document });
  prime.state.imdbIdsByShowId = { Gamma: 'tt700' };
  const payload = (episodeNumber, title) => ({
    catalogMetadata: {
      catalog: { seasonNumber: 2, episodeNumber, seriesTitle: 'Gamma', title },
    },
    transitionTimecodes: {
      result: { events: [{ eventType: 'SKIP_INTRO', startTimeMs: 1000, endTimeMs: 11000 }] },
    },
  });

  prime.process(payload(1, 'First'), '', 'https://example.test/?titleId=GAMMA00001');
  prime.process(payload(2, 'Second'), '', 'https://example.test/?titleId=GAMMA00002');

  assert.deepEqual(plain(prime.catalogs.map(catalog => [catalog.episodes[0].season, catalog.episodes[0].episode])), [[2, 1], [2, 2]]);
  assert.deepEqual(plain(prime.state.allItems.map(item => [item.season, item.episode, item._episodeTitle])), [[2, 1, 'First'], [2, 2, 'Second']]);
});
