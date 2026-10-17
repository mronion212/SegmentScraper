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

function loadShowHandler(searches, { panelInitiallyPresent = true } = {}) {
  let panelPresent = panelInitiallyPresent;
  const state = {
    allItems: [],
    imdbId: '',
    imdbIdsByShowId: {},
    showTitle: '',
    showId: null,
    mediaType: 'tv',
    showYear: '',
    showIds: new Set(),
    dbSearchDone: false,
    dedupCacheV2: {},
    providerEpisodes: [],
  };
  let source = fs.readFileSync(path.join(__dirname, '..', 'src', 'providers', 'bootstrap.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  source += '\nglobalThis.bootstrapExports = { handleDetectedShow, applyImdbIdToShow, showImdbCandidates };';

  const noop = () => {};
  const candidates = { children: [], replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); } };
  const input = { value: '' };
  const window = { nfePanelCallbacks: { onImdbSet() {
    state.imdbId = input.value;
    context.bootstrapExports.applyImdbIdToShow(input.value, state.showId, { overwrite: true });
  } } };
  const searchCalls = [];
  const context = vm.createContext({
    state,
    console: { log: noop, info: noop, warn: noop, error: noop },
    searchImdbByTitle: (title, year, options) => {
      searchCalls.push({ title, year, options });
      return searches[title].promise;
    },
    loadExistingSegments: async () => [],
    scheduleCaptureSave: noop,
    updatePanelTitle: noop,
    updateImdbInput: noop,
    updateCounters: noop,
    setProviderName: noop,
    closePanel: noop,
    toast: noop,
    setTimeout,
    clearTimeout,
    location: { pathname: '' },
    window,
    document: {
      getElementById: id => !panelPresent ? null : id === 'nfe-imdb-candidates' ? candidates : id === 'nfe-imdb-input' ? input : null,
      createElement: () => ({ style: {}, addEventListener(event, listener) { this[event] = listener; } }),
      addEventListener: noop, querySelector: () => null,
    },
    getProviderConfig: () => ({ name: 'SkyShowtime' }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/core/output-policy.js'), 'utf8').replace(/^export /gm, ''), context);
  vm.runInContext(source, context, { filename: 'bootstrap.js' });
  return { state, candidates, searchCalls, handleDetectedShow: context.bootstrapExports.handleDetectedShow,
    openPanel() { panelPresent = true; context.bootstrapExports.showImdbCandidates(state.imdbCandidates); },
    removePanel() { panelPresent = false; candidates.replaceChildren(); },
  };
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

test('movie IMDb lookup uses movie mode and updates the captured movie item', async () => {
  const searches = { Movie: deferred() };
  const bootstrap = loadShowHandler(searches);

  bootstrap.handleDetectedShow({ title: 'Movie', showId: 'movie-id', year: 2025, mediaType: 'movie' });
  bootstrap.state.allItems.push({ _showId: 'movie-id', media_type: 'movie', imdb_id: 'IMDB_PENDING' });

  assert.equal(bootstrap.searchCalls.length, 1);
  assert.equal(bootstrap.searchCalls[0].title, 'Movie');
  assert.equal(bootstrap.searchCalls[0].year, '2025');
  assert.equal(bootstrap.searchCalls[0].options.mediaType, 'movie');

  searches.Movie.resolve({ success: true, imdbId: 'tt333' });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(bootstrap.state.imdbId, 'tt333');
  assert.equal(bootstrap.state.allItems[0].imdb_id, 'tt333');
  assert.equal(bootstrap.state.imdbIdsByShowId['movie-id'], 'tt333');
});

test('ambiguous series stay pending until a version is chosen, and old choices cannot affect another show', async () => {
  const searches = { 'Bestemming X': deferred(), Other: deferred() };
  const app = loadShowHandler(searches);
  app.handleDetectedShow({ title: 'Bestemming X', showId: 'videoland-x' });
  app.state.allItems.push({ _showId: 'videoland-x', imdb_id: 'IMDB_PENDING' });
  searches['Bestemming X'].resolve({ success: false, ambiguous: true, error: 'Choose a version', candidates: [
    { imdbId: 'tt32816352', title: 'Bestemming X Nederland', year: 2024 },
    { imdbId: 'tt26931980', title: 'Bestemming X', year: 2023 },
  ] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.state.imdbId, '');
  assert.equal(app.state.allItems[0].imdb_id, 'IMDB_PENDING');
  assert.equal(app.candidates.children.length, 2);
  const dutch = app.candidates.children[0];
  assert.match(dutch.textContent, /Bestemming X Nederland.*2024.*tt32816352/);
  dutch.click();
  assert.equal(app.state.imdbId, 'tt32816352');
  assert.equal(app.state.allItems[0].imdb_id, 'tt32816352');
  assert.equal(app.state.imdbIdsByShowId['videoland-x'], 'tt32816352');
  app.handleDetectedShow({ title: 'Other', showId: 'other' });
  assert.equal(app.candidates.children.length, 0);
  dutch.click();
  assert.equal(app.state.imdbId, '');
});

test('automatic lookup retains choices before panel creation and restores them without another search', async () => {
  const searches = { 'Bestemming X': deferred(), Other: deferred() };
  const app = loadShowHandler(searches, { panelInitiallyPresent: false });
  app.handleDetectedShow({ title: 'Bestemming X', showId: 'videoland-x' });
  searches['Bestemming X'].resolve({ success: false, ambiguous: true, candidates: [
    { imdbId: 'tt32816352', title: 'Bestemming X Nederland', year: 2024 },
    { imdbId: 'tt26931980', title: 'Bestemming X', year: 2023 },
  ] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.state.imdbCandidates.length, 2);
  assert.equal(app.candidates.children.length, 0);
  assert.doesNotMatch(app.state.dbStatusMsg, /failed|below/i);
  assert.match(app.state.dbStatusMsg, /Choose the version/);
  app.openPanel();
  assert.equal(app.candidates.children.length, 2);
  app.removePanel();
  app.openPanel();
  assert.equal(app.candidates.children.length, 2);
  assert.equal(app.searchCalls.length, 1);
  app.removePanel();
  app.handleDetectedShow({ title: 'Other', showId: 'other' });
  app.openPanel();
  assert.equal(app.candidates.children.length, 0);
});
