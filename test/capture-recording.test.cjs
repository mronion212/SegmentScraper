const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('capture validates boundaries before storage and keeps only safe timing evidence', () => {
  const source = ['core/state.js', 'core/output-policy.js', 'providers/bootstrap.js'].map(file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '')).join('\n');
  const context = vm.createContext({ console: {warn() {}}, getProviderConfig: () => ({name:'Netflix'}),
    scheduleCaptureSave() {}, updateCounters() {}, toast() {}, document: {getElementById() {return null;}} });
  vm.runInContext(source + '\nglobalThis.api={state,recordExtractedSegments};', context);
  const {state,recordExtractedSegments}=context.api;
  const base={_eid:'intro',_showId:'show',season:1,episode:1,segment_type:'intro',start_sec:0,end_sec:30};
  recordExtractedSegments([null,'',true].map(start_sec=>({...base,start_sec})), 'netflix');
  recordExtractedSegments([{...base,_duration_sec:29}], 'netflix');
  assert.equal(state.allItems.length,0);
  recordExtractedSegments([{...base,_timing:{provider:'netflix',source:'skip-marker',unit:'milliseconds',raw_start:0,raw_end:30000,url:'private',token:'private'}}], 'netflix');
  assert.equal(state.allItems.length,1);
  assert.equal(state.allItems[0]._timing.raw_end,30000);
  assert.doesNotMatch(JSON.stringify(state.allItems),/private|token|url/);
  recordExtractedSegments([{_showId:'movie',media_type:'movie',segment_type:'post-credits',start_sec:5400,end_sec:null}], 'netflix');
  assert.equal(state.allItems.length,1);
  assert.equal(state.knownMovieScenes[0].showId,'movie');
});

test('recapturing restored segments does not duplicate data or discard distinct episode segments', () => {
  const source = ['core/state.js', 'core/output-policy.js', 'providers/bootstrap.js'].map(file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '')).join('\n');
  const context = vm.createContext({
    getProviderConfig: () => ({ name:'Test' }),
    scheduleCaptureSave() {}, updateCounters() {}, toast() {},
    document: { getElementById() { return null; } },
  });
  vm.runInContext(source + '\nglobalThis.api = { state, recordExtractedSegments };', context);
  const { state, recordExtractedSegments } = context.api;
  const first = { _showId:'series-one', _eid:'credits', season: 1, episode: 1, segment_type:'outro', start_sec:100, end_sec:120 };
  state.allItems = [{ ...first, imdb_id:'tt123' }];
  recordExtractedSegments([{ ...first, imdb_id:'IMDB_PENDING' }, { ...first, _showId:'series-two' }, { ...first, start_sec:130, end_sec:150 }]);
  assert.equal(state.allItems.length, 3);
  assert.equal(state.allItems[0].imdb_id, 'tt123');
});

test('movie captures are disabled for non-Netflix providers while TV capture remains active', () => {
  const source = ['core/state.js', 'core/output-policy.js', 'providers/bootstrap.js'].map(file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '')).join('\n');
  const context = vm.createContext({
    getProviderConfig: () => ({ name:'Test' }),
    scheduleCaptureSave() {}, updateCounters() {}, toast() {},
    document: { getElementById() { return null; } },
  });
  vm.runInContext(source + '\nglobalThis.api = { state, recordExtractedSegments };', context);
  const { state, recordExtractedSegments } = context.api;

  recordExtractedSegments([{
    _showId: 'prime-movie', _eid: 'movie-outro', media_type: 'movie',
    segment_type: 'outro', start_sec: 5400, end_sec: 6000,
  }], 'prime-video');
  assert.equal(state.allItems.length, 0);

  recordExtractedSegments([{
    _showId: 'prime-series', _eid: 'episode-outro', season: 1, episode: 1,
    segment_type: 'outro', start_sec: 100, end_sec: 120,
  }], 'prime-video');
  assert.equal(state.allItems.length, 1);

  recordExtractedSegments([{
    _showId: 'netflix-movie', _eid: 'movie-outro', media_type: 'movie',
    segment_type: 'outro', start_sec: 5400, end_sec: 6000,
  }], 'netflix');
  assert.equal(state.allItems.length, 2);
});
