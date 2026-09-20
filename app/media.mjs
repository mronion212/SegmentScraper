import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const isVideo = name => /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts)$/i.test(name);
export function identify(name, mode = 'auto') {
  const match = name.match(/\bS(\d{1,2})E(\d{1,3})(?!\d)/i) || name.match(/\b(\d{1,2})x(\d{1,3})(?!\d)/i);
  if (mode !== 'movie' && match) return { media_type: 'tv', season: +match[1], episode: +match[2], identity_source: 'filename' };
  return { media_type: mode === 'tv' ? 'tv' : mode === 'movie' ? 'movie' : 'unknown', identity_source: 'manual-review' };
}
export function chapterReport(data, name, mode) {
  const rawDuration = Number(data.format?.duration);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null;
  let previousEnd = 0;
  const chapters = (data.chapters || []).map((c, index) => {
    const start = c.start_time == null ? NaN : Number(c.start_time);
    const end = c.end_time == null ? NaN : Number(c.end_time);
    const title = String(c.tags?.title || c.tags?.TITLE || `Chapter ${index + 1}`);
    const issues = [];
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) issues.push('Ongeldige tijdgrenzen');
    if (Number.isFinite(start) && start < previousEnd - 0.01) issues.push('Overlappende of ongeordende chapters');
    if (duration && end > duration + 0.1) issues.push('Chapter valt buiten de speelduur');
    if (Number.isFinite(end)) previousEnd = Math.max(previousEnd, end);
    // Names are hints only; generic chapter numbers never imply intro/outro.
    const suggestion = /\b(post[- ]?credits?|after[- ]?credits?)\b/i.test(title) ? 'post-credits'
      : /\b(recap|previously)\b/i.test(title) ? 'recap'
      : /\b(intro|opening|op)\b/i.test(title) ? 'intro'
      : /\b(credits|outro|ending|ed)\b/i.test(title) ? 'outro' : null;
    return { title, start_sec: Number.isFinite(start) ? start : null, end_sec: Number.isFinite(end) ? end : null, suggestion, needs_review: true, issues };
  });
  return { name, ...identify(name, mode), duration, status: !chapters.length ? 'no-chapters' : chapters.some(c => c.issues.length) ? 'review' : 'checked', chapters };
}
export async function inspectFile(file, { mode = 'auto', signal, executable = process.env.FFPROBE_PATH || 'ffprobe' } = {}) {
  try {
    const { stdout } = await exec(executable, ['-v', 'error', '-protocol_whitelist', 'file,crypto,data', '-show_chapters', '-show_format', '-of', 'json', '-i', path.resolve(file)], { signal, timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return chapterReport(JSON.parse(stdout), path.basename(file), mode);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(error.code === 'ENOENT' ? 'ffprobe ontbreekt. Installeer FFmpeg of stel FFPROBE_PATH in.' : 'Chaptercontrole mislukt: bestand onleesbaar, beschadigd of tijdslimiet bereikt.');
  }
}
export async function inspectRemote(url, name, { mode = 'auto', signal, executable = process.env.FFPROBE_PATH || 'ffprobe' } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Ongeldige providerlink.');
  try {
    const { stdout } = await exec(executable, ['-v', 'error', '-rw_timeout', '15000000', '-protocol_whitelist', 'https,http,tls,tcp,crypto', '-show_chapters', '-show_format', '-of', 'json', '-i', url], { signal, timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return chapterReport(JSON.parse(stdout), name, mode);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(error.code === 'ENOENT' ? 'ffprobe ontbreekt.' : 'Controle via de provider mislukt. Download het bestand en controleer het lokaal.');
  }
}
export async function probeAvailable() {
  try { await exec(process.env.FFPROBE_PATH || 'ffprobe', ['-version'], { timeout: 5000, windowsHide: true }); return true; } catch { return false; }
}
export async function collectVideos(inputs) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 100) throw new Error('Geef 1–100 lokale bestanden of mappen op.');
  const files = new Set();
  async function visit(file, depth = 0) {
    if (depth > 30 || files.size >= 5000) throw new Error('Map te groot: maximaal 5000 bestanden en 30 niveaus.');
    const info = await stat(file);
    if (info.isDirectory()) {
      for (const entry of await readdir(file, { withFileTypes: true })) {
        if (!entry.isSymbolicLink() && (entry.isDirectory() || isVideo(entry.name))) await visit(path.join(file, entry.name), depth + 1);
      }
    } else if (info.isFile() && isVideo(file)) files.add(path.resolve(file));
  }
  for (const input of inputs) {
    if (typeof input !== 'string' || !path.isAbsolute(input) || input.startsWith('\\\\')) throw new Error('Gebruik een absoluut lokaal pad, geen netwerk- of URL-pad.');
    await visit(input);
  }
  return [...files].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
