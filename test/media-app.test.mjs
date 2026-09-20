import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { chapterReport, collectVideos, identify, inspectFile } from '../app/media.mjs';
import { Debrid } from '../app/providers.mjs';
import { createApp } from '../app/server.mjs';
import { CredentialVault } from '../app/desktop/vault.cjs';

test('filename recognition never treats an ambiguous name as a confirmed movie', () => {
  assert.equal(identify('Show.S01E12.mkv').episode, 12);
  assert.equal(identify('Show.2x03.mp4').season, 2);
  assert.equal(identify('Film.2025.mkv').media_type, 'unknown');
  assert.equal(identify('Film.mkv', 'movie').media_type, 'movie');
  assert.equal(identify('Show.mkv', 'tv').episode, undefined);
});
test('chapters preserve precision and flag invalid, overlapping and out-of-duration ranges', () => {
  const report = chapterReport({ format: { duration: '100' }, chapters: [
    { start_time: '0', end_time: '10.123', tags: { title: 'Chapter 1' } },
    { start_time: '10.123', end_time: '40', tags: { title: 'Opening' } },
    { start_time: '39', end_time: '60', tags: { title: 'Recap' } },
    { start_time: '80', end_time: '105', tags: { title: 'Post-credits' } },
    { start_time: 'oops', end_time: '100' },
  ] }, 'Show.S01E02.mkv');
  assert.equal(report.chapters[0].end_sec, 10.123);
  assert.equal(report.chapters[0].suggestion, null);
  assert.equal(report.chapters[1].suggestion, 'intro');
  assert.equal(report.chapters[2].issues.length, 1);
  assert.equal(report.chapters[3].suggestion, 'post-credits');
  assert.equal(report.chapters[4].start_sec, null);
  assert.equal(report.status, 'review');
  assert.ok(report.chapters.every(c => c.needs_review));
  assert.equal(chapterReport({}, 'film.mp4').status, 'no-chapters');
});
test('recursive local collection filters sidecars and deduplicates paths', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'chapter-app-')); t.after(() => rm(folder, { recursive: true, force: true }));
  await mkdir(path.join(folder, 'season'));
  await Promise.all(['season/S01E02.mkv', 'season/S01E01.mp4', 'notes.txt'].map(file => writeFile(path.join(folder, file), 'fixture')));
  const files = await collectVideos([folder, path.join(folder, 'season/S01E01.mp4')]);
  assert.equal(files.length, 2); assert.ok(files[0].endsWith('S01E01.mp4'));
  await assert.rejects(collectVideos(['https://example.com/movie.mkv']), /lokaal/);
  await assert.rejects(inspectFile(files[0], { executable: 'nonexistent-ffprobe-test-binary' }), /ffprobe ontbreekt/);
});
test('TorBox adapter validates envelopes, file ID zero, readiness and private download-link lookup', async () => {
  const calls = [];
  const provider = new Debrid('torbox', 'private-token', async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('requestdl')) return Response.json({ success: true, data: 'https://cdn.example/media.mkv' });
    return Response.json({ success: true, data: { id: 0, name: 'Season', download_finished: true, download_present: true, files: [{ id: 0, name: 'S01E01.mkv', size: 100 }, { id: 1, name: 'readme.txt' }] } });
  });
  assert.equal((await provider.details('0')).files.length, 1);
  assert.equal(await provider.downloadLink('0', '0'), 'https://cdn.example/media.mkv');
  assert.ok(calls.at(-1).url.includes('file_id=0'));
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer private-token');
  const failed = new Debrid('torbox', 'key', async () => Response.json({ success: false, detail: 'secret data' }));
  await assert.rejects(failed.list(), e => !e.message.includes('secret data'));
});
test('Real-Debrid maps links over all selected files including sidecars', async () => {
  const provider = new Debrid('real-debrid', 'key', async (url, opts) => {
    if (url.endsWith('/unrestrict/link')) { assert.equal(opts.body.get('link'), 'https://host/video'); return Response.json({ download: 'https://cdn/video' }); }
    return Response.json({ id: 'abc', filename: 'Season', status: 'downloaded', files: [{ id: 1, path: '/readme.txt', selected: 1 }, { id: 2, path: '/S01E01.mkv', selected: 1 }], links: ['https://host/readme', 'https://host/video'] });
  });
  assert.equal(await provider.downloadLink('abc', '2'), 'https://cdn/video');
});
test('provider pagination and select-all request bodies', async () => {
  const calls = [];
  const p = new Debrid('real-debrid', 'key', async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('/torrents?')) return Response.json(url.includes('offset=0') ? Array.from({ length: 100 }, (_, id) => ({ id, filename: 'pack' })) : []);
    return new Response(null, { status: 204 });
  });
  assert.equal((await p.list()).length, 100);
  assert.ok(calls[1].url.includes('offset=100'));
  await p.selectAll('a/b'); assert.ok(calls.at(-1).url.endsWith('a%2Fb')); assert.equal(calls.at(-1).opts.body.get('files'), 'all');
});
async function start(t, options) {
  const app = createApp(options); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  const { token } = await (await fetch(base + '/api/session')).json();
  const request = (route, body, headers = {}) => fetch(base + '/api/' + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-App-Token': token, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { base, request };
}
async function until(request, condition) {
  for (let i = 0; i < 100; i++) { const state = await (await request('status')).json(); if (condition(state.jobs)) return state.jobs; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('Queue did not reach expected state');
}
test('local API blocks foreign origins and unauthorized requests; queue survives one failed episode', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'chapter-api-')); t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(path.join(folder, 'S01E01.mkv'), 'bad'); await writeFile(path.join(folder, 'S01E02.mkv'), 'ok');
  const { base, request } = await start(t, { probe: async file => { if (file.endsWith('01.mkv')) throw new Error('Bad file'); return chapterReport({}, path.basename(file)); } });
  assert.equal((await fetch(base + '/api/status')).status, 403);
  assert.equal((await request('status', undefined, { Origin: 'https://evil.example' })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => { http.get(base + '/api/session', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject); });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await request('local', { paths: [folder] })).status, 202);
  const jobs = await until(request, j => j.length === 2 && j[1].status === 'done');
  assert.equal(jobs[0].status, 'error'); assert.equal(jobs[1].report.episode, 2);
});
test('pack queue omits credentials, contains filenames and supports cancellation', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'chapter-download-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const files = [{ id: '0', name: '../../S01E01.mkv', downloadable: true, link: 'sensitive-link' }, { id: '1', name: 'S01E02.mkv', downloadable: true }];
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  const downloaded = [];
  const { request } = await start(t, { downloadDir: folder, providerFactory: () => ({ token: 'secret', list: async () => [], details: async () => ({ ready: true, files }), downloadLink: async () => 'https://cdn/file' }), downloader: async (url, dest, signal) => { downloaded.push(dest); await gate; signal.throwIfAborted(); }, probe: async file => chapterReport({}, path.basename(file)) });
  await request('connect', { provider: 'torbox', token: 'secret' });
  const visible = await (await request('files', { provider: 'torbox', id: 'pack' })).text(); assert.ok(!visible.includes('sensitive-link'));
  assert.equal((await request('download', { provider: 'torbox', id: 'pack', files: ['0', '1'] })).status, 202);
  const current = await until(request, j => j.some(x => x.status === 'downloading'));
  await request('cancel', { id: current[1].id }); unblock();
  const final = await until(request, j => j[0].status === 'done');
  assert.equal(final[1].status, 'cancelled'); assert.equal(downloaded.length, 1);
  assert.ok(path.relative(folder, downloaded[0]).split(path.sep).length === 2);
  assert.ok(!JSON.stringify(final).includes('secret'));
});

