const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));

test('invalid episode numbers are rejected before making an HTTP request', async () => {
  let requests = 0;
  const network = loadNetwork(() => { requests++; });
  for (const key of ['tt14507354|0|1', 'tt14507354|1|0', 'tt14507354|null|1', 'tt14507354|1|undefined']) {
    await assert.rejects(network.loadExistingSegmentsForEpisode(key), /positive integers/);
  }
  assert.equal(requests, 0);
});

test('HTTP 400 identifies the failing IMDb ID and episode and never caches it as absent', async () => {
  const network = loadNetwork(request => request.onload({ status: 400, responseText: '{"error":"Invalid query params."}' }));
  await assert.rejects(network.loadExistingSegmentsForEpisode('tt14507354|1|3'), /HTTP 400 for tt14507354 S1E3: Invalid query params/);
  assert.equal(network.state.dedupCacheV2['tt14507354|1|3'], undefined);
});

test('failed duplicate checks reject without caching an empty result and can be retried', async () => {
  let failing = true;
  const network = loadNetwork(request => {
    assert.equal(request.timeout, 15000);
    if (failing) request.onload({ status: 503 });
    else request.onload({ status: 200, responseText: '{"intro":{"start_sec":0,"end_sec":20}}' });
  });
  await assert.rejects(network.loadExistingSegmentsForEpisode('tt123|1|1'), /503/);
  assert.equal(network.state.dedupCacheV2['tt123|1|1'], undefined);
  failing = false;
  assert.equal((await network.loadExistingSegmentsForEpisode('tt123|1|1')).has('intro'), true);
});

test('duplicate check timeouts and malformed responses are not treated as missing segments', async () => {
  for (const callback of [request => request.ontimeout(), request => request.onerror(), request => request.onload({ status: 200, responseText: 'null' })]) {
    const network = loadNetwork(callback);
    await assert.rejects(network.loadExistingSegmentsForEpisode('tt123|movie'));
    assert.equal(network.state.dedupCacheV2['tt123|movie'], undefined);
  }
});

test('a confirmed missing record is a valid empty result', async () => {
  const network = loadNetwork(request => request.onload({ status: 404 }));
  assert.equal((await network.loadExistingSegmentsForEpisode('tt123|movie')).size, 0);
});

test('submission timeouts settle without automatically repeating the POST', async () => {
  let count = 0;
  const network = loadNetwork(request => { count++; request.ontimeout(); });
  const result = await network.submitSegment({ imdb_id: 'tt123', media_type: 'movie', start_sec: 0, end_sec: 20 }, 'test');
  assert.equal(result.success, false);
  assert.equal(count, 1);
});

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
