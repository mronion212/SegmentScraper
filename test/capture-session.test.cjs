const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function loadSession(storage = new Map()) {
  const source = ['state.js', 'capture-session.js'].map(file => fs.readFileSync(path.join(__dirname, '../src/core', file), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '')).join('\n');
  const context = vm.createContext({
    setTimeout, clearTimeout,
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  });
  vm.runInContext(source + '\nglobalThis.api = { state, restoreCaptureSession, saveCaptureSession, clearCaptureSession };', context);
  return { ...context.api, storage };
}

test('capture recovery preserves episodes, series mapping and IDs without persisting credentials', () => {
  const first = loadSession();
  first.restoreCaptureSession('skyshowtime');
  first.state.allItems = [{ _showId: 'series', season: 1, episode: 1, imdb_id: 'tt123', start_sec: 10, end_sec: 20 }];
  first.state.showIds.add('series');
  first.state.providerEpisodesByShowId = { series: [{ season: 1, episode: 1, title: 'Pilot' }] };
  first.state.introdbApiKey = 'secret-introdb';
  first.state.tvdbApiKey = 'secret-tvdb';
  first.saveCaptureSession();
  assert.doesNotMatch([...first.storage.values()].join(''), /secret-/);
  const restored = loadSession(first.storage);
  assert.equal(restored.restoreCaptureSession('skyshowtime'), true);
  assert.equal(restored.state.allItems[0].episode, 1);
  assert.equal(restored.state.showIds.has('series'), true);
  assert.equal(restored.state.providerEpisodesByShowId.series[0].title, 'Pilot');
  assert.equal(restored.state.introdbApiKey, '');
});

test('sessions are provider scoped and Clear data prevents recovery', () => {
  const first = loadSession();
  first.restoreCaptureSession('netflix');
  first.state.allItems = [{ start_sec: 0, end_sec: 20 }];
  first.saveCaptureSession();
  assert.equal(loadSession(first.storage).restoreCaptureSession('videoland'), false);
  first.clearCaptureSession();
  assert.equal(loadSession(first.storage).restoreCaptureSession('netflix'), false);
});

test('movie capture recovery preserves media type and scene markers', () => {
  const first = loadSession();
  first.restoreCaptureSession('skyshowtime');
  first.state.mediaType = 'movie';
  first.state.allItems = [{ media_type: 'movie', segment_type: 'post-credits', start_sec: 5400, end_sec: 5460 }];
  first.saveCaptureSession();
  const restored = loadSession(first.storage);
  assert.equal(restored.restoreCaptureSession('skyshowtime'), true);
  assert.equal(restored.state.mediaType, 'movie');
  assert.equal(restored.state.allItems[0].segment_type, 'post-credits');
});

test('corrupt or unavailable storage does not prevent startup', () => {
  const corrupt = loadSession(new Map([['segmentScraper.capture.v1.netflix', '{invalid']]));
  assert.equal(corrupt.restoreCaptureSession('netflix'), false);
  const unavailable = loadSession({ get() { throw new Error('blocked'); }, set() { throw new Error('quota'); } });
  assert.equal(unavailable.restoreCaptureSession('netflix'), false);
  assert.doesNotThrow(() => unavailable.saveCaptureSession());
  assert.equal(unavailable.state.sessionStorageError, true);
});