test('clearing an earlier completed episode cannot skip later season-pack episodes', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'chapter-season-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const files = [1, 2, 3].map(id => ({ id: String(id), name: `S01E0${id}.mkv`, downloadable: true }));
  let release; const gate = new Promise(resolve => { release = resolve; });
  const downloaded = [];
  const { request } = await start(t, { downloadDir: folder, providerFactory: () => ({ list: async () => [], details: async () => ({ ready: true, files }), downloadLink: async (torrent, file) => `https://cdn/${file}` }), downloader: async (url, destination) => { downloaded.push(url); if (url.endsWith('/2')) await gate; }, probe: async file => chapterReport({}, path.basename(file)) });
  await request('connect', { provider: 'torbox', token: 'key' });
  await request('download', { provider: 'torbox', id: 'season', files: ['1', '2', '3'] });
  await until(request, jobs => jobs[0]?.status === 'done' && jobs[1]?.status === 'downloading');
  await request('clear', {}); release();
  const jobs = await until(request, jobs => jobs.length === 2 && jobs.every(j => j.status === 'done'));
  assert.equal(jobs[1].report.episode, 3);
  assert.deepEqual(downloaded, ['https://cdn/1', 'https://cdn/2', 'https://cdn/3']);
});

test('TorBox aggregates torrents, Usenet and webdownloads without colliding IDs; cached alone is not ready', async () => {
  const calls = [];
  const p = new Debrid('torbox', 'key', async url => {
    calls.push(url);
    return Response.json({ success: true, data: [{ id: 1, name: 'Film.mkv', cached: true, download_finished: true, download_present: !url.includes('/usenet/'), size: 123, files: [{ name: 'Film.mkv' }] }] });
  });
  const result = await p.library();
  assert.deepEqual(result.torrents.map(t => t.id), ['torrents:1', 'usenet:1', 'webdl:1']);
  assert.deepEqual(result.torrents.map(t => t.ready), [true, false, true]);
  assert.ok(calls.every(url => url.includes('bypass_cache=true')));
  assert.ok(result.torrents.every(t => t.videoCount === 1));
});

test('one unavailable TorBox source does not hide the other libraries', async () => {
  const p = new Debrid('torbox', 'key', async url => url.includes('/usenet/') ? new Response(null, { status: 403 }) : Response.json({ success: true, data: [{ id: 1, name: 'Film' }] }));
  const result = await p.library(); assert.equal(result.torrents.length, 2); assert.equal(result.warnings.length, 1);
  await assert.rejects(p.library({ source: 'other' }), /Onbekend/);
});

