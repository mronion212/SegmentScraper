const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const browser = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/core/output-policy.js'), 'utf8').replace(/^export /gm, ''), browser);
const segment = { imdb_id: 'tt1234567', season: 1, episode: 1, segment_type: 'intro', start_sec: 0, end_sec: 30 };

test('userscript and generated desktop share strict boundaries, conflict decisions and safe evidence', async () => {
  const { createCore } = await import('../app/shared-core.mjs');
  for (const core of [browser, createCore({ request() {} })]) {
    for (const value of [null, undefined, '', ' ', true, false, [], {}, Infinity, NaN, '10junk']) {
      assert.ok(core.timestampRangeIssue({ ...segment, start_sec: value }));
      assert.equal(core.outputSegmentAllowed({ ...segment, start_sec: value }), false);
      assert.equal(core.parseIntrodbSegments({ intro: { start_ms: value, end_ms: 30000 } }).invalid.length, 1);
    }
    assert.equal(core.timestampRangeIssue(segment), '');
    assert.ok(core.timestampRangeIssue({ ...segment, end_sec: 31 }, 30));
    assert.ok(core.timestampRangeIssue({ ...segment, end_sec: 0 }));
    assert.equal(core.timestampRangeIssue({ ...segment, start_sec: '0', end_sec: '30.001' }), '');
    const a = { ...segment }, b = { ...segment, start_sec: 2 };
    let decisions = core.assessTimestampCandidates([a, b]);
    assert.equal(decisions.get(a).allowed, false);
    assert.equal(decisions.get(b).conflict, true);
    a._timingReview = decisions.get(a).signature;
    decisions = core.assessTimestampCandidates([b, a]);
    assert.equal(decisions.get(a).allowed, true);
    assert.equal(decisions.get(b).allowed, false);
    const newer = { ...segment, start_sec: 4 };
    decisions = core.assessTimestampCandidates([a, b, newer]);
    assert.equal([...decisions.values()].some(d => d.allowed), false);
    const otherEpisode = { ...b, episode: 2 }, otherTitle = { ...b, imdb_id: 'tt7654321' };
    decisions = core.assessTimestampCandidates([a, otherEpisode, otherTitle]);
    assert.equal([...decisions.values()].every(d => d.allowed), true);
    const same = { ...a, start_sec: 0.000000001 };
    assert.equal(core.capturedSegmentKey(a), core.capturedSegmentKey(same));
    decisions = core.assessTimestampCandidates([a, same]);
    assert.equal([...decisions.values()].filter(d => d.allowed).length, 1);
    assert.equal([...decisions.values()].some(d => d.conflict), false);
    const evidence = core.timestampEvidence({ provider: 'netflix', source: 'credits-offset', rawStart: 5400, rawEnd: 5700, correction: -6, url: 'secret', token: 'secret' });
    assert.equal(evidence.correction_sec, -6);
    assert.equal(evidence.raw_start, 5400);
    assert.doesNotMatch(JSON.stringify(evidence), /secret|url|token/);
  }
});

test('malformed clock strings are not accepted as IntroDB boundaries', () => {
  for (const start of ['1:', ':30', '1:99', '1:90:00', '1:02:99']) {
    assert.equal(browser.parseIntrodbSegments({ intro: { start, end: 9000 } }).invalid.length, 1);
  }
  assert.equal(browser.parseIntrodbSegments({ intro: { start: '01:02.125', end: '02:00' } }).ranges[0].start_sec, 62.125);
});
