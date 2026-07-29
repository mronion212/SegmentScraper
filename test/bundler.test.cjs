const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.join(__dirname, '..');
const bundlerPath = path.join(projectRoot, 'build', 'bundler.js');
const userscriptPath = path.join(projectRoot, 'SegmentScraper.user.js');

function generateInMemory() {
  let output = null;
  const logs = [];
  const fsProxy = {
    ...fs,
    writeFileSync(filePath, content, encoding) {
      output = { filePath, content, encoding };
    },
  };
  const context = vm.createContext({
    Buffer,
    __dirname: path.dirname(bundlerPath),
    console: { log: (...args) => logs.push(args) },
    require(moduleName) {
      if (moduleName === 'fs') return fsProxy;
      return require(moduleName);
    },
  });

  vm.runInContext(fs.readFileSync(bundlerPath, 'utf8'), context, { filename: bundlerPath });
  assert.ok(output, 'bundler did not produce output');
  return { ...output, logs, transformCode: context.transformCode };
}

test('bundler produces the tracked userscript deterministically with LF line endings', () => {
  const first = generateInMemory();
  const second = generateInMemory();
  const trackedUserscript = fs.readFileSync(userscriptPath, 'utf8');

  assert.equal(first.filePath, userscriptPath);
  assert.equal(first.encoding, 'utf8');
  assert.equal(first.content, second.content);
  assert.equal(first.content, trackedUserscript);
  assert.doesNotMatch(first.content, /\r/);
  assert.match(first.content, /^\/\/ ==UserScript==\n/);
  assert.doesNotMatch(first.content, /^[ \t]*(?:import|export)\b/m);
  assert.doesNotMatch(first.content, /const _unsafeWindow\b/);
  assert.doesNotThrow(() => new vm.Script(first.content, { filename: 'SegmentScraper.user.js' }));

  const sizeLog = first.logs.flat().find(entry => /^Total size:/.test(entry));
  assert.equal(sizeLog, `Total size: ${Buffer.byteLength(first.content, 'utf8')} bytes`);
});

test('module transformation preserves code immediately following imports', () => {
  const { transformCode } = generateInMemory();
  const transformed = transformCode([
    "import { dependency } from './dependency.js';",
    "const endpoint = 'https://example.test/path';",
    'export async function load() { return dependency; }',
    'export const matcher = /https?:\\/\\//;',
  ].join('\n'));

  assert.equal(transformed, [
    "const endpoint = 'https://example.test/path';",
    'async function load() { return dependency; }',
    'const matcher = /https?:\\/\\//;',
  ].join('\n'));
});

test('temporarily excludes Apple TV from the distributed userscript', () => {
  const { content } = generateInMemory();

  assert.doesNotMatch(content, /@match\s+https:\/\/tv\.apple\.com\/\*/);
  assert.doesNotMatch(content, /Apple TV provider registration/);
  assert.doesNotMatch(content, /function setupAppleTvInterception\b/);
});
