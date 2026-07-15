const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadSettings() {
  const storage = new Map();
  const state = { introdbApiKey: '' };
  let source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'introdb-settings.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  source += '\nglobalThis.settingsExports = { loadIntrodbSettings, saveIntrodbSettings };';
  const context = vm.createContext({
    state,
    GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
    GM_setValue: (key, value) => storage.set(key, value),
  });
  vm.runInContext(source, context, { filename: 'introdb-settings.js' });
  return { ...context.settingsExports, state, storage };
}

test('stores and reloads the IntroDB API key locally without returning it', () => {
  const settings = loadSettings();
  assert.deepEqual(JSON.parse(JSON.stringify(settings.saveIntrodbSettings('  secret-value  '))), { configured: true });
  assert.equal(settings.storage.get('segmentScraper.introdb.apikey'), 'secret-value');

  settings.state.introdbApiKey = '';
  assert.deepEqual(JSON.parse(JSON.stringify(settings.loadIntrodbSettings())), { configured: true });
  assert.equal(settings.state.introdbApiKey, 'secret-value');
});

test('does not render the stored IntroDB API key into the panel input', () => {
  const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel.js'), 'utf8');
  assert.doesNotMatch(panelSource, /nfe-apikey-input[^>]*value=.*introdbApiKey/s);
  assert.match(panelSource, /if \(inp\) inp\.value = '';/);
});
