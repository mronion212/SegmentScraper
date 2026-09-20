import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { collectVideos, inspectFile, inspectRemote, probeAvailable } from './media.mjs';
import { Debrid } from './providers.mjs';
import { createUploadService } from './upload.mjs';
import { analyzeCredits, disposeAnalysis, createReviewClip, analysisStart, analysisDuration, ANALYSIS_VERSION } from './analysis.mjs';
import { openWorkspace, fingerprint, savedJob, cleanDraft } from './workspace.mjs';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const terminal = new Set(['done', 'error', 'cancelled']);
export function createApp({ downloadDir = path.resolve('app-data/downloads'), probe = inspectFile, remoteProbe = inspectRemote, credentialStore, providerFactory = (p, t) => new Debrid(p, t), downloader = downloadFile, uploads = createUploadService(), updates, analyzer=analyzeCredits, workspace } = {}) {
  const secret = randomBytes(32).toString('hex');
  const jobs = [], connections = new Map();
  for(const saved of workspace?.get().jobs||[]){
    const interrupted=!terminal.has(saved.status);
    jobs.push({...saved,controller:new AbortController(),status:interrupted||saved.remote?'cancelled':saved.status,error:interrupted?'Interrupted last session. Resume this task to continue.':saved.error});
  }
  const persist=()=>workspace?.save({jobs:jobs.map(savedJob)})||Promise.resolve();
  const checkpoint=()=>{void persist().catch(()=>{});};
  async function verifySource(job){
    if(job.remote)return;
    const current=await fingerprint(job.local||job.savedPath);
    if(job.fingerprint&&job.fingerprint!==current)throw new Error('This video changed since inspection. Resume/reinspect it before analyzing or uploading.');
    job.fingerprint=current;
  }
  let running = false, analysisStarting=false;
  const library = async (provider, source = 'all') => provider.library ? provider.library({ fresh: true, source }) : { torrents: await provider.list({ fresh: true }), warnings: [] };
  const view = job => ({ id: job.id, name: job.name, status: job.status, remote: job.remote === true, bytes: job.bytes, total: job.total, error: job.error, report: job.report, draft:job.draft, savedPath: job.savedPath, analysisProgress:job.analysisProgress, analysisError:job.analysisError, previews:(job.analysisResult?.artifacts||[]).map(({file,...a})=>({...a,url:`/preview/${a.id}`})) });
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
            job.analysisProvider=job.provider;
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
          if(workspace)job.fingerprint=await fingerprint(local);
          signal.throwIfAborted();
          job.status = 'done';
        } catch (error) {
          job.status = job.controller.signal.aborted ? 'cancelled' : 'error';
          job.error = job.status === 'cancelled' ? null : (job.provider ? 'Download or inspection failed. Check provider status, disk space, and ffprobe. Completed downloads are kept.' : error.message);
        } finally { job.provider = undefined; checkpoint(); }
      }
    } finally { running = false; }
  }
  function enqueue(items, mode) {
    if (!['auto', 'tv', 'movie'].includes(mode)) throw new Error('Invalid media type.');
    if (!items.length) throw new Error('No video files found or selected.');
    if (jobs.filter(j => !terminal.has(j.status)).length + items.length > 5000) throw new Error('Queue too large.');
    jobs.push(...items.map(item => ({ ...item, downloadDir, id: randomUUID(), mode, status: 'queued', bytes: 0, controller: new AbortController() })));
    checkpoint();
    void work();
  }
  const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const expected = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== expected || (req.headers.origin && req.headers.origin !== `http://${expected}`) || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Only accessible from the local app.' });
    try {
      const url = new URL(req.url, `http://${expected}`);
      if (req.method === 'GET' && url.pathname === '/api/session') return send(res, 200, { token: secret });
      // Preview URLs are unguessable capabilities; browser video tags cannot add the API header.
      // Resolve IDs only from generated artifacts. Never accept a filesystem path from the browser.
      if(['GET','HEAD'].includes(req.method)&&url.pathname.startsWith('/preview/')){
        const clip=jobs.flatMap(j=>j.analysisResult?.artifacts||[]).find(a=>url.pathname===`/preview/${a.id}`);
        if(!clip)return send(res,404,{error:'Preview unavailable. Run the analysis again.'});
        const size=(await stat(clip.file)).size;let start=0,end=size-1;
        if(req.headers.range){const match=req.headers.range.match(/^bytes=(\d*)-(\d*)$/);if(!match||(!match[1]&&!match[2]))return send(res,416,{error:'Invalid range'});start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));end=match[1]&&match[2]?Math.min(size-1,Number(match[2])):end;if(start>end||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)){res.setHeader('Content-Range',`bytes */${size}`);return send(res,416,{error:'Invalid range'});}}
        res.writeHead(req.headers.range?206:200,{'Content-Type':clip.file.endsWith('.webm')?'video/webm':'video/mp4','Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store',...(url.searchParams.has('download')?{'Content-Disposition':`attachment; filename="${path.basename(clip.file)}"`}:{}),...(req.headers.range?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
        if(req.method==='HEAD'){res.end();return;}
        const stream=createReadStream(clip.file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;
      }
      if (!url.pathname.startsWith('/api/')) {
        const assets = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/upload.js': ['upload.js', 'text/javascript'], '/review.js':['review.js','text/javascript'] };
        const asset = assets[url.pathname];
        if (req.method !== 'GET' || !asset) return send(res, 404, { error: 'Not found.' });
        const content = await readFile(path.join(publicDir, asset[0]));
        res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-store' }); return res.end(content);
      }
      if (req.headers['x-app-token'] !== secret) return send(res, 403, { error: 'Invalid app session. Reload the page.' });
      if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { jobs: jobs.map(view), providers: [...connections.keys()], downloadDir, uploads: uploads.list(), history:uploads.history?.()||[], storage:workspace?.status(), adminConfigured: uploads.adminConfigured(), update: updates?.get() });
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ffprobe: await probeAvailable(), savedProviders: credentialStore ? await credentialStore.list() : [] });
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return send(res, 400, { error: 'JSON request required.' });
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1000000) return send(res, 413, { error: 'Request too large.' }); }
      const body = JSON.parse(raw || '{}');
      if(url.pathname==='/api/save-draft'){
        const job=jobs.find(j=>j.id===body.jobId);if(!job)throw new Error('Task not found.');
        job.draft=cleanDraft(body.draft);await persist();return send(res,200,{ok:true});
      }
      if (url.pathname === '/api/check-update') return send(res, 200, updates ? await updates.check() : { status:'development', required:false });
      if (updates?.get().required && !['/api/cancel','/api/disconnect'].includes(url.pathname)) return send(res, 423, { error: 'A required desktop update is available. Install it and restart to continue.' });
      if (url.pathname === '/api/upload-settings') { uploads.configure(body); return send(res, 200, { ok:true }); }
      if(url.pathname==='/api/review-clip'){
        const job=jobs.find(j=>j.id===body.jobId&&j.status==='done');
        if(!job?.analysisResult)throw new Error('Analyze this file first.');
        if(job.clipBusy)throw new Error('A review clip is already being prepared.');
        const boundary=Number(body.time);
        if(!Number.isFinite(boundary)||boundary<0||boundary>job.report.duration)throw new Error('Choose a time within the video.');
        await verifySource(job);
        if(job.status!=='done'||job.clipBusy||analysisStarting)throw new Error('Wait for the current media operation to finish.');
        const cached=job.analysisResult.artifacts.find(a=>a.speed===1&&a.sourceStart<=boundary-1&&a.sourceEnd>=boundary+1);
        if(cached)return send(res,200,{clip:{...cached,file:undefined,url:`/preview/${cached.id}`}});
        if(job.analysisResult.artifacts.length>=48)throw new Error('Preview limit reached. Reanalyze to clear cached clips.');
        job.clipBusy=true;
        try{
          const provider=job.analysisProvider||connections.get(job.providerName);
          if(job.remote&&!provider)throw new Error('Reconnect your provider before reviewing.');
          const source=job.remote?{remote:true,input:await provider.downloadLink(job.torrentId,job.fileId,job.controller.signal)}:{remote:false,input:job.local||job.savedPath};
          const clip=await createReviewClip(source,job.report.duration,boundary,job.analysisResult.directory,{signal:job.controller.signal});
          job.analysisResult.artifacts.push(clip);await persist();
          return send(res,200,{clip:{...clip,file:undefined,url:`/preview/${clip.id}`}});
        }finally{job.clipBusy=false;}
      }
      if(url.pathname==='/api/download-and-inspect'){
        const job=jobs.find(j=>j.id===body.id&&j.remote&&['done','cancelled'].includes(j.status)&&!j.clipBusy);
        if(!job)throw new Error('Choose a failed provider inspection first.');
        const provider=connections.get(job.providerName);
        if(!provider)throw new Error('Reconnect the original provider before downloading locally.');
        uploads.invalidate(job.id);
        await disposeAnalysis(job.analysisResult);job.analysisResult=null;job.report=null;job.fingerprint=null;job.draft=undefined;
        job.remote=false;job.provider=provider;job.controller=new AbortController();job.status='queued';job.error=null;job.analysisProgress=null;job.analysisError=null;
        await persist();void work();return send(res,202,{ok:true});
      }
      if(url.pathname==='/api/resume'){
        const job=jobs.find(j=>j.id===body.id&&terminal.has(j.status)&&!j.clipBusy);if(!job)throw new Error('Choose an idle task.');
        uploads.invalidate(job.id);
        const provider=connections.get(job.providerName);
        if(job.remote||(!job.local&&!job.savedPath)){if(!provider)throw new Error('Reconnect the original provider before resuming.');job.provider=provider;}
        else if(job.savedPath)job.local=job.savedPath;
        await disposeAnalysis(job.analysisResult);job.analysisResult=null;job.report=null;job.fingerprint=null;
        job.controller=new AbortController();job.status='queued';job.error=null;job.analysisProgress=null;job.analysisError=null;
        await persist();void work();return send(res,202,{ok:true});
      }
      if(url.pathname==='/api/analyze-credits'){
        if(analysisStarting)throw new Error('An analysis is already being prepared.');
        analysisStarting=true;
        try{
        const job=jobs.find(j=>j.id===body.jobId&&j.report&&['done','cancelled'].includes(j.status));
        if(!job)throw new Error('Choose a completed inspection first.');
        if(jobs.some(j=>j.status==='analyzing'||j.clipBusy))throw new Error('An ending analysis or preview is already running.');
        const scanStart=analysisStart(analysisDuration(job.report),body.scanFraction??.25);
        await verifySource(job);
        const prior=job.report.analysis;
        if(!job.remote&&!body.force&&prior?.version===ANALYSIS_VERSION&&prior.scanStart===scanStart&&job.analysisResult?.artifacts?.length){
          const present=await Promise.all(job.analysisResult.artifacts.map(a=>stat(a.file).then(s=>s.size>0,()=>false)));
          if(present.every(Boolean))return send(res,200,{ok:true,cached:true});
        }
        uploads.invalidate(job.id);
        await disposeAnalysis(job.analysisResult);job.analysisResult=null;delete job.report.analysis;
        job.controller=new AbortController();job.status='analyzing';job.analysisError=null;job.analysisProgress={phase:'preparing',percent:0,startedAt:Date.now()};
        checkpoint();
        const controller=job.controller;
        void(async()=>{
          try{
            const provider=job.analysisProvider||connections.get(job.providerName);
            if(job.remote&&!provider)throw new Error('Reconnect your provider before analyzing.');
            const source=job.remote?{remote:true,input:await provider.downloadLink(job.torrentId,job.fileId,controller.signal)}:{remote:false,input:job.local||job.savedPath};
            const result=await analyzer(source,job.report,{signal:controller.signal,artifactRoot:workspace?.directory,scanFraction:body.scanFraction??.25,onProgress:p=>{if(job.controller===controller)job.analysisProgress={...job.analysisProgress,...p,updatedAt:Date.now()};}});
            try{await verifySource(job);}catch(error){await disposeAnalysis(result);throw error;}
            if(controller.signal.aborted||job.controller!==controller){await disposeAnalysis(result);return;}
            job.analysisResult=result;job.report.analysis=result.analysis;job.status='done';
            job.analysisProgress={...job.analysisProgress,finishedAt:Date.now(),phase:'ready-for-review',percent:100};
          }catch(error){if(job.controller!==controller)return;job.status=controller.signal.aborted?'cancelled':'done';job.analysisProgress={...job.analysisProgress,finishedAt:Date.now(),phase:controller.signal.aborted?'cancelled':'failed'};const detail=error instanceof Error?error.message:'Unknown analysis error.';job.analysisError=controller.signal.aborted?'Analysis cancelled.':job.remote?`Provider analysis failed: ${detail} Download the video and analyze it locally, or use the local fallback below.`:detail;}
          finally{checkpoint();}
        })();
        return send(res,202,{ok:true});
        }finally{analysisStarting=false;}
      }
      if (url.pathname === '/api/imdb-search') return send(res, 200, { results:await uploads.lookup(body.query, body.mediaType) });
      if (url.pathname === '/api/validate-upload') {
        const job=jobs.find(j=>j.id===body.jobId && j.status==='done');
        if(!job) throw new Error('Choose a completed inspection first.');
        await verifySource(job);job.draft=cleanDraft(body.draft);await persist();
        return send(res, 202, uploads.check(job,body.draft));
      }
      if (url.pathname === '/api/submit-upload') {
        const run=uploads.list().find(r=>r.id===body.runId),job=jobs.find(j=>j.id===run?.jobId);
        if(!job)throw new Error('Run fresh checks for an inspected file first.');
        await verifySource(job);return send(res, 202, await uploads.submit(body.runId,body));
      }
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
        if (!credentialStore) throw new Error('Saved accounts are only available in the desktop app.');
        const provider = providerFactory(body.provider, await credentialStore.get(body.provider));
        const result = await library(provider, body.source); connections.set(body.provider, provider);
        return send(res, 200, result);
      }
      if (url.pathname === '/api/disconnect') { connections.delete(body.provider); if (credentialStore) await credentialStore.remove(body.provider); return send(res, 200, { ok: true }); }
      if (url.pathname === '/api/cancel') {
        const job = jobs.find(j => j.id === body.id);
        if (!job) throw new Error('Task not found.');
        if (!terminal.has(job.status)) { job.controller.abort(); job.status = 'cancelled'; job.provider = undefined; }
        checkpoint();
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/clear') {
        if(uploads.active()||jobs.some(j=>j.clipBusy))throw new Error('Wait for validation, upload or preview generation to finish before clearing reports.');
        for (let i = jobs.length - 1; i >= 0; i--) if (terminal.has(jobs[i].status)) { uploads.invalidate(jobs[i].id);void disposeAnalysis(jobs[i].analysisResult);jobs.splice(i, 1); }
        await persist();
        return send(res, 200, { ok: true });
      }
      const provider = connections.get(body.provider);
      if (!provider) throw new Error('Connect your provider first.');
      if (url.pathname === '/api/torrents') return send(res, 200, await library(provider, body.source));
      if (url.pathname === '/api/files') {
        const torrent = await provider.details(body.id);
        return send(res, 200, { ...torrent, files: torrent.files.map(({ link, ...file }) => file) });
      }
      if (url.pathname === '/api/select-all') { await provider.selectAll(body.id); return send(res, 200, { ok: true }); }
      if (['/api/download', '/api/inspect-provider'].includes(url.pathname)) {
        const torrent = await provider.details(body.id);
        if (!torrent.ready) throw new Error('The provider has not finished this pack. Refresh later.');
        if (!Array.isArray(body.files) || !body.files.length) throw new Error('Select files.');
        const files = [...new Set(body.files)].map(id => torrent.files.find(f => f.id === id && f.downloadable));
        if (files.some(f => !f)) throw new Error('Invalid file selection.');
        enqueue(files.map(f => ({ name: f.name, provider, providerName:body.provider, torrentId: body.id, fileId: f.id, remote: url.pathname === '/api/inspect-provider' })), body.mode || 'auto');
        return send(res, 202, { count: files.length });
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (error) { return send(res, 400, { error: error instanceof SyntaxError ? 'Invalid JSON.' : error.message }); }
  });
  server.hasActiveJobs = () => uploads.active() || jobs.some(job => !terminal.has(job.status)||job.clipBusy);
  server.setDownloadDir = directory => { if (!path.isAbsolute(directory)) throw new Error('Choose an absolute download folder.'); downloadDir = directory; };
  server.stopJobs = () => { for (const j of jobs) {if (!terminal.has(j.status)) { j.controller.abort(); j.status = 'cancelled'; }if(!workspace)void disposeAnalysis(j.analysisResult);} connections.clear();checkpoint(); };
  server.flush=async()=>{await persist();await workspace?.flush();};
  server.on('close', server.stopJobs);
  return server;
}

