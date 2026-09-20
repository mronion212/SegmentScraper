const uploadPanel = document.createElement('section');
uploadPanel.id='upload-panel'; uploadPanel.className='card';
uploadPanel.innerHTML=`<div class="eyebrow">04 / REVIEW & CONTRIBUTE</div><h2>Upload to IntroDB</h2>
<p>Fill the gaps in provider metadata. Inspect a file, confirm its identity, review the timestamps against the actual video, then run the checks.</p>
<div class="review-warning"><strong>You are responsible for checking all output.</strong> Automated checks cannot confirm that a chapter really is an intro or credits. Watch and verify every start and end before uploading.</div>
<details><summary>API credentials · kept in memory for this session</summary><div class="settings-grid">
<label>IntroDB API key<input id="idb-key" type="password" autocomplete="off"></label>
<label>TMDB read access token · movie checks<input id="tmdb-key" type="password" autocomplete="off"></label>
<label>TheTVDB API key · TV checks<input id="tvdb-key" type="password" autocomplete="off"></label>
<label>TheTVDB subscriber PIN · optional<input id="tvdb-pin" type="password" autocomplete="off"></label></div><button id="save-upload-settings">Use credentials</button><p id="credential-status"></p></details>
<label for="upload-job">Inspected file</label><select id="upload-job"><option value="">Choose a completed inspection</option></select>
<div class="settings-grid"><label>Media type<select id="upload-type"><option value="movie">Movie</option><option value="tv">TV series</option></select></label>
<label>Title or IMDb ID<input id="imdb-query" placeholder="Movie / series title or tt1234567"></label></div>
<button id="imdb-lookup" class="secondary">Search IMDb</button><div id="imdb-results" class="row"></div>
<label>Confirmed IMDb ID<input id="upload-imdb" placeholder="tt1234567"></label>
<div id="episode-fields" class="settings-grid" hidden><label>Season<input id="upload-season" type="number" min="1"></label><label>Episode<input id="upload-episode" type="number" min="1"></label><label>Episode title · required for reliable TVDB matching<input id="upload-episode-title" placeholder="Actual episode title, not the release filename"></label></div>
<section id="ending-analysis" class="analysis-card"><h3>Automatic credits & extra-scene analysis</h3><p>Scan the ending, then review a 12× overview and short boundary clips. Black fades and text-like images provide candidates, not guaranteed scene recognition. Default timing resolution: 0.5 seconds.</p>
<div class="row"><label>Scan window<select id="analysis-window"><option value="last-15-minutes">Last 15 minutes · shorter coverage</option><option selected value="0.25">Last quarter · recommended</option><option value="0.5">Last half · wider search</option><option value="1">Entire video · slowest</option></select></label><button id="analyze-ending">Analyze ending</button><button id="cancel-analysis" class="secondary" hidden>Cancel analysis</button></div>
<p class="review-hint">A shorter window checks less of the movie. Expand it if credits or extra scenes begin earlier. Provider 4K speed also depends on the connection and decoding.</p>
<div id="analysis-progress" role="status" aria-live="polite"></div><div id="analysis-findings"></div><div id="analysis-previews"></div>
<button id="use-analysis" class="secondary" disabled>Use detected timestamps</button><label class="remember"><input id="ending-reviewed" type="checkbox"> I reviewed the ending overview and scene boundaries, rejected false positives, and checked that no extra scene is skipped.</label>
</section>
<p>Times are seconds from the start of this exact video, including decimals. You can correct chapter suggestions or add manually verified timestamps.</p>
<div id="segment-editor"></div><button id="add-segment" class="secondary">Add segment</button>
<div class="row"><button id="validate-upload">Run all checks</button><span id="upload-summary" role="status" aria-live="polite">Waiting for a reviewed file</span></div>
<div id="upload-progress" aria-live="polite"></div><details><summary>Exact upload payload</summary><pre id="upload-payload">Run checks to preview the payload.</pre></details>
<label class="remember"><input type="checkbox" id="review-confirm"> I have personally checked the identity, episode mapping, and all timestamps against the video.</label>
<details id="override-fields" hidden><summary>Admin override for blocked checks</summary><p>Override is recorded with the failed checks and your reason. IntroDB can still reject a submission. Invalid boundaries and missing user review cannot be overridden.</p><label>Admin code<input id="admin-code" type="password" autocomplete="off"></label><label>Reason for overriding<textarea id="override-reason" rows="2"></textarea></label></details>
<button id="submit-upload" disabled>Upload reviewed segments</button>`;
document.querySelector('footer').before(uploadPanel);
const updateDialog=document.createElement('dialog');updateDialog.id='update-dialog';
updateDialog.innerHTML='<div class="eyebrow">REQUIRED UPDATE</div><h2>A new version is ready</h2><p id="update-message"></p><p>Install the latest desktop Setup, then restart SegmentScraper to continue. Export your reports before closing.</p><div class="row"><button id="open-update">Get desktop update</button><button id="update-export" class="secondary">Export inspection reports</button></div>';
document.body.append(updateDialog);updateDialog.addEventListener('cancel',e=>e.preventDefault());
let activeRun, uploadSnapshot='', jobOptions='', editorDirty=false, analysisSnapshot='', evidenceKey='', requestedAnalysisJob=null, loadedJobId=null, loadingDraft=false, draftTimer, draftWrites=Promise.resolve();
const draftCache=new Map();
function currentDraft(){return {imdb_id:$('upload-imdb').value.trim(),media_type:$('upload-type').value,season:Number($('upload-season').value),episode:Number($('upload-episode').value),episodeTitle:$('upload-episode-title').value,query:$('imdb-query').value,segments:[...$('segment-editor').children].map(row=>{const [type,start,end]=row.querySelectorAll('select,input');return {segment_type:type.value,start_sec:start.value===''?null:Number(start.value),end_sec:end.value===''?null:Number(end.value)};}),sceneReview:[...document.querySelectorAll('.scene-decision')].map(n=>n.value)};}
function saveDraft(){
 if(loadingDraft||!loadedJobId)return;
 const jobId=loadedJobId,draft=currentDraft();draftCache.set(jobId,draft);clearTimeout(draftTimer);
 const status=$('draft-status');if(status)status.textContent='Saving…';
 draftWrites=draftWrites.catch(()=>{}).then(()=>api('save-draft',{jobId,draft})).then(()=>{if(status)status.textContent='Saved on this computer';}).catch(e=>{if(status)status.textContent='Not saved — '+e.message;throw e;});
 draftWrites.catch(e=>notice(e.message,true));
}
function invalidateUpload(){activeRun=null;editorDirty=true;$('review-confirm').checked=false;$('submit-upload').disabled=true;$('upload-summary').textContent='Changes need a new validation run';if(!loadingDraft){clearTimeout(draftTimer);draftTimer=setTimeout(saveDraft,250);if(typeof renderReviewTimeline==='function')renderReviewTimeline();}}
function addSegment(value={segment_type:'outro',start_sec:'',end_sec:''}){
  const row=el('div',undefined,'segment-row');const type=el('select');type.setAttribute('aria-label','Segment type');
  for(const name of ['intro','recap','outro','post-credits']){const option=el('option',name);option.value=name;type.append(option);}type.value=value.segment_type;
  const start=el('input'),end=el('input');for(const [node,label,v] of [[start,'Start (seconds)',value.start_sec],[end,'End (seconds)',value.end_sec]]){node.type='number';node.min='0';node.step='0.001';node.placeholder=label;node.setAttribute('aria-label',label);node.value=v??'';}
  row.append(type,start,end,button('Remove',()=>{row.remove();invalidateUpload();}));row.addEventListener('input',invalidateUpload);$('segment-editor').append(row);
}
function loadUploadJob(){
 if(loadedJobId&&!loadingDraft)saveDraft();loadingDraft=true;
 const job=jobs.find(j=>j.id===$('upload-job').value);loadedJobId=job?.id||null;$('segment-editor').replaceChildren();invalidateUpload();if(!job?.report){loadingDraft=false;return;}
 const r=job.report;$('upload-type').value=r.media_type==='tv'?'tv':'movie';$('episode-fields').hidden=$('upload-type').value!=='tv';
 $('ending-analysis').hidden=$('upload-type').value!=='movie';$('ending-reviewed').checked=false;analysisSnapshot='';renderEndingAnalysis(job);
 $('upload-season').value=r.season||'';$('upload-episode').value=r.episode||'';$('upload-imdb').value='';$('upload-episode-title').value='';$('imdb-results').replaceChildren();
 $('imdb-query').value=job.name.split(/[\\/]/).pop().replace(/\.[^.]+$/,'').split(/\bS\d+E\d+|\b(?:19|20)\d{2}\b/i)[0].replace(/[._]/g,' ').trim();
 for(const c of r.chapters.filter(c=>c.suggestion))addSegment({...c,segment_type:c.suggestion});
 if(!$('segment-editor').children.length)addSegment();
 const saved=draftCache.get(job.id)||job.draft;
 if(saved){$('upload-type').value=saved.media_type||'movie';$('upload-imdb').value=saved.imdb_id||'';$('upload-season').value=saved.season||'';$('upload-episode').value=saved.episode||'';$('upload-episode-title').value=saved.episodeTitle||'';$('imdb-query').value=saved.query||'';$('segment-editor').replaceChildren();for(const s of saved.segments||[])addSegment(s);document.querySelectorAll('.scene-decision').forEach((n,i)=>{n.value=saved.sceneReview?.[i]||'';});}
 $('episode-fields').hidden=$('upload-type').value!=='tv';$('ending-analysis').hidden=$('upload-type').value!=='movie';
 loadingDraft=false;if(typeof mountReview==='function')mountReview(job);if(typeof renderReviewTimeline==='function')renderReviewTimeline();
}
$('upload-job').onchange=loadUploadJob;
$('upload-type').onchange=()=>{$('episode-fields').hidden=$('upload-type').value!=='tv';$('ending-analysis').hidden=$('upload-type').value!=='movie';invalidateUpload();};
for(const id of ['upload-imdb','upload-season','upload-episode','upload-episode-title'])$(id).addEventListener('input',invalidateUpload);
bind('add-segment',()=>{addSegment();invalidateUpload();});
bind('save-upload-settings',async()=>{await api('upload-settings',{introdbKey:$('idb-key').value,tmdbToken:$('tmdb-key').value,tvdbKey:$('tvdb-key').value,tvdbPin:$('tvdb-pin').value});for(const id of ['idb-key','tmdb-key','tvdb-key','tvdb-pin'])$(id).value='';invalidateUpload();$('credential-status').textContent='Credentials are active for this session. Saving again replaces all four values.';});
bind('imdb-lookup',async()=>{const {results}=await api('imdb-search',{query:$('imdb-query').value,mediaType:$('upload-type').value});$('imdb-results').replaceChildren();for(const r of results)$('imdb-results').append(button(`${r.title} (${r.year||'?'}) · ${r.id}`,()=>{$('upload-imdb').value=r.id;invalidateUpload();$('imdb-results').replaceChildren(el('p',`Selected: ${r.title} (${r.year||'?'}) · ${r.id}`));}));if(!results.length)$('imdb-results').append(el('p','No matching titles. Check the title and media type.'));});
bind('validate-upload',async()=>{
 const segments=[...$('segment-editor').children].map(row=>{const [type,start,end]=row.querySelectorAll('select,input');return {segment_type:type.value,start_sec:start.value===''?null:Number(start.value),end_sec:end.value===''?null:Number(end.value)};});
 const run=await api('validate-upload',{jobId:$('upload-job').value,draft:{imdb_id:$('upload-imdb').value.trim(),media_type:$('upload-type').value,season:Number($('upload-season').value),episode:Number($('upload-episode').value),episodeTitle:$('upload-episode-title').value,segments,endingReviewed:$('ending-reviewed').checked,sceneReview:[...document.querySelectorAll('.scene-decision')].map(n=>n.value)}});
 activeRun=run.id;editorDirty=false;$('review-confirm').checked=false;uploadSnapshot='';await poll();
});
bind('submit-upload',async()=>{if(editorDirty||!activeRun)throw new Error('Run the checks again after editing.');await api('submit-upload',{runId:activeRun,reviewed:$('review-confirm').checked,code:$('admin-code').value,reason:$('override-reason').value});$('admin-code').value='';await poll();});
$('review-confirm').onchange=()=>{uploadSnapshot='';poll().catch(e=>notice(e.message,true));};
bind('open-update',async()=>{if(window.desktop)await window.desktop.openUpdate();else notice('Install the latest desktop release from https://github.com/mronion212/SegmentScraper/releases');});
bind('update-export',()=>$('export').click());
function renderUploadState(state){
 if(loadedJobId&&!state.jobs.some(j=>j.id===loadedJobId)){clearTimeout(draftTimer);draftCache.delete(loadedJobId);loadedJobId=null;activeRun=null;$('segment-editor').replaceChildren();if(typeof mountReview==='function')mountReview(null);}
 const eligible=state.jobs.filter(j=>['done','analyzing','cancelled'].includes(j.status)&&j.report);const keys=JSON.stringify(eligible.map(j=>[j.id,j.name]));
 if(keys!==jobOptions){jobOptions=keys;const previous=$('upload-job').value;$('upload-job').replaceChildren(el('option','Choose a completed inspection'));$('upload-job').firstChild.value='';for(const j of eligible){const opt=el('option',j.name);opt.value=j.id;$('upload-job').append(opt);}$('upload-job').value=eligible.some(j=>j.id===previous)?previous:'';}
 const run=state.uploads?.find(r=>r.id===activeRun);
 if(typeof renderReviewList==='function')renderReviewList(state);
 renderEndingAnalysis(state.jobs.find(j=>j.id===$('upload-job').value));
 if(run){
  const snap=JSON.stringify(run)+$('review-confirm').checked;if(snap!==uploadSnapshot){uploadSnapshot=snap;
   $('upload-summary').textContent=`${run.status.toUpperCase()} · ${run.steps.filter(s=>s.status!=='running').length}/5 checks finished${run.title?' · '+run.title:''}${run.status==='partial'?' · Run all checks again before retrying':''}`;
   const progress=el('progress');progress.max=5;progress.value=run.steps.filter(s=>s.status!=='running').length;progress.setAttribute('aria-label','Validation checks completed');$('upload-progress').replaceChildren(progress);
   for(const step of run.steps){const line=el('div',undefined,`check-step ${step.status}`);line.append(el('strong',`${step.status==='running'?'…':step.status==='passed'?'✓':'!'} ${step.name}`),el('span',step.detail||'Waiting for service response (15-second request timeout)…'));if(step.status==='running'){const elapsed=el('small');elapsed.dataset.started=step.startedAt;line.append(elapsed);}$('upload-progress').append(line);}
   for(const [index,result] of run.results.entries())if(result)$('upload-progress').append(el('p',`Segment ${index+1}: ${result.status} — ${result.detail}`));
   $('upload-payload').textContent=JSON.stringify(run.payloads,null,2);$('override-fields').hidden=!run.blockers.length;
   $('submit-upload').textContent=run.blockers.length?'Force upload with admin code':'Upload reviewed segments';
   $('submit-upload').disabled=editorDirty||!['ready','blocked'].includes(run.status)||!$('review-confirm').checked;
  }
 }
 for(const node of document.querySelectorAll('[data-started]'))node.textContent=`${Math.floor((Date.now()-Number(node.dataset.started))/1000)} seconds elapsed`;
 if(state.update?.required){$('update-message').textContent=`Version ${state.update.latestVersion} is required. You are running ${state.update.currentVersion}.`;if(!updateDialog.open)updateDialog.showModal();}
}

