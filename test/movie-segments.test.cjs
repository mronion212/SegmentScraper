const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/normalization/segment-mapper.js'), 'utf8').replace(/^export /gm, ''), context);
const split = options => JSON.parse(JSON.stringify(context.splitCreditRange(options)));
const credits = { startSec: 5400, endSec: 6000 };

test('movie scenes require explicit boundaries and never extend to the file end', () => {
  const ranges = split({ ...credits, afterCreditsStartSec: 5600, afterCreditsEndSec: 5700 });
  assert.equal(ranges[0].endSec, 6000);
  assert.deepEqual(ranges[1], { startSec: 5600, endSec: 5700, segmentType: 'post-credits', creditPart: null });
  assert.equal(ranges.length, 2);
  assert.equal(split({ ...credits, afterCreditsStartSec: 5600 }).length, 1);
  assert.equal(split({ ...credits, afterCreditsStartSec: 5600, afterCreditsEndSec: 5500 }).length, 0);
  assert.deepEqual(split({ ...credits, afterCreditsDetected: true }), []);
  assert.equal(split(credits).length, 1);
});

test('a scene beginning at the explicit credits end is still captured', () => {
  const ranges = split({ ...credits, endSec: 5600, runtimeSec: 6000, afterCreditsStartSec: 5600, afterCreditsEndSec: 5700 });
  assert.equal(ranges.length, 2);
  assert.equal(ranges[1].segmentType, 'post-credits');
});

test('a late credits marker is never exported as the full movie outro', () => {
  assert.deepEqual(split({ startSec: 5800, endSec: 6000, afterCreditsStartSec: 5600, afterCreditsEndSec: 5700 }), []);
  assert.deepEqual(split({ ...credits, afterCreditsStartSec: 5600, afterCreditsEndSec: 6100 }), []);
});