export async function downloadFile(input, destination, signal, onProgress) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid provider download link.');
  const partial = destination + '.part';
  try {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(6 * 60 * 60 * 1000)]);
    const response = await fetch(url, { signal: bounded, redirect: 'error' });
    if (!response.ok || !response.body) throw new Error('Download unavailable.');
    const total = Number(response.headers.get('content-length')) || null;
    let bytes = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; onProgress(bytes, total); callback(null, chunk); } }), createWriteStream(partial, { flags: 'wx' }), { signal: bounded });
    if (total && bytes !== total) throw new Error('Incomplete download.');
    await rename(partial, destination);
  } catch (error) { await rm(partial, { force: true }); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace=await openWorkspace(path.resolve(process.env.WORKSPACE_DIR||'app-data/workspace'));
  const uploads=createUploadService({initialState:workspace.get().uploads,onState:uploads=>workspace.save({uploads})});
  const server = createApp({ workspace,uploads,downloadDir: path.resolve(process.env.DOWNLOAD_DIR || 'app-data/downloads') });
  server.listen(Number(process.env.PORT || 3210), '127.0.0.1', () => console.log(`SegmentScraper: http://127.0.0.1:${server.address().port}`));
  server.on('error', error => { console.error(`App could not start: ${error.code}`); process.exitCode = 1; });
}
