const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function load(responses, token = 'private-token') {
  const requests = [];
  const context = vm.createContext({ Date, GM_getValue: () => token,
    GM_setValue: (_, value) => { token = value; },
    GM_xmlhttpRequest: request => {
      requests.push(request);
      const next = responses.shift();
      if (next === 'timeout') request.ontimeout();
      else request.onload({ status: next?.status || 200, responseText: JSON.stringify(next?.data) });
    },
  });
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../src/core/tmdb.js'), 'utf8').replace(/^export /gm, ''), context);
  return { check: context.checkTmdbExtraScenes, save: context.saveTmdbToken, requests };
}

for (const name of ['aftercreditsstinger', 'duringcreditsstinger']) {
  test(`TMDB ${name} is detected by exact IMDb lookup and cached`, async () => {
    const api = load([{ data: { movie_results: [{ id: 123 }] } }, { data: { keywords: [{ name }] } }]);
    assert.equal((await api.check('tt1234567')).status, 'present');
    assert.equal((await api.check('tt1234567')).status, 'present');
    assert.equal(api.requests.length, 2);
    assert.match(api.requests[0].url, /find\/tt1234567\?external_source=imdb_id$/);
    assert.match(api.requests[1].url, /movie\/123\/keywords$/);
    assert.equal(api.requests[0].headers.Authorization, 'Bearer private-token');
    assert.doesNotMatch(api.requests[0].url, /private-token/);
  });
}
test('missing keywords remain unknown and clearing credentials disables cached checks', async () => {
  const api = load([{ data: { movie_results: [{ id: 123 }] } }, { data: { keywords: [] } }]);
  assert.equal((await api.check('tt1234567')).status, 'unknown');
  api.save('');
  assert.equal((await api.check('tt1234567')).status, 'unavailable');
});
test('missing token does not make a request', async () => {
  const api = load([], '');
  assert.equal((await api.check('tt1234567')).status, 'unavailable');
  assert.equal(api.requests.length, 0);
});
for (const response of ['timeout', { status: 401 }, { data: {} }, { data: { movie_results: [] } }, { data: { movie_results: [{ id: 1 }, { id: 2 }] } }]) {
  test(`failed or ambiguous TMDB lookup stays unavailable: ${JSON.stringify(response)}`, async () => {
    const api = load([response]);
    assert.equal((await api.check('tt1234567')).status, 'unavailable');
  });
}
test('keyword failures are retried instead of cached as scene absence', async () => {
  const find = { data: { movie_results: [{ id: 123 }] } };
  const api = load([find, { status: 429 }, find, { data: { keywords: [] } }]);
  assert.equal((await api.check('tt1234567')).status, 'unavailable');
  assert.equal((await api.check('tt1234567')).status, 'unknown');
  assert.equal(api.requests.length, 4);
});
