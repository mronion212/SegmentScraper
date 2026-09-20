import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const buildRoot = path.join(root, '.media-build');
const vendor = path.join(root, 'vendor', 'ffmpeg');
const archiveName = 'ffmpeg-9.0.1-essentials_build.7z';
const archive = path.join(buildRoot, archiveName);
const expectedHash = '49a73bdf0850092a252ac4641d922f3048d63ed113e196cc65ce1e4f7fb33e85';
await mkdir(buildRoot, { recursive: true }); await mkdir(vendor, { recursive: true });
if (!existsSync(archive)) {
  const response = await fetch(`https://www.gyan.dev/ffmpeg/builds/packages/${archiveName}`, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`FFmpeg download failed (${response.status})`);
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
}
if (createHash('sha256').update(await readFile(archive)).digest('hex') !== expectedHash) throw new Error('FFmpeg archive checksum mismatch; remove the archive and retry.');
execFileSync('tar', ['-xf', archive, '-C', buildRoot], { windowsHide: true });
const extracted = path.join(buildRoot, 'ffmpeg-9.0.1-essentials_build');
for (const file of ['ffprobe.exe', 'ffmpeg.exe']) await copyFile(path.join(extracted, 'bin', file), path.join(vendor, file));
for (const file of ['LICENSE', 'README.txt']) await copyFile(path.join(extracted, file), path.join(vendor, file));
console.log(execFileSync(path.join(vendor, 'ffprobe.exe'), ['-version'], { windowsHide: true, encoding: 'utf8' }).split('\n')[0]);
