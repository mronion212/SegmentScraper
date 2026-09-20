import { mkdir, readFile, writeFile, copyFile, readdir, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const buildRoot = path.join(root, '.media-build');
const vendor = path.join(root, 'vendor', 'ffmpeg');
const archiveName = 'ffmpeg-release-essentials.7z';
const archive = path.join(buildRoot, archiveName);

await mkdir(buildRoot, { recursive: true });
await mkdir(vendor, { recursive: true });

const hashResponse = await fetch('https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.7z.sha256');
if (!hashResponse.ok) throw new Error(`FFmpeg checksum download failed (${hashResponse.status})`);
const expectedHash = (await hashResponse.text()).trim().split(/\s+/)[0];

if (!existsSync(archive)) {
  const response = await fetch('https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.7z', { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`FFmpeg download failed (${response.status})`);
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
}

if (createHash('sha256').update(await readFile(archive)).digest('hex') !== expectedHash)
  throw new Error('FFmpeg archive checksum mismatch; remove the archive and retry.');

// Isolate extraction so an older cached directory cannot silently win selection.
const extractionRoot = await mkdtemp(path.join(buildRoot, 'extract-'));
execFileSync('tar', ['-xf', archive, '-C', extractionRoot], { windowsHide: true });

const dirs = await readdir(extractionRoot);
const extractedName = dirs.find(name => /^ffmpeg-.+-essentials_build$/.test(name));
if (!extractedName) throw new Error('Extracted FFmpeg directory not found.');

const extracted = path.join(extractionRoot, extractedName);

for (const file of ['ffprobe.exe', 'ffmpeg.exe'])
  await copyFile(path.join(extracted, 'bin', file), path.join(vendor, file));

for (const file of ['LICENSE', 'README.txt'])
  await copyFile(path.join(extracted, file), path.join(vendor, file));

console.log(execFileSync(path.join(vendor, 'ffprobe.exe'), ['-version'], { windowsHide: true, encoding: 'utf8' }).split('\n')[0]);
