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
    await assert.rejects(network.loadExistingSegmentsForEpisode('tt123|1|1'));
    assert.equal(network.state.dedupCacheV2['tt123|1|1'], undefined);
  }
});

test('a confirmed missing record is a valid empty result', async () => {
  const network = loadNetwork(request => request.onload({ status: 404 }));
  assert.equal((await network.loadExistingSegmentsForEpisode('tt123|1|1')).size, 0);
});

test('submission timeouts settle without automatically repeating the POST', async () => {
  let count = 0;
  const network = loadNetwork(request => { count++; request.ontimeout(); });
  const result = await network.submitSegment({ imdb_id: 'tt123', season: 1, episode: 1, start_sec: 0, end_sec: 20 }, 'test');
  assert.equal(result.success, false);
  assert.equal(count, 1);
});

function loadNetwork(requestHandler) {
  const state = {
    allItems: [],
    dedupCacheV2: {},
  };
  const source = ['output-policy.js', 'network.js'].map(file => fs.readFileSync(path.join(__dirname, '..', 'src', 'core', file), 'utf8')).join('\n')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')
    + '\nglobalThis.networkExports = { loadExistingSegments, loadExistingSegmentsForEpisode, searchImdbByTitle, submitSegment };';
  const context = vm.createContext({
    state,
    createEpisodeCacheKey(imdbId, season, episode) { return `${imdbId}|${season}|${episode}`; },
    GM_xmlhttpRequest: requestHandler,
    console: { log() {}, error() {} },
  });
  vm.runInContext(source, context, { filename: 'network.js' });
  return { state, ...context.networkExports };
}
