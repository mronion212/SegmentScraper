const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('approval supports individual, series and all selection while excluding duplicates', () => {
  let document;
  class Element {
    constructor(tag) { this.tag=tag;this.style={};this.children=[];this.listeners={}; }
    setAttribute() {} append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;}
    addEventListener(event,handler){this.listeners[event]=handler;} focus(){document.activeElement=this;} remove(){}
  }
  document={body:new Element('body'),getElementById:()=>null,createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text})};
  const context=vm.createContext({document,PANEL_COLORS:{},getProviderConfig:()=>({name:'Netflix',colors:{}})});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/core/output-policy.js'),'utf8').replace(/^export /gm,''),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/ui/panel.js'),'utf8').replace(/^import .*$/gm,'').replace(/^export /gm,'')+'\nglobalThis.showPreview=showExportPreview;',context);
  const items=[1,2,3,4].map((episode,i)=>({imdb_id:i<2?'tt1234567':'tt7654321',season:1,episode,segment_type:'intro',start_sec:10,end_sec:30}));
  let submitted;
  const view={mode:'submit',items,rows:items.map((item,i)=>({item,status:i===3?'In IntroDB':'NEW'})),duplicateCount:1,onConfirm:selection=>{submitted=selection;}};
  context.showPreview(view);
  const dialog=document.body.children[0].children[0],preview=dialog.children[2],upload=dialog.children[3].children[1];
  const labels=()=>preview.children.filter(node=>node.tag==='label');
  const rows=()=>preview.children.filter(node=>node.tag==='div');
  const toggle=(label,value)=>{const input=label.children[0];input.checked=value;input.listeners.change();};
  assert.equal(upload.disabled,true);
  toggle(rows()[0].children[3],true);
  assert.equal(upload.textContent,'Upload to IntroDB (1)');
  assert.equal(labels()[1].children[0].indeterminate,true);
  toggle(labels()[1],true);
  assert.equal(upload.textContent,'Upload to IntroDB (2)');
  toggle(labels()[0],true);
  assert.equal(upload.textContent,'Upload to IntroDB (3)');
  assert.equal(rows()[3].children.length,3);
  toggle(rows()[1].children[3],false);
  upload.listeners.click();
  assert.deepEqual(Array.from(submitted,item=>item.episode),[1,3]);
});

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
  document = { body: new Element(), getElementById: () => null, createElement: () => new Element(), createTextNode: text => Object.assign(new Element(), { textContent: text }) };
  const source = fs.readFileSync(path.join(__dirname, '../src/ui/panel.js'), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '') + '\nglobalThis.showPreview = showExportPreview;';
  const context = vm.createContext({ document, PANEL_COLORS: { border: '#333', text: '#fff' },
    getProviderConfig: () => ({ name: 'Prime Video', colors: { primary: '#09f' } }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/core/output-policy.js'), 'utf8').replace(/^export /gm, ''), context);
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
  assert.match(preview.children[0].children[1].textContent, /<script>unsafe<\/script>/);
  assert.equal(preview.children[0].children[1].children.length, 0);
  assert.match(preview.children[0].children[2].children[0].children[2].textContent, /^00:00:12.500 → 00:01:28.000\n/);
  assert.match(preview.children[0].children[2].children[0].children[2].textContent, /0h 00m 12.500s → 0h 01m 28.000s$/);
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

test('timestamp comparison puts Scraper left, IntroDB right, and gates direct upload approval', () => {
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
  document = {
    body: new Element(),
    getElementById: () => null,
    createElement: () => new Element(),
    createTextNode: text => Object.assign(new Element(), { textContent: text }),
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/ui/panel.js'), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '') + '\nglobalThis.showPreview = showExportPreview;';
  const context = vm.createContext({ document, PANEL_COLORS: { border: '#333', text: '#fff' },
    getProviderConfig: () => ({ name: 'Netflix', colors: { primary: '#09f' } }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/core/output-policy.js'), 'utf8').replace(/^export /gm, ''), context);
  vm.runInContext(source, context);
  const item = { imdb_id: 'tt1234567', media_type: 'movie', season: null, episode: null, segment_type: 'outro', start_sec: 5756, end_sec: 6250 };
  let downloads = 0, uploads = 0;
  context.showPreview({
    mode: 'export', items: [item], uploadItems: [item], fileCount: 1, duplicateCount: 1, checking: false,
    requiresApproval: true,
    rows: [{ item, status: 'NEW', existingSegments: [{ segment_type: 'outro', start_sec: 5762, end_sec: 6250 }] }],
    onConfirm: () => downloads++,
    onUpload: () => uploads++,
  });
  const dialog = document.body.children[0].children[0], preview = dialog.children[2], actions = dialog.children[3];
  const row = preview.children[2], comparison = row.children[2], scraper = comparison.children[0], introdb = comparison.children[1];
  assert.equal(row.children[0].textContent, 'NEW');
  assert.match(row.children[1].textContent, /Movie/);
  assert.doesNotMatch(row.children[1].textContent, /TVDB/);
  assert.equal(scraper.children[0].textContent, 'Scraper');
  assert.equal(introdb.children[0].textContent, 'IntroDB');
  assert.match(scraper.children[2].textContent, /^01:35:56.000 → 01:44:10.000\n/);
  assert.match(scraper.children[2].textContent, /1h 35m 56.000s → 1h 44m 10.000s$/);
  assert.match(introdb.children[2].textContent, /^01:36:02.000 → 01:44:10.000\n/);
  const upload = actions.children[2];
  assert.equal(upload.disabled, true);
  const approval = row.children[3].children[0];
  approval.checked = true;
  approval.listeners.change();
  assert.equal(upload.disabled, false);
  upload.listeners.click();
  assert.equal(uploads, 1);
  assert.equal(downloads, 0);
});
