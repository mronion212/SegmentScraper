import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {openWorkspace,fingerprint,savedJob,cleanDraft} from '../app/workspace.mjs';
import {createApp} from '../app/server.mjs';
import {ANALYSIS_VERSION} from '../app/analysis.mjs';

const cleanups=new WeakMap();
async function folder(t){const dir=await mkdtemp(path.join(os.tmpdir(),'review-test-'));cleanups.set(t,[]);t.after(async()=>{for(const close of cleanups.get(t))await close();await rm(dir,{recursive:true,force:true});});return dir;}
async function app(t,options){
 const server=createApp(options);server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();
 const api=async(route,body)=>{const response=await fetch(base+'/api/'+route,{method:body?'POST':'GET',headers:{'X-App-Token':token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};};
 let closed=false;const close=async()=>{if(closed)return;closed=true;server.stopJobs();try{await server.flush();}finally{await new Promise(r=>{server.close(r);server.closeAllConnections();});}await options.workspace?.flush();};if(cleanups.has(t))cleanups.get(t).push(close);else t.after(close);
 return {server,base,api,close};
}
async function done(api){for(let n=0;n<200;n++){const job=(await api('status')).data.jobs[0];if(job?.status==='done')return job;await new Promise(r=>setTimeout(r,5));}throw new Error('Job did not finish');}

test('workspace serializes concurrent snapshots and preserves separate upload/job updates',async t=>{
 const dir=await folder(t),store=await openWorkspace(dir);
 await Promise.all([store.save({jobs:[{id:'one'}]}),store.save({uploads:{accepted:['receipt'],history:[]}}),store.save({jobs:[{id:'two'}]})]);
 const recovered=await openWorkspace(dir);assert.equal(recovered.get().jobs[0].id,'two');assert.deepEqual(recovered.get().uploads.accepted,['receipt']);
 assert.throws(()=>JSON.parse('bad'));await writeFile(path.join(dir,'workspace.json'),'broken');await assert.rejects(openWorkspace(dir),/preserved/);assert.equal(await readFile(path.join(dir,'workspace.json'),'utf8'),'broken');
});
test('drafts and job snapshots exclude credentials, URLs and prior upload authorization',()=>{
 const draft=cleanDraft({imdb_id:'tt1234567',segments:[{segment_type:'outro',start_sec:1,end_sec:5}],introdbKey:'secret',reviewed:true,endingReviewed:true,sceneReview:['scene','evil']});
 assert.equal(draft.reviewed,undefined);assert.equal(draft.endingReviewed,undefined);assert.equal(draft.introdbKey,undefined);assert.deepEqual(draft.sceneReview,['scene','']);
 const saved=savedJob({id:'one',provider:{token:'secret'},analysisProvider:{url:'private-url'},controller:new AbortController(),draft});assert.ok(!JSON.stringify(saved).includes('secret'));assert.ok(!JSON.stringify(saved).includes('private-url'));
});
test('completed work, drafts and previews survive restart; changed video cannot reuse analysis',async t=>{
 const dir=await folder(t),video=path.join(dir,'film.mkv');await writeFile(video,'original video');const workspace=await openWorkspace(dir);let analyses=0;
 const analyzer=async()=>{analyses++;const directory=path.join(dir,'clips');await mkdir(directory,{recursive:true});const file=path.join(directory,'clip.webm');await writeFile(file,'0123456789');return {directory,artifacts:[{id:'test-clip',file,sourceStart:75,sourceEnd:100,speed:12}],analysis:{version:ANALYSIS_VERSION,status:'needs-review',scanStart:75,scanEnd:100,scenes:[],suggestions:[],warnings:[]}};};
 const options={workspace,probe:async()=>({duration:100,chapters:[]}),analyzer};const first=await app(t,options);
 await first.api('local',{paths:[video],mode:'movie'});const job=await done(first.api);
 await first.api('save-draft',{jobId:job.id,draft:{imdb_id:'tt1234567',segments:[{segment_type:'outro',start_sec:80,end_sec:95}],reviewed:true}});
 assert.equal((await first.api('analyze-credits',{jobId:job.id})).status,202);await done(first.api);await first.close();
 const second=await app(t,{...options,workspace:await openWorkspace(dir)});const restored=(await second.api('status')).data.jobs[0];
 assert.equal(restored.draft.imdb_id,'tt1234567');assert.equal(restored.previews.length,1);assert.equal((await second.api('analyze-credits',{jobId:job.id})).data.cached,true);assert.equal(analyses,1);
 for(const [range,expected]of [['bytes=0-2','012'],['bytes=-3','789'],['bytes=8-999','89']]){const response=await fetch(second.base+'/preview/test-clip',{headers:{Range:range}});assert.equal(response.status,206);assert.equal(response.headers.get('content-type'),'video/webm');assert.equal(await response.text(),expected);}
 assert.equal((await fetch(second.base+'/preview/test-clip',{method:'HEAD'})).headers.get('content-length'),'10');
 const previous=await fingerprint(video);await writeFile(video,'changed video!');assert.notEqual(await fingerprint(video),previous);
 assert.match((await second.api('analyze-credits',{jobId:job.id})).data.error,/changed/);assert.equal(analyses,1);
});
test('interrupted jobs restore as resumable and never restart provider downloads automatically',async t=>{
 const dir=await folder(t),workspace=await openWorkspace(dir);await workspace.save({jobs:[{id:'remote',name:'episode.mkv',remote:true,providerName:'torbox',status:'downloading'}]});
 const server=await app(t,{workspace});const job=(await server.api('status')).data.jobs[0];assert.equal(job.status,'cancelled');assert.match(job.error,/Interrupted/);assert.match((await server.api('resume',{id:job.id})).data.error,/Reconnect/);
});
