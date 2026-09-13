const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('timestamp dialog shows readable values, keeps failed rows and gates downloading', () => {
  let document;
  class Element {
    constructor() { this.style = {}; this.children = []; this.listeners = {}; }
    setAttribute() {}
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    focus() { document.activeElement = this; }
    remove() {}
  }
  document = { body: new Element(), getElementById: () => null, createElement: () => new Element() };
  const source = fs.readFileSync(path.join(__dirname, '../src/ui/panel.js'), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '') + '\nglobalThis.showPreview = showExportPreview;';
  const context = vm.createContext({ document, PANEL_COLORS: { border: '#333', text: '#fff' },
    getProviderConfig: () => ({ name: 'Prime Video', colors: { primary: '#09f' } }),
  });
  vm.runInContext(source, context);
  const view = { items: [], fileCount: 0, duplicateCount: 0, checking: true,
    rows: [{ item: { imdb_id: 'tt14507354', season: 1, episode: 1, _episodeTitle: '<script>unsafe</script>',
      segment_type: 'intro', start_sec: 12.5, end_sec: 88 }, status: 'Checking' }],
  };
  const update = context.showPreview(view);
  const dialog = document.body.children[0].children[0];
  const preview = dialog.children[2];
  const [close, download] = dialog.children[3].children;
  assert.equal(download.disabled, true);
  assert.equal(document.activeElement, close);
  assert.match(preview.children[0].children[1].textContent, /00:12.500 → 01:28.000/);
  assert.match(preview.children[0].children[1].textContent, /<script>unsafe<\/script>/);
  assert.equal(preview.children[0].children[1].children.length, 0);
  view.checking = false;
  view.rows[0].status = 'Unavailable';
  view.rows[0].reason = 'HTTP 400';
  update(view);
  assert.equal(Boolean(download.disabled), true);
  assert.match(preview.children[0].children[1].textContent, /HTTP 400/);
  let downloads = 0;
  view.items = [view.rows[0].item];
  view.rows[0].status = 'NEW';
  view.fileCount = 1;
  view.onConfirm = () => downloads++;
  update(view);
  assert.equal(download.disabled, false);
  download.listeners.click();
  assert.equal(downloads, 1);
});
