const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function loadShowHandler(searches) {
  const state = {
    allItems: [],
    imdbId: '',
    imdbIdsByShowId: {},
    showTitle: '',
    showId: null,
    showYear: '',
    showIds: new Set(),
    dbSearchDone: false,
    dedupCacheV2: {},
    providerEpisodes: [],
  };
  let source = fs.readFileSync(path.join(__dirname, '..', 'src', 'providers', 'bootstrap.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  source += '\nglobalThis.bootstrapExports = { handleDetectedShow };';

  const noop = () => {};
  const context = vm.createContext({
    state,
    console: { log: noop, info: noop, warn: noop, error: noop },
    searchImdbByTitle: title => searches[title].promise,
    loadExistingSegments: async () => [],
    updatePanelTitle: noop,
    updateImdbInput: noop,
    updateCounters: noop,
    setProviderName: noop,
    closePanel: noop,
    toast: noop,
    setTimeout,
    clearTimeout,
    location: { pathname: '' },
    window: {},
    document: { getElementById: () => null, addEventListener: noop, querySelector: () => null },
    getProviderConfig: () => ({ name: 'SkyShowtime' }),
  });
  vm.runInContext(source, context, { filename: 'bootstrap.js' });
  return { state, handleDetectedShow: context.bootstrapExports.handleDetectedShow };
}

test('concurrent IMDb lookups only update items belonging to their SkyShowtime series', async () => {
  const searches = { Alpha: deferred(), Beta: deferred() };
  const bootstrap = loadShowHandler(searches);

  bootstrap.handleDetectedShow({ title: 'Alpha', showId: 'series-alpha', year: 2024 });
  bootstrap.state.allItems.push({ _showId: 'series-alpha', imdb_id: 'IMDB_PENDING' });
  bootstrap.handleDetectedShow({ title: 'Beta', showId: 'series-beta', year: 2025 });
  bootstrap.state.allItems.push({ _showId: 'series-beta', imdb_id: 'IMDB_PENDING' });

  searches.Beta.resolve({ success: true, imdbId: 'tt222' });
  await new Promise(resolve => setImmediate(resolve));
  searches.Alpha.resolve({ success: true, imdbId: 'tt111' });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(bootstrap.state.allItems.map(item => item.imdb_id), ['tt111', 'tt222']);
  assert.equal(bootstrap.state.imdbId, 'tt222');
  assert.deepEqual(JSON.parse(JSON.stringify(bootstrap.state.imdbIdsByShowId)), {
    'series-alpha': 'tt111',
    'series-beta': 'tt222',
  });
});
