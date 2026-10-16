import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCore } from './shared-core.mjs';

const { timestampNumber, timestampRangeIssue, timestampEvidence } = createCore({ request() {} });

const exec = promisify(execFile);
export const isVideo = name => /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts)$/i.test(name);
function parseDuration(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const match = String(value ?? '').trim().match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const hours = Number(match[1] || 0), minutes = Number(match[2]), seconds = Number(match[3]);
  return Number.isFinite(hours) && Number.isFinite(minutes) && Number.isFinite(seconds) ? hours * 3600 + minutes * 60 + seconds : null;
}
function streamDuration(stream) {
  for (const value of [stream?.duration, stream?.tags?.DURATION, stream?.tags?.duration]) {
    const parsed = parseDuration(value);
    if (parsed) return parsed;
  }
  const timestamp = Number(stream?.duration_ts), [numerator, denominator] = String(stream?.time_base || '').split('/').map(Number);
  return Number.isFinite(timestamp) && timestamp > 0 && Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 ? timestamp * numerator / denominator : null;
}
export function identify(name, mode = 'auto') {
  const match = name.match(/\bS(\d{1,2})E(\d{1,3})(?!\d)/i) || name.match(/\b(\d{1,2})x(\d{1,3})(?!\d)/i);
  if (mode !== 'movie' && match) return { media_type: 'tv', season: +match[1], episode: +match[2], identity_source: 'filename' };
  return { media_type: mode === 'tv' ? 'tv' : mode === 'movie' ? 'movie' : 'unknown', identity_source: 'manual-review' };
}
export function chapterReport(data, name, mode) {
  const rawDuration = Number(data.format?.duration);
  const videoStream = (data.streams || []).find(stream => stream?.codec_type === 'video');
  const rawVideoDuration = streamDuration(videoStream);
  const videoDuration = Number.isFinite(rawVideoDuration) && rawVideoDuration > 0
    ? (Number.isFinite(rawDuration) && rawDuration > 0 ? Math.min(rawDuration, rawVideoDuration) : rawVideoDuration)
    : null;
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : videoDuration;
  let previousEnd = 0;
  const chapters = (data.chapters || []).map((c, index) => {
    const start = timestampNumber(c.start_time);
    const end = timestampNumber(c.end_time);
    const title = String(c.tags?.title || c.tags?.TITLE || `Chapter ${index + 1}`);
    const issues = [];
    if (timestampRangeIssue({ start_sec: start, end_sec: end })) issues.push('Invalid time boundaries');
    if (Number.isFinite(start) && start < previousEnd - 0.01) issues.push('Overlapping or unordered chapters');
    if ((videoDuration || duration) && end > (videoDuration || duration)) issues.push('Chapter exceeds video duration');
    if (Number.isFinite(end)) previousEnd = Math.max(previousEnd, end);
    // Names are hints only; generic chapter numbers never imply intro/outro.
    const suggestion = /\b(post[- ]?credits?|after[- ]?credits?)\b/i.test(title) ? 'post-credits'
      : /\b(recap|previously)\b/i.test(title) ? 'recap'
      : /\b(intro|opening|op)\b/i.test(title) ? 'intro'
      : /\b(credits|outro|ending|ed)\b/i.test(title) ? 'outro' : null;
    return { title, start_sec: start, end_sec: end, suggestion, needs_review: true, issues,
      _timing: timestampEvidence({ provider: 'desktop', source: 'chapter', rawStart: start, rawEnd: end }) };
  });
  const diagnostics = [];
  if (!chapters.length) diagnostics.push('ffprobe returned no embedded chapters. This does not mean the video has no intro or credits. Provider skip markers are separate metadata.');
  if (duration && duration < 600) diagnostics.push('Short video: check whether this is a trailer, sample, or short feature before identifying it.');
  return { name, ...identify(name, mode), duration, video_duration: videoDuration, container: data.format?.format_name || null, diagnostics, status: !chapters.length ? 'no-chapters' : chapters.some(c => c.issues.length) ? 'review' : 'checked', chapters };
}
export async function inspectFile(file, { mode = 'auto', signal, executable = process.env.FFPROBE_PATH || 'ffprobe' } = {}) {
  try {
    const { stdout } = await exec(executable, ['-v', 'error', '-protocol_whitelist', 'file,crypto,data', '-show_chapters', '-show_streams', '-show_format', '-of', 'json', '-i', path.resolve(file)], { signal, timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return chapterReport(JSON.parse(stdout), path.basename(file), mode);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(error.code === 'ENOENT' ? 'ffprobe is missing. Install FFmpeg or configure FFPROBE_PATH.' : 'Chapter inspection failed: unreadable or damaged file, or timeout.');
  }
}
export async function inspectRemote(url, name, { mode = 'auto', signal, executable = process.env.FFPROBE_PATH || 'ffprobe' } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Invalid provider link.');
  try {
    const { stdout } = await exec(executable, ['-v', 'error', '-rw_timeout', '60000000', '-protocol_whitelist', 'https,http,tls,tcp,crypto', '-show_chapters', '-show_streams', '-show_format', '-of', 'json', '-i', url], { signal, timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return chapterReport(JSON.parse(stdout), name, mode);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(error.code === 'ENOENT' ? 'ffprobe is missing.' : 'Remote inspection failed. Download the file and inspect it locally.');
  }
}
export async function probeAvailable() {
  try { await exec(process.env.FFPROBE_PATH || 'ffprobe', ['-version'], { timeout: 5000, windowsHide: true }); return true; } catch { return false; }
}
export async function collectVideos(inputs) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 100) throw new Error('Provide 1–100 local files or folders.');
  const files = new Set();
  async function visit(file, depth = 0) {
    if (depth > 30 || files.size >= 5000) throw new Error('Folder too large: maximum 5000 files and 30 levels.');
    const info = await stat(file);
    if (info.isDirectory()) {
      for (const entry of await readdir(file, { withFileTypes: true })) {
        if (!entry.isSymbolicLink() && (entry.isDirectory() || isVideo(entry.name))) await visit(path.join(file, entry.name), depth + 1);
      }
    } else if (info.isFile() && isVideo(file)) files.add(path.resolve(file));
  }
  for (const input of inputs) {
    if (typeof input !== 'string' || !path.isAbsolute(input) || input.startsWith('\\\\')) throw new Error('Use an absolute local path, not a network path or URL.');
    await visit(input);
  }
  return [...files].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
