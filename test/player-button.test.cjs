const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadButton(candidates, extra = {}) {
  const document = {
    body: {},
    querySelectorAll(selector) { return selector === 'video' ? [{ getBoundingClientRect: () => ({ top:0, bottom:600, left:0, right:1000, width:1000, height:600 }) }] : candidates; },
    ...extra,
  };
  const context = vm.createContext({ document, togglePanel() {} });
  const source = fs.readFileSync(path.join(__dirname, '../src/ui/button.js'), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '');
  vm.runInContext(source + '\nglobalThis.api = { getNextEpBtn, injectBtn };', context);
  return context.api;
}
function control(top, slider = false) {
  return { matches: () => true, closest: () => slider ? {} : null, getAttribute: () => 'Play', getBoundingClientRect: () => ({ top, left:20, right:60, width:40, height:40 }) };
}

test('all providers reject upper toolbar anchors and use lower playback controls', () => {
  const upper = control(20);
  const lower = control(550);
  for (const provider of ['netflix', 'prime-video', 'videoland', 'skyshowtime', 'crunchyroll']) {
    assert.equal(loadButton([upper]).getNextEpBtn(provider), null);
    assert.equal(loadButton([upper, lower]).getNextEpBtn(provider), lower);
  }
});

test('timeline controls cannot be used as insertion anchors', () => {
  assert.equal(loadButton([control(550, true)]).getNextEpBtn('netflix'), null);
});

test('missing controls remove an old floating icon without creating a replacement', () => {
  let removed = false;
  const api = loadButton([], {
    getElementById: () => ({ remove() { removed = true; } }),
    createElement() { throw new Error('Must wait for controls'); },
  });
  api.injectBtn('netflix');
  assert.equal(removed, true);
});
