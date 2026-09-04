const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));

function loadNetwork(requestHandler) {
  const state = {
    allItems: [],
    dedupCacheV2: {},
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'network.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')
    + '\nglobalThis.networkExports = { loadExistingSegments, loadExistingSegmentsForEpisode, searchImdbByTitle, submitSegment };';
  const context = vm.createContext({
    state,
    createMediaCacheKey(imdbId, mediaType, season, episode) {
      return String(mediaType).toLowerCase() === 'movie'
        ? `${imdbId}|movie`
        : `${imdbId}|${season}|${episode}`;
    },
    GM_xmlhttpRequest: requestHandler,
    console: { log() {}, error() {} },
  });
  vm.runInContext(source, context, { filename: 'network.js' });
  return { state, ...context.networkExports };
}

test('movie deduplication requests omit TV season and episode parameters', async () => {
  const requests = [];
  const network = loadNetwork(request => {
    requests.push(request);
    request.onload({ status: 200, responseText: JSON.stringify({ outro: { start_sec: 5400, end_sec: 5700 } }) });
  });
  network.state.allItems = [{ imdb_id: 'ttmovie', media_type: 'movie', season: null, episode: null }];

  const existing = await network.loadExistingSegments('ttmovie', 'key');

  assert.equal(requests[0].url, 'https://api.introdb.app/segments?imdb_id=ttmovie');
  assert.deepEqual(plain(existing), [{ key: 'ttmovie|movie', segmentType: 'outro' }]);
});

test('movie deduplication keeps separate credit-part ranges', async () => {
  const network = loadNetwork(request => {
    request.onload({ status: 200, responseText: JSON.stringify({
      outro: [
        { start_sec: 5400, end_sec: 5600, credit_part: 'before_after_credits_scene' },
        { start_sec: 5800, end_sec: 6000, credit_part: 'after_after_credits_scene' },
      ],
    }) });
  });

  const existing = await network.loadExistingSegmentsForEpisode('ttmovie|movie');

  assert.equal(existing.has('outro'), true);
  assert.deepEqual(plain(existing.rangesByType.get('outro')), [
    { startSec: 5400, endSec: 5600, creditPart: 'before_after_credits_scene' },
    { startSec: 5800, endSec: 6000, creditPart: 'after_after_credits_scene' },
  ]);
});

test('movie IMDb lookup accepts case variants of IMDb movie result types', async () => {
  const network = loadNetwork(request => {
    request.onload({ status: 200, responseText: JSON.stringify({
      d: [
        { id: 'ttmovie', l: 'Example Movie', qid: 'featureFilm', y: 2025 },
      ],
    }) });
  });

  assert.deepEqual(plain(await network.searchImdbByTitle('Example Movie', '2025', { mediaType: 'movie' })), {
    success: true,
    imdbId: 'ttmovie',
    title: 'Example Movie',
    year: 2025,
  });
});

test('movie submissions include media type and omit TV fields', async () => {
  const requests = [];
  const network = loadNetwork(request => {
    requests.push(request);
    request.onload({ status: 201 });
  });

  const result = await network.submitSegment({
    imdb_id: 'ttmovie',
    media_type: 'movie',
    segment_type: 'outro',
    season: null,
    episode: null,
    start_sec: 5400,
    end_sec: 5700,
  }, 'key');

  assert.deepEqual(plain(result), { success: true, status: 201 });
  assert.deepEqual(JSON.parse(requests[0].data), {
    imdb_id: 'ttmovie',
    media_type: 'movie',
    segment_type: 'outro',
    start_sec: 5400,
    end_sec: 5700,
  });
});
