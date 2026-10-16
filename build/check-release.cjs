const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function validateRelease({ version, lockVersion, scriptVersion, notes, baseVersion }) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Use a stable major.minor.patch release version.');
  if (lockVersion !== version || scriptVersion !== version) throw new Error('Package, lockfile and userscript versions must match.');
  if (!String(notes || '').trim()) throw new Error(`Add release-notes/${version}.md before publishing an update.`);
  if (baseVersion != null) {
    if (!/^\d+\.\d+\.\d+$/.test(baseVersion)) throw new Error('The base release version is invalid.');
    const next = version.split('.').map(Number), previous = baseVersion.split('.').map(Number);
    const difference = next.findIndex((value, index) => value !== previous[index]);
    if (difference < 0 || next[difference] < previous[difference]) throw new Error('Every update to main must increase the release version.');
  }
  return `v${version}`;
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  if (lock.packages?.['']?.version !== version) throw new Error('Lockfile root package version must match.');
  const script = fs.readFileSync(path.join(root, 'SegmentScraper.user.js'), 'utf8');
  const notesPath = path.join(root, 'release-notes', `${version}.md`);
  const baseRef = process.argv[2];
  const baseVersion = baseRef ? JSON.parse(execFileSync('git', ['show', `${baseRef}:package.json`], { cwd: root, encoding: 'utf8' })).version : undefined;
  const tag = validateRelease({ version, lockVersion: lock.version, scriptVersion: script.match(/^\/\/ @version\s+(\S+)/m)?.[1],
    notes: fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : '', baseVersion });
  console.log(`Release metadata verified: ${tag}`);
}

module.exports = { validateRelease };