for (const [source, idKey] of [['torrents', 'torrent_id'], ['usenet', 'usenet_id'], ['webdl', 'web_id']]) {
  test(`TorBox ${source} uses actual library file IDs for direct links, without adding content`, async () => {
    const calls = [];
    const p = new Debrid('torbox', 'private', async (url, options) => {
      calls.push({ url, options });
      return Response.json({ success: true, data: url.includes('/requestdl') ? 'https://cdn.example/video.mkv' : { id: 7, download_present: true, download_finished: true, files: [{ id: 42, name: 'S01E01.mkv' }] } });
    });
    await p.downloadLink(`${source}:7`, '42');
    const request = new URL(calls[1].url);
    assert.ok(calls[0].url.includes(`/${source}/mylist?id=7`));
    assert.equal(request.pathname, `/v1/api/${source}/requestdl`);
    assert.equal(request.searchParams.get(idKey), '7'); assert.equal(request.searchParams.get('file_id'), '42');
    assert.ok(calls.every(call => call.options.method === 'GET'));
  });
}

test('remote chapter inspection does not invoke downloader or expose signed URLs', async t => {
  let downloads = 0;
  const { request } = await start(t, {
    providerFactory: () => ({ list: async () => [], details: async () => ({ ready: true, files: [{ id: '1', name: 'Film.mkv', downloadable: true }] }), downloadLink: async () => 'https://cdn/file?secret=signed' }),
    downloader: async () => { downloads++; },
    remoteProbe: async (url, name, options) => { assert.ok(url.includes('signed')); return chapterReport({}, name, options.mode); },
  });
  await request('connect', { provider: 'torbox', token: 'key' });
  assert.equal((await request('inspect-provider', { provider: 'torbox', id: '7', files: ['1'], mode: 'movie' })).status, 202);
  const jobs = await until(request, jobs => jobs[0]?.status === 'done');
  assert.equal(downloads, 0); assert.equal(jobs[0].report.media_type, 'movie'); assert.equal(jobs[0].savedPath, undefined);
  assert.ok(!JSON.stringify(jobs).includes('signed'));
});

test('credential vault persists only encryption output, serializes updates and removes accounts', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'chapter-vault-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'accounts.json');
  const vault = new CredentialVault(file, { encrypt: async text => Buffer.from([...text].reverse().join('')), decrypt: async buf => [...buf.toString()].reverse().join('') });
  await Promise.all([vault.save('torbox', 'private-one'), vault.save('real-debrid', 'private-two')]);
  assert.equal(await vault.get('torbox'), 'private-one'); assert.equal((await vault.list()).length, 2);
  assert.ok(!(await readFile(file, 'utf8')).includes('private-one'));
  await vault.remove('torbox'); assert.deepEqual(await vault.list(), ['real-debrid']);
  await assert.rejects(vault.get('torbox'), /Geen opgeslagen/);
});

test('stored account restore keeps keys inside backend and disconnect removes remembered account', async t => {
  let stored = null;
  const { request } = await start(t, { credentialStore: { list: async () => stored ? ['torbox'] : [], save: async (p, token) => { stored = token; }, get: async () => stored, remove: async () => { stored = null; } },
    providerFactory: (p, token) => { assert.equal(token, 'private-key'); return { list: async () => [] }; } });
  await request('connect', { provider: 'torbox', token: 'private-key', remember: true }); assert.equal(stored, 'private-key');
  const result = await request('restore', { provider: 'torbox' }); assert.equal(result.status, 200); assert.ok(!(await result.text()).includes('private-key'));
  await request('disconnect', { provider: 'torbox' }); assert.equal(stored, null);
});

const ffmpeg = path.resolve('vendor/ffmpeg/ffmpeg.exe'), ffprobe = path.resolve('vendor/ffmpeg/ffprobe.exe');
test('bundled ffprobe reads real MKV chapter timestamps and handles video without chapters', { skip: !existsSync(ffmpeg) || !existsSync(ffprobe) }, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'chapter-real-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const metadata = path.join(folder, 'chapters.txt'), video = path.join(folder, 'S01E02.mkv'), plain = path.join(folder, 'Film.mp4');
  await writeFile(metadata, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Intro\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2000\ntitle=Credits\n');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1:d=2', '-i', metadata, '-map_metadata', '1', '-map_chapters', '1', '-c:v', 'libx264', video], { windowsHide: true });
  const report = await inspectFile(video, { executable: ffprobe });
  assert.equal(report.chapters.length, 2); assert.equal(report.chapters[0].suggestion, 'intro'); assert.equal(report.chapters[1].start_sec, 1); assert.equal(report.episode, 2);
  execFileSync(ffmpeg, ['-v', 'error', '-i', video, '-map_chapters', '-1', '-map_metadata', '-1', '-c', 'copy', plain], { windowsHide: true });
  const empty = await inspectFile(plain, { executable: ffprobe, mode: 'movie' }); assert.equal(empty.status, 'no-chapters');
});
