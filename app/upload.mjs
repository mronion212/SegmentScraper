import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { createCore } from './shared-core.mjs';

const BASE = 'https://api.introdb.app';
const types = ['intro', 'recap', 'outro', 'post-credits'];
const { outputSegmentAllowed, introdbPayload, parseIntrodbSegments, introdbRangeEntries, sameIntrodbRange, timestampRangeIssue, assessTimestampCandidates, timestampEvidence } = createCore({request:()=>{}});
export async function jsonRequest(url, options = {}, fetcher = fetch) {
  let response;
  try { response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error('Network request failed or timed out. Retry the check.'); }
  if (response.status === 404 && options.allowMissing) return null;
  if (!response.ok) throw new Error(`Service returned HTTP ${response.status}. Check credentials or retry later.`);
  try { return await response.json(); } catch { throw new Error('Service returned invalid JSON.'); }
}
function coreFor(settings, fetcher) {
  const request = options => {
    fetcher(options.url, { method: options.method, headers: options.headers, body: options.data, redirect: 'error', signal: AbortSignal.timeout(options.timeout || 15000) })
      .then(async response => options.onload({ status: response.status, responseText: await response.text() }))
      .catch(() => options.onerror?.());
  };
  const core = createCore({ request });
  core.saveTvdbSettings(settings.tvdbKey, settings.tvdbPin);
  core.saveTmdbToken(settings.tmdbToken);
  return core;
}
export function validateDraft(draft, report) {
  if (!report || !Number.isFinite(report.duration) || report.duration <= 0) throw new Error('Inspect the video first; a valid duration is required.');
  const duration = Number.isFinite(report.video_duration) && report.video_duration > 0 ? Math.min(report.duration, report.video_duration) : report.duration;
  if (!/^tt\d{7,8}$/.test(draft.imdb_id || '')) throw new Error('Enter a valid IMDb ID (tt followed by 7 or 8 digits).');
  if (!['tv', 'movie'].includes(draft.media_type)) throw new Error('Choose Movie or TV series.');
  if (draft.media_type === 'tv' && (![draft.season, draft.episode].every(n => Number.isInteger(n) && n > 0))) throw new Error('Regular TV episodes require positive season and episode numbers. Specials are excluded.');
  if (!Array.isArray(draft.segments) || !draft.segments.length || draft.segments.length > 100) throw new Error('Add 1–100 reviewed segments.');
  const sorted = [...draft.segments].sort((a,b) => a.start_sec-b.start_sec);
  if(draft.media_type==='movie'){
    for(const type of ['outro','post-credits'])if(sorted.filter(s=>s.segment_type===type).length>1)throw new Error('IntroDB currently models one outro and one extra scene per movie. Multiple real scenes must remain in the local report; they cannot be force-uploaded as competing ranges.');
    const scene=sorted.find(s=>s.segment_type==='post-credits'),outro=sorted.find(s=>s.segment_type==='outro');
    if(scene&&outro&&outro.end_sec>scene.start_sec)throw new Error('The outro must end at or before the extra scene starts, including mid-credits scenes.');
    if(scene&&scene.end_sec>=duration)throw new Error('Mark the actual scene end, not the final frame of the movie.');
    const candidates=report.analysis?.scenes||[];
    const decisions=Array.isArray(draft.sceneReview)?draft.sceneReview:[];
    if(candidates.length&&decisions.filter(v=>v==='scene').length>1)throw new Error('Multiple real scenes confirmed. IntroDB does not currently model them; export the local report instead.');
  }
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (!types.includes(s.segment_type) || ![s.start_sec, s.end_sec].every(Number.isFinite) || timestampRangeIssue(s, duration)) throw new Error('Segments must have valid types and ordered numeric boundaries within the video duration.');
    if (i && sorted[i-1].end_sec > s.start_sec) throw new Error('Segments overlap. Correct their boundaries before continuing.');
    if (draft.media_type === 'movie' && !['outro', 'post-credits'].includes(s.segment_type)) throw new Error('IntroDB accepts outro and post-credits segments for movies.');
  }
  const candidates = sorted.map(s => ({ ...s, _timingReview: undefined, imdb_id: draft.imdb_id, media_type: draft.media_type, season: draft.season, episode: draft.episode }));
  if ([...assessTimestampCandidates(candidates).values()].some(result => !result.allowed)) throw new Error('Conflicting or repeated timestamps for the same segment type. Keep one reviewed range per type in the upload; retain alternatives in the local report.');
  return sorted.map(s => introdbPayload({ ...s, imdb_id:draft.imdb_id,media_type:draft.media_type,season:draft.season,episode:draft.episode }));
}
export function existingRanges(data, type) {
  return introdbRangeEntries(data)
    .filter(entry => entry.segment_type === type)
    .map(entry => ({ start: entry.start_sec, end: entry.end_sec, credit_part: entry.credit_part }));
}
export function existingSegments(data) {
  return introdbRangeEntries(data).map(entry => ({
    segment_type: entry.segment_type,
    start_sec: entry.start_sec,
    end_sec: entry.end_sec,
    credit_part: entry.credit_part,
  }));
}
export function createUploadService({ fetcher = fetch, adminCode = process.env.SEGMENTSCRAPER_ADMIN_CODE || '', onAudit = async () => {}, initialState={}, onState=async()=>{} } = {}) {
  const runs = new Map(), accepted = new Set(initialState.accepted||[]), history=initialState.history||[];
  const save=()=>onState({accepted:[...accepted],history});
  function record(run){const i=history.findIndex(r=>r.id===run.id);const item=JSON.parse(JSON.stringify(run));if(i<0)history.push(item);else history[i]=item;while(history.length>500)history.shift();return save();}
  let settings = {}, busy = false, attempts = [];
  const snapshot = run => JSON.parse(JSON.stringify(run));
  function configure(input) {
    if (busy) throw new Error('Wait for the active upload or check to finish.');
    settings = Object.fromEntries(['introdbKey','tvdbKey','tvdbPin','tmdbToken'].map(key => [key, String(input[key] || '').trim()]));
    runs.clear();
  }
  async function lookup(query, mediaType) {
    const q = String(query || '').trim();
    if (!q || q.length > 200) throw new Error('Enter a title or IMDb ID.');
    const data = await jsonRequest(`https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(q)}.json`, {}, fetcher);
    const allowed = mediaType === 'movie' ? ['movie','tvmovie','videomovie','featurefilm','film','short','tvshort'] : ['tvseries','tvminiseries'];
    return (data.d || []).filter(r => allowed.includes(String(r.qid).toLowerCase())).map(r => ({ id:r.id, title:r.l, year:r.y, type:r.qid }));
  }
  function check(job, draft) {
    if (busy) throw new Error('An upload or check is already running.');
    const payloads = validateDraft(draft, job.report);
    if (runs.size >= 100) runs.delete(runs.keys().next().value);
    const evidence = [...draft.segments].sort((a,b) => a.start_sec-b.start_sec).map(s => {
      const chapter = job.report.chapters.find(c => c.suggestion === s.segment_type && c.start_sec === s.start_sec && c.end_sec === s.end_sec);
      const analysis = job.report.analysis?.suggestions?.find(c => sameIntrodbRange(s, c));
      return timestampEvidence({ provider: 'desktop', source: chapter ? 'chapter' : analysis ? 'visual-analysis' : 'manual', rawStart: s.start_sec, rawEnd: s.end_sec });
    });
    const run = { id:randomUUID(), jobId:job.id, status:'checking', startedAt:Date.now(), steps:[], payloads, evidence, results:[], blockers:[], title:'', override:null, endingReview:{reviewed:draft.endingReviewed===true,decisions:Array.isArray(draft.sceneReview)?draft.sceneReview:[]} };
    runs.set(run.id,run); busy = true;
    const step = async (name, action) => {
      const s = { name, status:'running', startedAt:Date.now(), detail:'' }; run.steps.push(s);
      try { s.detail = await action() || 'Passed'; s.status='passed'; }
      catch (e) { s.detail=e.message; s.status='blocked'; run.blockers.push(`${name}: ${e.message}`); }
      s.finishedAt=Date.now();
    };
    void (async () => {
      const core = coreFor(settings,fetcher);
      await step('IMDb identity', async () => { const matches=await lookup(draft.imdb_id,draft.media_type); const found=matches.find(r=>r.id===draft.imdb_id); if(!found) throw new Error('IMDb identity or media type could not be verified.'); run.title=`${found.title} (${found.year || 'year unknown'})`; return run.title; });
      await step('Timing and media review', async () => {
        const warnings=[];
        if(payloads.some(p=>!outputSegmentAllowed(p))) warnings.push('Shared duration rules: minimum 5 seconds; movie outro at most 900 seconds and extra scene at most 600 seconds');
        if(job.report.chapters.some(c=>c.issues.length)) warnings.push('Source chapter boundaries contain issues');
        if(job.report.duration<600 && draft.media_type==='movie') warnings.push('Short movie: verify this is not a trailer or sample');
        if(warnings.length) throw new Error(warnings.join('; '));
        return `${payloads.length} segments within ${job.report.duration.toFixed(3)} seconds; manual viewing still required`;
      });
      await step('TVDB canonical episode mapping', async () => {
        if(draft.media_type==='movie') return 'Movie: TVDB not applicable';
        // A local selection is not a complete provider catalogue: require exact title matching.
        const mapped=await core.mapSeriesItemsToTvdb(payloads.map(p=>({...p,_tvdbRequireTitleMatch:true,_tvdbAbsoluteTitleMatch:true,_tvdbEpisodeLanguages:['eng','nld']})),[{season:draft.season,episode:draft.episode,title:String(draft.episodeTitle||'')}]);
        if(!mapped.success || mapped.items.length!==payloads.length) throw new Error(mapped.reason || 'No reliable mapping; enter the actual episode title.');
        run.payloads=mapped.items; return `${mapped.reason}; canonical S${mapped.items[0].season}E${mapped.items[0].episode}`;
      });
      let existing;
      await step('IntroDB existing segments', async () => {
        const p=run.payloads[0]; const query=new URLSearchParams({imdb_id:p.imdb_id,...(p.is_movie?{is_movie:'true'}:{season:String(p.season),episode:String(p.episode)})});
        existing=await jsonRequest(`${BASE}/segments?${query}`,{allowMissing:true},fetcher);
        const hasSegmentShape = existing !== null && typeof existing === 'object' && (Array.isArray(existing) || 'segments' in existing || ['intro','recap','outro','credits','post_credits','post-credits'].some(key => key in existing));
        if(existing!==null && !hasSegmentShape) throw new Error('Unexpected IntroDB response; duplicate check is inconclusive.');
        const parsed = existing === null ? { invalid: [] } : parseIntrodbSegments(existing);
        if(parsed.invalid.length || run.payloads.some(p=>existingRanges(existing,p.segment_type).some(r=>!Number.isFinite(r.start)||!Number.isFinite(r.end)||r.start<0||r.end<=r.start)))throw new Error('IntroDB returned invalid timestamps; duplicate check is inconclusive.');
        run.introdbSegments=existingSegments(existing);
        run.duplicates=run.payloads.map(p=>accepted.has(JSON.stringify(p))||run.introdbSegments.some(r=>sameIntrodbRange(p,r)));
        return `${run.introdbSegments.length} current IntroDB timestamp${run.introdbSegments.length===1?'':'s'} found; ${run.duplicates.filter(Boolean).length} exact duplicate segment${run.duplicates.filter(Boolean).length===1?'':'s'} will be skipped`;
      });
      await step('Movie extra-scene protection', async () => {
        if(draft.media_type!=='movie') return 'TV episode: movie check not applicable';
        const analysis=job.report.analysis;
        if(!analysis || analysis.status!=='needs-review')throw new Error('Run automatic ending analysis and review its previews before uploading a movie.');
        if(draft.endingReviewed!==true)throw new Error('Review the ending overview and each candidate boundary, then confirm the ending review.');
        if(analysis.scenes.length && (!Array.isArray(draft.sceneReview)||draft.sceneReview.length!==analysis.scenes.length||draft.sceneReview.some(v=>!['scene','not-scene'].includes(v))))throw new Error('Classify every scene candidate as a real scene or a false positive.');
        const hasScene=payloads.some(p=>p.segment_type==='post-credits');
        const confirmed=(draft.sceneReview||[]).filter(v=>v==='scene').length;
        if(confirmed>0&&!hasScene)throw new Error('A confirmed extra scene needs its own start and end in the upload.');
        const known=job.report.chapters.some(c=>c.suggestion==='post-credits')||existingRanges(existing,'post-credits').length>0;
        const result=await core.checkTmdbExtraScenes(draft.imdb_id);
        if((known||result.status==='present')&&!hasScene)throw new Error('An extra scene is known, but no explicit scene range is included. Correct the analysis and preserve the scene.');
        if(!['present','unknown'].includes(result.status))throw new Error(result.reason||'TMDB check unavailable.');
        return hasScene?'Desktop policy: reviewed scene is preserved separately; outro stops before the scene.':'Ending reviewed. No scene supplied; missing metadata alone was not treated as proof of absence.';
      });
      run.status=run.blockers.length?'blocked':'ready'; run.finishedAt=Date.now();
    })().catch(()=>{run.status='blocked';run.blockers.push('Unexpected validation error. Run the checks again.');}).finally(()=>{busy=false;});
    return snapshot(run);
  }
  function authorize(code) {
    const now=Date.now(); attempts=attempts.filter(t=>now-t<60000);
    if(attempts.length>=5) throw new Error('Too many admin-code attempts. Wait one minute.');
    attempts.push(now);
    if(!adminCode || typeof code!=='string' || !timingSafeEqual(createHash('sha256').update(code).digest(),createHash('sha256').update(adminCode).digest())) throw new Error('Invalid admin code or admin override is not configured.');
  }
  async function submit(id, { reviewed, introdbReviewed, selectedIndices, code, reason } = {}) {
    const run=runs.get(id);
    if(busy || !run || !['ready','blocked'].includes(run.status)) throw new Error('Run validation again before retrying, or wait for the active operation.');
    if(Date.now()-(run.finishedAt||run.startedAt)>15*60000) throw new Error('Checks expired. Run validation again.');
    if(reviewed!==true) throw new Error('Confirm that you personally reviewed all output against the video.');
    if(introdbReviewed!==true) throw new Error('Compare the scraper timestamps with the current IntroDB timestamps and approve that comparison first.');
    const selected = selectedIndices === undefined ? run.payloads.map((_,i)=>i) : selectedIndices;
    if(!Array.isArray(selected) || !selected.length || selected.some(i=>!Number.isInteger(i)||i<0||i>=run.payloads.length)) throw new Error('Approve at least one valid timestamp.');
    const selectedSet = new Set(selected);
    if(!settings.introdbKey) throw new Error('Save your IntroDB API key first.');
    if(run.blockers.length) {
      authorize(code);
      if(typeof reason!=='string'||reason.trim().length<10) throw new Error('Enter an override reason (at least 10 characters).');
      run.override={reason:reason.trim().slice(0,1000),at:new Date().toISOString(),blockers:[...run.blockers]};
    }
    busy=true;run.status='uploading';
    void (async()=>{
      await record(run);
      if(run.override) await onAudit({runId:run.id,jobId:run.jobId,...run.override});
      for(let i=0;i<run.payloads.length;i++) {
        if(!selectedSet.has(i)) {run.results[i]={status:'unselected',detail:'Not approved; retained for later review'};continue;}
        if(['uploaded','duplicate'].includes(run.results[i]?.status)) continue;
        if(run.duplicates?.[i] || accepted.has(JSON.stringify(run.payloads[i]))) {run.results[i]={status:'duplicate',detail:'Already in IntroDB or submitted in this session'};continue;}
        run.results[i]={status:'uploading',detail:`Submitting segment ${i+1} of ${run.payloads.length}`};
        await record(run);
        try {
          const p=run.payloads[i];
          const query=new URLSearchParams({imdb_id:p.imdb_id,...(p.is_movie?{is_movie:'true'}:{season:String(p.season),episode:String(p.episode)})});
          const latest=parseIntrodbSegments(await jsonRequest(`${BASE}/segments?${query}`,{allowMissing:true},fetcher));
          if(latest.invalid.length) throw new Error('IntroDB returned invalid timestamps. Run fresh checks.');
          if(latest.ranges.some(range=>sameIntrodbRange(p,range))) {
            run.results[i]={status:'duplicate',detail:'Exact range already in IntroDB; skipped'};
            await record(run);continue;
          }
          const response=await jsonRequest(`${BASE}/submit`,{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':settings.introdbKey},body:JSON.stringify(run.payloads[i])},fetcher);
          if(response?.ok!==true) throw new Error('IntroDB did not confirm acceptance. Recheck before retrying.');
          accepted.add(JSON.stringify(run.payloads[i]));
          run.results[i]={status:'uploaded',detail:'IntroDB accepted the submission',id:response.submission?.id};
          await record(run);
        } catch(e) {run.results[i]={status:'failed',detail:e.message};run.status='partial';await record(run);return;}
      }
      run.status='complete';
      await record(run);
    })().catch(()=>{run.status='partial';run.results.push({status:'failed',detail:'Could not record admin audit. No further segments submitted.'});}).finally(()=>{busy=false;});
    return snapshot(run);
  }
  return { configure, lookup, check, submit, history:()=>history.map(snapshot), invalidate:jobId=>{if(busy)throw new Error('Wait for validation or upload to finish.');for(const [id,run]of runs)if(run.jobId===jobId)runs.delete(id);}, active:()=>busy, list:()=>[...runs.values()].map(snapshot), adminConfigured:()=>Boolean(adminCode) };
}