function useAnalysis(){
 const job=jobs.find(j=>j.id===$('upload-job').value);if(!job?.report.analysis)return;
 const analysis=job.report.analysis,decisions=[...document.querySelectorAll('.scene-decision')].map(n=>n.value);
 const scenes=analysis.scenes.filter((s,i)=>decisions[i]!=='not-scene');
 $('segment-editor').replaceChildren();
 if(Number.isFinite(analysis.creditsStart))addSegment({segment_type:'outro',start_sec:analysis.creditsStart,end_sec:scenes[0]?.start_sec??analysis.creditsEnd});
 for(const s of scenes)if(!s.uncertainEnd)addSegment({segment_type:'post-credits',start_sec:s.start_sec,end_sec:s.end_sec});
 invalidateUpload();$('ending-reviewed').checked=false;
}
async function startEndingAnalysis(force=false){
 const jobId=$('upload-job').value;if(!jobId)throw new Error('Choose an inspected file first.');
 saveDraft();await draftWrites;const response=await api('analyze-credits',{jobId,scanFraction:$('analysis-window').value==='last-15-minutes'?'last-15-minutes':Number($('analysis-window').value),force});requestedAnalysisJob=response.cached?null:jobId;analysisSnapshot='';invalidateUpload();$('ending-reviewed').checked=false;if(response.cached)notice('Reusing the saved analysis for this unchanged video. Your corrections were preserved.');await poll();
}
bind('analyze-ending',()=>startEndingAnalysis());
const reanalyze=button('Reanalyze from source',()=>startEndingAnalysis(true));reanalyze.id='reanalyze-ending';$('analyze-ending').after(reanalyze);
bind('cancel-analysis',async()=>{await api('cancel',{id:$('upload-job').value});requestedAnalysisJob=null;await poll();});
bind('use-analysis',useAnalysis);
$('ending-reviewed').onchange=invalidateUpload;
function renderEndingAnalysis(job){
 $('cancel-analysis').hidden=job?.status!=='analyzing';$('analyze-ending').disabled=!job||job.status==='analyzing';
 $('reanalyze-ending').disabled=!job||job.status==='analyzing';
 const p=job?.analysisProgress;
 $('analysis-progress').replaceChildren();
 if(p){const elapsed=Math.max(0,((p.finishedAt||Date.now())-p.startedAt)/1000),speed=elapsed>0?(p.scannedSeconds||0)/elapsed:0,eta=p.phase==='scanning'&&elapsed>=5&&speed>0?` | ~${Math.ceil((p.totalSeconds-p.scannedSeconds)/speed/60)} min remaining | ${speed.toFixed(1)}x source speed`:'';const progress=el('progress');progress.max=100;progress.value=p.percent||0;progress.setAttribute('aria-label','Ending analysis progress');$('analysis-progress').append(progress,el('p',`${(p.phase||'').replaceAll('-',' ')} · ${p.percent||0}% · ${Math.floor(((p.finishedAt||Date.now())-p.startedAt)/1000)}s elapsed${p.totalSeconds?` · ${Math.round(p.scannedSeconds||0)} / ${Math.round(p.totalSeconds)} source seconds scanned`:''}${eta}`));}
 if(job?.analysisError){
  $('analysis-progress').append(el('p',job.analysisError,'review-warning'));
  if(job.remote&&job.status!=='analyzing'){
   const fallback=button('Download & inspect locally',async()=>{await api('download-and-inspect',{id:job.id});analysisSnapshot='';await poll();notice('The provider file is downloading locally. Run Analyze ending when inspection finishes.');});
   fallback.className='secondary analysis-fallback';$('analysis-progress').append(fallback);
  }
 }
 const analysis=job?.report?.analysis;const snapshot=JSON.stringify([job?.id,analysis,job?.previews]);if(snapshot===analysisSnapshot)return;
 const nextEvidenceKey=JSON.stringify([job?.id,analysis]);const preserved=nextEvidenceKey===evidenceKey?[...document.querySelectorAll('.scene-decision')].map(n=>n.value):[];analysisSnapshot=snapshot;evidenceKey=nextEvidenceKey;
 $('analysis-findings').replaceChildren();$('analysis-previews').replaceChildren();$('use-analysis').disabled=!analysis;
 if(!analysis){if(typeof mountReview==='function')mountReview(job||null);return;}
 $('analysis-findings').append(el('p',`Scanned ${time(analysis.scanStart)}–${time(analysis.scanEnd)}. Credits-start candidate: ${time(analysis.creditsStart)}. ${analysis.scenes.length} possible extra scene(s).`));
 for(const warning of analysis.warnings)$('analysis-findings').append(el('p',warning,'analysis-warning'));
 analysis.scenes.forEach((scene,index)=>{
   const label=el('label',`${index+1}. Possible ${scene.kind}: ${time(scene.start_sec)}–${time(scene.end_sec)}${scene.uncertainEnd?' · end unresolved':''}`),select=el('select',undefined,'scene-decision');
   for(const [value,text]of [['','Choose after review'],['scene','Real scene — preserve it'],['not-scene','False positive — credits/logo/other']]){const opt=el('option',text);opt.value=value;select.append(opt);}select.value=preserved[index]||'';select.onchange=()=>{invalidateUpload();$('ending-reviewed').checked=false;};label.append(select);$('analysis-findings').append(label);
 });
 if(typeof mountReview==='function')mountReview(job);
 if(requestedAnalysisJob===job.id){requestedAnalysisJob=null;useAnalysis();}
}
