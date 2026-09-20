const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('recapturing restored segments does not duplicate data or discard distinct episode segments', () => {
  const source = ['core/state.js', 'core/output-policy.js', 'providers/bootstrap.js'].map(file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '')).join('\n');
  const context = vm.createContext({
    getProviderConfig: () => ({ name:'Test' }),
    scheduleCaptureSave() {}, updateCounters() {}, toast() {},
  });
  vm.runInContext(source + '\nglobalThis.api = { state, recordExtractedSegments };', context);
  const { state, recordExtractedSegments } = context.api;
  const first = { _showId:'series-one', _eid:'credits', season: 1, episode: 1, segment_type:'outro', start_sec:100, end_sec:120 };
  state.allItems = [{ ...first, imdb_id:'tt123' }];
  recordExtractedSegments([{ ...first, imdb_id:'IMDB_PENDING' }, { ...first, _showId:'series-two' }, { ...first, start_sec:130, end_sec:150 }]);
  assert.equal(state.allItems.length, 3);
  assert.equal(state.allItems[0].imdb_id, 'tt123');
});
