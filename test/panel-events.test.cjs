const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.style = {};
    this.listeners = new Map();
    this.innerHTML = '';
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) {
      listener({ target: this, ...event });
    }
  }

  click() {
    this.dispatch('click');
  }
}

function loadPanel() {
  const ids = [
    'nfe-close',
    'nfe-export',
    'nfe-submit',
    'nfe-clear',
    'nfe-imdb-set',
    'nfe-imdb-search',
    'nfe-imdb-input',
    'nfe-apikey-set',
    'nfe-apikey-input',
    'nfe-tvdb-set',
    'nfe-tvdb-apikey-input',
    'nfe-tvdb-pin-input',
  ];
  const controls = Object.fromEntries(ids.map(id => [id, new FakeElement(id)]));
  const elements = new Map();
  const logs = [];
  const document = {
    getElementById: id => elements.get(id) || null,
    createElement: () => new FakeElement(),
    body: {
      appendChild: element => {
        elements.set(element.id, element);
        for (const [id, control] of Object.entries(controls)) elements.set(id, control);
      },
    },
  };
  const state = {
    imdbId: '',
    introdbApiKey: '',
    tvdbApiKey: '',
  };
  const window = { nfePanelCallbacks: {} };
  const config = {
    name: 'Test Provider',
    colors: {
      primary: '#100',
      primaryDark: '#200',
      secondary: '#300',
      secondaryDark: '#400',
    },
    branding: { title: 'SegmentScraper' },
    infoAccent: '#500',
    nameColor: '#600',
    captureHint: 'Capture hint',
  };
  const PANEL_COLORS = {
    background: '#000',
    panelBg: '#111',
    border: '#222',
    text: '#fff',
    textSecondary: '#aaa',
    textMuted: '#777',
    accent: '#f00',
  };
  let source = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  source += '\nglobalThis.panelExports = { createPanel };';
  const context = vm.createContext({
    console: { log: (...args) => logs.push(args), error() {} },
    document,
    window,
    state,
    PANEL_COLORS,
    getProviderConfig: () => config,
  });
  vm.runInContext(source, context, { filename: 'panel.js' });
  context.panelExports.createPanel();
  return { controls, elements, logs, window };
}

test('panel buttons dispatch their configured callbacks at click time', () => {
  const panel = loadPanel();
  const calls = [];
  const callbackReceivers = [];
  panel.window.nfePanelCallbacks = {
    onClose() {
      callbackReceivers.push(this);
      calls.push('close');
    },
    onExport: () => calls.push('export'),
    onSubmit: () => calls.push('submit'),
    onClear: () => calls.push('clear'),
    onImdbSet: () => calls.push('imdb-set'),
    onImdbSearch: () => calls.push('imdb-search'),
    onApikeySet: () => calls.push('apikey-set'),
    onTvdbSet: () => calls.push('tvdb-set'),
  };

  for (const id of [
    'nfe-close',
    'nfe-export',
    'nfe-submit',
    'nfe-clear',
    'nfe-imdb-set',
    'nfe-imdb-search',
    'nfe-apikey-set',
    'nfe-tvdb-set',
  ]) {
    panel.controls[id].click();
  }

  assert.deepEqual(calls, [
    'close',
    'export',
    'submit',
    'clear',
    'imdb-set',
    'imdb-search',
    'apikey-set',
    'tvdb-set',
  ]);
  assert.equal(callbackReceivers[0], panel.window.nfePanelCallbacks);
  assert.deepEqual(
    panel.logs.map(args => args[0]).filter(message => /button clicked$/.test(message)),
    [
      '[NFE] Close button clicked',
      '[NFE] Export button clicked',
      '[NFE] Submit button clicked',
      '[NFE] Clear button clicked',
      '[NFE] IMDB set button clicked',
      '[NFE] IMDB search button clicked',
      '[NFE] API key set button clicked',
    ],
  );

  panel.window.nfePanelCallbacks.onExport = () => calls.push('replacement-export');
  panel.controls['nfe-export'].click();
  assert.equal(calls.at(-1), 'replacement-export');

  panel.window.nfePanelCallbacks = null;
  assert.doesNotThrow(() => panel.controls['nfe-export'].click());
});

test('panel credential inputs preserve their Enter-key button lookup behavior', () => {
  const panel = loadPanel();
  const calls = [];
  panel.window.nfePanelCallbacks = {
    onImdbSet: () => calls.push('imdb-set'),
    onApikeySet: () => calls.push('apikey-set'),
    onTvdbSet: () => calls.push('tvdb-set'),
  };

  panel.controls['nfe-imdb-input'].dispatch('keydown', { key: 'Escape' });
  panel.controls['nfe-imdb-input'].dispatch('keydown', { key: 'Enter' });
  panel.controls['nfe-apikey-input'].dispatch('keydown', { key: 'Enter' });
  panel.controls['nfe-tvdb-apikey-input'].dispatch('keydown', { key: 'Enter' });
  panel.controls['nfe-tvdb-pin-input'].dispatch('keydown', { key: 'Enter' });

  assert.deepEqual(calls, ['imdb-set', 'apikey-set', 'tvdb-set', 'tvdb-set']);

  const replacementImdbButton = new FakeElement('nfe-imdb-set');
  replacementImdbButton.click = () => calls.push('replacement-imdb-button');
  panel.elements.set('nfe-imdb-set', replacementImdbButton);
  panel.controls['nfe-imdb-input'].dispatch('keydown', { key: 'Enter' });
  assert.equal(calls.at(-1), 'replacement-imdb-button');

  const replacementApikeyButton = new FakeElement('nfe-apikey-set');
  replacementApikeyButton.click = () => calls.push('replacement-apikey-button');
  panel.elements.set('nfe-apikey-set', replacementApikeyButton);
  panel.controls['nfe-apikey-input'].dispatch('keydown', { key: 'Enter' });
  assert.equal(calls.at(-1), 'replacement-apikey-button');

  const replacementTvdbButton = new FakeElement('nfe-tvdb-set');
  replacementTvdbButton.click = () => calls.push('replacement-tvdb-button');
  panel.elements.set('nfe-tvdb-set', replacementTvdbButton);
  panel.controls['nfe-tvdb-apikey-input'].dispatch('keydown', { key: 'Enter' });
  assert.equal(calls.at(-1), 'tvdb-set');
});
