// One stable player stays mounted while progress and queue rows update.
const reviewShell=el('div',undefined,'review-shell'), reviewFiles=el('section',undefined,'review-files'),reviewMain=el('section',undefined,'review-main'),reviewChecks=el('section',undefined,'review-checks');
reviewFiles.innerHTML='<h3>Your reviews</h3><label>Filter<select id="review-filter"><option value="all">All files</option><option value="review">Needs review</option><option value="blocked">Blocked / interrupted</option><option value="uploaded">Uploaded</option></select></label><input id="review-search" aria-label="Search review files" placeholder="Find a file…"><div id="review-list"></div>';
reviewChecks.innerHTML='<h3>Checks & upload</h3><p>Confirm the identity and boundaries, then run fresh checks.</p>';
reviewShell.append(reviewFiles,reviewMain,reviewChecks);
const selection=$('upload-job');selection.before(reviewShell);reviewFiles.append(document.querySelector('label[for="upload-job"]'),selection);
const identity=el('details',undefined,'identity-panel');identity.open=true;identity.append(el('summary','1 · Confirm identity'));
const identityNodes=[selection.parentElement===reviewFiles?uploadPanel.querySelector('.settings-grid:not(details .settings-grid)'):null,$('imdb-lookup'),$('imdb-results'),$('upload-imdb').parentElement,$('episode-fields')];
for(const n of identityNodes)if(n)identity.append(n);reviewMain.append(identity);
reviewMain.append($('ending-analysis'));
const playerPanel=el('section',undefined,'review-player');
playerPanel.innerHTML='<div class="section-top"><h3>2 · Review the boundaries</h3><span id="draft-status" role="status">Changes are saved locally</span></div><video id="review-video" controls preload="metadata" aria-label="Review video"></video><p id="player-message" role="status">Analyze a movie to generate an overview and short review clips.</p><div id="clip-tabs" class="row"></div><div id="timeline-segments" aria-label="Segment timeline"></div><label>Source position <output id="source-clock">00:00:00.000</output><input id="source-seek" type="range" min="0" max="1" step="0.001" value="0"></label><div class="row"><button id="inspect-position" class="secondary">Inspect this time at 1×</button><a id="download-preview" hidden>Save review clip</a></div><div class="row"><label>Selected segment<select id="selected-segment"></select></label><button id="mark-start" class="secondary">Set start here</button><button id="mark-end" class="secondary">Set end here</button><button id="undo-boundary" class="secondary" disabled>Undo</button></div><p class="review-hint">Choose a segment, open a 1× boundary clip, pause at the exact point, then set its start or end. The overview is for navigation.</p>';
reviewMain.append(playerPanel,$('segment-editor'),$('add-segment'));
reviewChecks.append($('validate-upload').parentElement,$('upload-progress'),$('upload-payload').closest('details'),$('review-confirm').parentElement,$('override-fields'),$('submit-upload'));
const evidence=el('details',undefined,'evidence-panel');evidence.append(el('summary','Detection evidence'),$('analysis-findings'));reviewChecks.append(evidence);
const historyPanel=el('details');historyPanel.append(el('summary','Upload history'));const historyList=el('div');historyList.id='upload-history';historyPanel.append(historyList);reviewChecks.append(historyPanel);
const viewer=$('review-video');let playerJobId=null,activeClip=null,reviewListSnapshot='',clipSnapshot='',lastReviewState,undoEdits=[],reviewRequest=0;
viewer.controls=false;viewer.hidden=true;
const playback=el('div',undefined,'row');
const playButton=button('Play',async()=>{if(!activeClip)throw new Error('Open a review clip first.');if(viewer.paused)await viewer.play();else viewer.pause();});playButton.id='review-play';
playback.append(playButton,button('−0.1s',()=>{viewer.pause();viewer.currentTime=Math.max(0,viewer.currentTime-.1/(activeClip?.speed||1));}),button('+0.1s',()=>{viewer.pause();viewer.currentTime=Math.min(viewer.duration||0,viewer.currentTime+.1/(activeClip?.speed||1));}));
const muteButton=button('Mute',()=>{viewer.muted=!viewer.muted;muteButton.textContent=viewer.muted?'Unmute':'Mute';});playback.append(muteButton);
viewer.after(playback);viewer.onplay=()=>{playButton.textContent='Pause';};viewer.onpause=()=>{playButton.textContent='Play';};
window.flushReviewDraft=async()=>{saveDraft();await draftWrites;};
function sourcePosition(){return Number($('source-seek').value);}
function updatePosition(value){$('source-seek').value=value;$('source-clock').value=time(value);}
function loadClip(clip,position){
 activeClip=clip;viewer.hidden=false;viewer.pause();viewer.src=clip.url;viewer.load();
 $('player-message').textContent=clip.speed===1?'Boundary review · original speed':'Ending overview · 12× source speed';
 $('download-preview').hidden=false;$('download-preview').href=clip.url+'?download=1';$('download-preview').download='review.webm';
 viewer.onloadedmetadata=()=>{viewer.currentTime=Math.max(0,Math.min(viewer.duration,((position??clip.boundary??clip.sourceStart)-clip.sourceStart)/clip.speed));};
 updatePosition(position??clip.sourceStart);$('mark-start').disabled=$('mark-end').disabled=clip.speed!==1;
}
viewer.ontimeupdate=()=>{if(activeClip)updatePosition(Math.min(activeClip.sourceEnd,activeClip.sourceStart+viewer.currentTime*activeClip.speed));};
viewer.onerror=()=>{$('player-message').textContent='Preview could not play. Save the review clip to open it in your video player, or reanalyze the file.';};
$('source-seek').oninput=()=>{const value=sourcePosition();$('source-clock').value=time(value);viewer.pause();if(activeClip&&value>=activeClip.sourceStart&&value<=activeClip.sourceEnd)viewer.currentTime=(value-activeClip.sourceStart)/activeClip.speed;else $('player-message').textContent='Press “Inspect this time at 1×” to create a short clip at this position.';};
function mountReview(job){
 if(!job){playerJobId=null;activeClip=null;viewer.pause();viewer.removeAttribute('src');viewer.load();viewer.hidden=true;$('clip-tabs').replaceChildren();$('timeline-segments').replaceChildren();$('download-preview').hidden=true;$('mark-start').disabled=$('mark-end').disabled=$('inspect-position').disabled=true;return;}
 if(playerJobId!==job.id){playerJobId=job.id;reviewRequest++;viewer.pause();viewer.removeAttribute('src');viewer.load();activeClip=null;clipSnapshot='';undoEdits=[];$('undo-boundary').disabled=true;updatePosition(0);$('player-message').textContent='Analyze this movie to create review clips.';}
 $('source-seek').max=job.report.duration;
 if(activeClip&&!(job.previews||[]).some(c=>c.id===activeClip.id)){activeClip=null;viewer.pause();viewer.removeAttribute('src');viewer.load();viewer.hidden=true;$('download-preview').hidden=true;}
 const signature=JSON.stringify(job.previews||[]);if(signature!==clipSnapshot){clipSnapshot=signature;$('clip-tabs').replaceChildren();for(const clip of job.previews||[])$('clip-tabs').append(button(clip.speed===12?'Overview · 12×':time(clip.boundary),()=>loadClip(clip,clip.boundary)));if(!activeClip&&job.previews?.length)loadClip(job.previews[0]);}
 $('inspect-position').disabled=!job.report.analysis||job.status!=='done';$('mark-start').disabled=$('mark-end').disabled=activeClip?.speed!==1;
 renderReviewTimeline();
}
bind('inspect-position',async()=>{
 const jobId=loadedJobId,position=sourcePosition(),request=++reviewRequest;
 $('player-message').textContent='Preparing a short review clip…';
 let clip;try{({clip}=await api('review-clip',{jobId,time:position}));}catch(error){$('player-message').textContent=error.message;throw error;}
 if(jobId!==loadedJobId||request!==reviewRequest)return;loadClip(clip,position);await poll();
});
function renderReviewTimeline(){
 if(!$('selected-segment'))return;
 const selected=$('selected-segment').value,rows=[...$('segment-editor').children],duration=jobs.find(j=>j.id===loadedJobId)?.report?.duration||1;
 $('selected-segment').replaceChildren();$('timeline-segments').replaceChildren();
 rows.forEach((row,i)=>{const [type,start,end]=row.querySelectorAll('select,input'),a=Number(start.value),b=Number(end.value);const option=el('option',`${i+1} · ${type.value}`);option.value=i;$('selected-segment').append(option);
   const marker=button(`${type.value} · ${time(a)}–${time(b)}`,()=>{$('selected-segment').value=i;updatePosition(a);});marker.className=`timeline-marker ${type.value}`;marker.style.left=`${Math.max(0,Math.min(100,a/duration*100))}%`;marker.style.width=`${Math.max(.5,Math.min(100-a/duration*100,(b-a)/duration*100))}%`;marker.title=`${type.value}: ${time(a)}–${time(b)}`;$('timeline-segments').append(marker);
   let caption=row.querySelector('.timecode-caption');if(!caption){caption=el('small',undefined,'timecode-caption');row.append(caption);}caption.textContent=`${time(start.value===''?null:a)} → ${time(end.value===''?null:b)}`;
 });
 if([...$('selected-segment').options].some(o=>o.value===selected))$('selected-segment').value=selected;
}
function markBoundary(which){
 const row=$('segment-editor').children[Number($('selected-segment').value)];
 const position=sourcePosition();if(!row||activeClip?.speed!==1||position<activeClip.sourceStart||position>activeClip.sourceEnd)throw new Error('Open a 1× clip at the selected time first.');
 const inputs=row.querySelectorAll('input');undoEdits.push({row,start:inputs[0].value,end:inputs[1].value});if(undoEdits.length>50)undoEdits.shift();
 inputs[which].value=position.toFixed(3);$('ending-reviewed').checked=false;invalidateUpload();$('undo-boundary').disabled=false;
}
bind('mark-start',()=>markBoundary(0));bind('mark-end',()=>markBoundary(1));
$('undo-boundary').onclick=()=>{const edit=undoEdits.pop();if(edit?.row.isConnected){const inputs=edit.row.querySelectorAll('input');inputs[0].value=edit.start;inputs[1].value=edit.end;$('ending-reviewed').checked=false;invalidateUpload();}$('undo-boundary').disabled=!undoEdits.length;};
function renderReviewList(state){
 lastReviewState=state;
 const filter=$('review-filter').value,query=$('review-search').value.toLowerCase();
 const key=JSON.stringify([state.jobs.map(j=>[j.id,j.status,j.name,j.analysisError]),state.history,filter,query,loadedJobId]);if(key===reviewListSnapshot)return;reviewListSnapshot=key;
 const uploaded=new Set((state.history||[]).filter(r=>r.status==='complete').map(r=>r.jobId));
 const eligible=state.jobs.filter(j=>j.name.toLowerCase().includes(query)&&(filter==='all'||filter==='uploaded'&&uploaded.has(j.id)||filter==='blocked'&&(['error','cancelled'].includes(j.status)||j.analysisError)||filter==='review'&&j.report&&!uploaded.has(j.id)));
 $('review-list').replaceChildren();for(const j of eligible.slice(0,100)){const b=button(j.name,()=>{$('upload-job').value=j.id;if(j.report)loadUploadJob();else notice('Finish or resume inspection before reviewing.');});b.className='review-file'+(j.id===loadedJobId?' selected':'');b.append(el('small',uploaded.has(j.id)?'Uploaded':j.analysisError?'Analysis needs attention':statuses[j.status]));$('review-list').append(b);}
 if(eligible.length>100)$('review-list').append(el('small','Showing 100 results. Search to narrow the list.'));
 $('upload-history').replaceChildren();for(const r of [...(state.history||[])].reverse().slice(0,30))$('upload-history').append(el('p',`${r.title||r.jobId} · ${r.status==='uploading'?'Interrupted — recheck acceptance before retrying':r.status}`));
 if(state.storage?.error)$('draft-status').textContent=state.storage.error;
}
$('review-filter').onchange=$('review-search').oninput=()=>{if(lastReviewState)renderReviewList(lastReviewState);};
