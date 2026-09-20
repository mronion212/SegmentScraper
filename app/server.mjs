import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { collectVideos, inspectFile, inspectRemote, probeAvailable } from './media.mjs';
import { Debrid } from './providers.mjs';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const terminal = new Set(['done', 'error', 'cancelled']);
export function createApp({ downloadDir = path.resolve('app-data/downloads'), probe = inspectFile, remoteProbe = inspectRemote, credentialStore, providerFactory = (p, t) => new Debrid(p, t), downloader = downloadFile } = {}) {
  const secret = randomBytes(32).toString('hex');
  const jobs = [], connections = new Map();
  let running = false;
  const library = async (provider, source = 'all') => provider.library ? provider.library({ fresh: true, source }) : { torrents: await provider.list({ fresh: true }), warnings: [] };
  const view = job => ({ id: job.id, name: job.name, status: job.status, remote: job.remote === true, bytes: job.bytes, total: job.total, error: job.error, report: job.report, savedPath: job.savedPath });
  async function work() {
    if (running) return;
    running = true;
    try {
      // Completed jobs may be cleared while another job is awaiting I/O.
      // Re-select from the queue so array mutations cannot skip an episode.
      let job;
      while ((job = jobs.find(item => item.status === 'queued'))) {
        try {
          const signal = job.controller.signal;
          let local = job.local;
          if (job.provider) {
            job.status = job.remote ? 'checking' : 'downloading';
            const url = await job.provider.downloadLink(job.torrentId, job.fileId, signal);
            if (job.remote) {
              job.report = await remoteProbe(url, job.name, { mode: job.mode, signal });
              signal.throwIfAborted(); job.status = 'done'; continue;
            }
            const folder = path.join(job.downloadDir, job.id);
            await mkdir(folder, { recursive: true });
            const basename = path.basename(job.name.replaceAll('\\', '/')).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(-180);
            local = path.join(folder, `media-${basename}`);
            await downloader(url, local, signal, (bytes, total) => { job.bytes = bytes; job.total = total; });
            job.savedPath = local;
          }
          signal.throwIfAborted();
          job.status = 'checking';
          job.report = await probe(local, { mode: job.mode, signal });
          signal.throwIfAborted();
          job.status = 'done';
        } catch (error) {
          job.status = job.controller.signal.aborted ? 'cancelled' : 'error';
          job.error = job.status === 'cancelled' ? null : (job.provider ? 'Download of controle mislukt. Controleer providerstatus, schijfruimte en ffprobe. Een voltooide download blijft bewaard.' : error.message);
        } finally { job.provider = undefined; }
      }
    } finally { running = false; }
  }
  function enqueue(items, mode) {
    if (!['auto', 'tv', 'movie'].includes(mode)) throw new Error('Ongeldig mediatype.');
    if (!items.length) throw new Error('Geen videobestanden gevonden of geselecteerd.');
    if (jobs.filter(j => !terminal.has(j.status)).length + items.length > 5000) throw new Error('Wachtrij te groot.');
    jobs.push(...items.map(item => ({ ...item, downloadDir, id: randomUUID(), mode, status: 'queued', bytes: 0, controller: new AbortController() })));
    void work();
  }
  const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const expected = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== expected || (req.headers.origin && req.headers.origin !== `http://${expected}`) || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Alleen toegankelijk vanuit de lokale app.' });
    try {
      const url = new URL(req.url, `http://${expected}`);
      if (req.method === 'GET' && url.pathname === '/api/session') return send(res, 200, { token: secret });
      if (!url.pathname.startsWith('/api/')) {
        const assets = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
        const asset = assets[url.pathname];
        if (req.method !== 'GET' || !asset) return send(res, 404, { error: 'Niet gevonden.' });
        const content = await readFile(path.join(publicDir, asset[0]));
        res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-store' }); return res.end(content);
      }
      if (req.headers['x-app-token'] !== secret) return send(res, 403, { error: 'Ongeldige appsessie. Herlaad de pagina.' });
      if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { jobs: jobs.map(view), providers: [...connections.keys()], downloadDir });
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ffprobe: await probeAvailable(), savedProviders: credentialStore ? await credentialStore.list() : [] });
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return send(res, 400, { error: 'JSON-aanvraag vereist.' });
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1000000) return send(res, 413, { error: 'Aanvraag te groot.' }); }
      const body = JSON.parse(raw || '{}');
      if (url.pathname === '/api/local') {
        const files = await collectVideos(body.paths);
        enqueue(files.map(local => ({ local, name: path.basename(local) })), body.mode || 'auto');
        return send(res, 202, { count: files.length });
      }
      if (url.pathname === '/api/connect') {
        const provider = providerFactory(body.provider, body.token);
        const result = await library(provider, body.source);
        if (credentialStore && body.remember === true) await credentialStore.save(body.provider, body.token);
        else if (credentialStore) await credentialStore.remove(body.provider);
        connections.set(body.provider, provider);
        return send(res, 200, result);
      }
      if (url.pathname === '/api/restore') {
        if (!credentialStore) throw new Error('Opgeslagen accounts zijn alleen beschikbaar in de desktopapp.');
        const provider = providerFactory(body.provider, await credentialStore.get(body.provider));
        const result = await library(provider, body.source); connections.set(body.provider, provider);
        return send(res, 200, result);
      }
      if (url.pathname === '/api/disconnect') { connections.delete(body.provider); if (credentialStore) await credentialStore.remove(body.provider); return send(res, 200, { ok: true }); }
      if (url.pathname === '/api/cancel') {
        const job = jobs.find(j => j.id === body.id);
        if (!job) throw new Error('Taak niet gevonden.');
        if (!terminal.has(job.status)) { job.controller.abort(); job.status = 'cancelled'; job.provider = undefined; }
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/clear') {
        for (let i = jobs.length - 1; i >= 0; i--) if (terminal.has(jobs[i].status)) jobs.splice(i, 1);
        return send(res, 200, { ok: true });
      }
      const provider = connections.get(body.provider);
      if (!provider) throw new Error('Verbind eerst je provider.');
      if (url.pathname === '/api/torrents') return send(res, 200, await library(provider, body.source));
      if (url.pathname === '/api/files') {
        const torrent = await provider.details(body.id);
        return send(res, 200, { ...torrent, files: torrent.files.map(({ link, ...file }) => file) });
      }
      if (url.pathname === '/api/select-all') { await provider.selectAll(body.id); return send(res, 200, { ok: true }); }
      if (['/api/download', '/api/inspect-provider'].includes(url.pathname)) {
        const torrent = await provider.details(body.id);
        if (!torrent.ready) throw new Error('De provider heeft dit pakket nog niet klaar. Ververs later.');
        if (!Array.isArray(body.files) || !body.files.length) throw new Error('Selecteer bestanden.');
        const files = [...new Set(body.files)].map(id => torrent.files.find(f => f.id === id && f.downloadable));
        if (files.some(f => !f)) throw new Error('Ongeldige bestandsselectie.');
        enqueue(files.map(f => ({ name: f.name, provider, torrentId: body.id, fileId: f.id, remote: url.pathname === '/api/inspect-provider' })), body.mode || 'auto');
        return send(res, 202, { count: files.length });
      }
      return send(res, 404, { error: 'Niet gevonden.' });
    } catch (error) { return send(res, 400, { error: error instanceof SyntaxError ? 'Ongeldige JSON.' : error.message }); }
  });
  server.hasActiveJobs = () => jobs.some(job => !terminal.has(job.status));
  server.setDownloadDir = directory => { if (!path.isAbsolute(directory)) throw new Error('Kies een absolute downloadmap.'); downloadDir = directory; };
  server.stopJobs = () => { for (const j of jobs) if (!terminal.has(j.status)) { j.controller.abort(); j.status = 'cancelled'; } connections.clear(); };
  server.on('close', server.stopJobs);
  return server;
}

export async function downloadFile(input, destination, signal, onProgress) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Ongeldige provider-downloadlink.');
  const partial = destination + '.part';
  try {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(6 * 60 * 60 * 1000)]);
    const response = await fetch(url, { signal: bounded, redirect: 'error' });
    if (!response.ok || !response.body) throw new Error('Download niet beschikbaar.');
    const total = Number(response.headers.get('content-length')) || null;
    let bytes = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; onProgress(bytes, total); callback(null, chunk); } }), createWriteStream(partial, { flags: 'wx' }), { signal: bounded });
    if (total && bytes !== total) throw new Error('Onvolledige download.');
    await rename(partial, destination);
  } catch (error) { await rm(partial, { force: true }); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createApp({ downloadDir: path.resolve(process.env.DOWNLOAD_DIR || 'app-data/downloads') });
  server.listen(Number(process.env.PORT || 3210), '127.0.0.1', () => console.log(`SegmentScraper: http://127.0.0.1:${server.address().port}`));
  server.on('error', error => { console.error(`App kon niet starten: ${error.code}`); process.exitCode = 1; });
}
