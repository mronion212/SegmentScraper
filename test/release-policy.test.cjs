const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRelease } = require('../build/check-release.cjs');
const valid = { version:'1.12.7', lockVersion:'1.12.7', scriptVersion:'1.12.7', notes:'# Features and fixes', baseVersion:'1.12.6' };

test('main updates require a higher version, matching generated metadata and release notes', () => {
  assert.equal(validateRelease(valid),'v1.12.7');
  for (const patch of [{baseVersion:'1.12.7'},{baseVersion:'1.13.0'},{lockVersion:'1.12.6'},{scriptVersion:'1.12.6'},{notes:''},{version:'1.12.7-beta'}]) {
    assert.throws(()=>validateRelease({...valid,...patch}));
  }
});

test('release validation permits patch, minor and major updates and idempotent manual retries', () => {
  for (const version of ['1.12.8','1.13.0','2.0.0']) assert.equal(validateRelease({...valid,version,lockVersion:version,scriptVersion:version}),`v${version}`);
  assert.equal(validateRelease({...valid,baseVersion:undefined}),'v1.12.7');
});
