const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const currentVersion = require('../package.json').version;

function loadUpdateCheck() {
  const state = {};
  let source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'update-check.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  source += '\nglobalThis.updateExports = { compareVersions, extractUserscriptVersion, checkForRequiredUpdate };';
  const context = vm.createContext({
    console: { warn() {} },
    Date,
    Error,
    Promise,
    state,
    SEGMENTSCRAPER_VERSION: currentVersion,
    SEGMENTSCRAPER_UPDATE_URL: 'https://example.test/SegmentScraper.user.js',
    _GM_xmlhttpRequest: null,
  });
  vm.runInContext(source, context, { filename: 'update-check.js' });
  return { state, ...context.updateExports };
}

test('semantic version comparison handles releases and prereleases', () => {
  const { compareVersions } = loadUpdateCheck();
  assert.equal(compareVersions('1.7.0', '1.6.9'), 1);
  assert.equal(compareVersions('1.6.0', '1.6.0'), 0);
  assert.equal(compareVersions('1.5.9', '1.6.0'), -1);
  assert.equal(compareVersions('1.6.0', '1.6.0-beta.2'), 1);
  assert.equal(compareVersions('1.6.0-beta.2', '1.6.0-beta.10'), -1);
  assert.equal(compareVersions('not-a-version', '1.6.0'), null);
});

test('userscript metadata version is extracted from the header', () => {
  const { extractUserscriptVersion } = loadUpdateCheck();
  assert.equal(extractUserscriptVersion('// ==UserScript==\n// @version      2.3.4\n// ==/UserScript=='), '2.3.4');
  assert.equal(extractUserscriptVersion('// no version'), null);
});

test('a newer GitHub version enables the required-update state', async () => {
  const loaded = loadUpdateCheck();
  const result = await loaded.checkForRequiredUpdate(options => options.onload({
    status: 200,
    responseText: '// @version      1.7.0',
  }));

  assert.equal(result.required, true);
  assert.equal(loaded.state.updateRequired, true);
  assert.equal(loaded.state.updateStatus, 'required');
  assert.equal(loaded.state.latestVersion, '1.7.0');
  assert.equal(loaded.state.currentVersion, currentVersion);
});

test('an unavailable version check fails open', async () => {
  const loaded = loadUpdateCheck();
  const result = await loaded.checkForRequiredUpdate(options => options.onerror());

  assert.equal(result.required, false);
  assert.equal(loaded.state.updateRequired, undefined);
  assert.equal(loaded.state.updateStatus, 'unavailable');
});
