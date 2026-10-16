import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUploadService, validateDraft } from '../app/upload.mjs';
import { createUpdateChecker } from '../app/updates.mjs';
import { createApp } from '../app/server.mjs';
import { once } from 'node:events';
import { createCore } from '../app/shared-core.mjs';
const job={id:'file-1',report:{duration:7200,chapters:[],analysis:{status:'needs-review',scenes:[]}}};
const draft={imdb_id:'tt1234567',media_type:'movie',endingReviewed:true,sceneReview:[],segments:[{segment_type:'outro',start_sec:6900.125,end_sec:7100.5}]};
const none={intro:null,recap:null,outro:null,post_credits:null};

test('desktop rejects competing TV ranges and boundaries after the video stream', () => {
 const tv = { imdb_id:'tt1234567', media_type:'tv', season:1, episode:1, segments:[
  {segment_type:'intro',start_sec:0,end_sec:30}, {segment_type:'intro',start_sec:40,end_sec:60},
 ] };
 assert.throws(()=>validateDraft(tv,job.report),/Conflicting or repeated/);
 assert.throws(()=>validateDraft({...tv,segments:[{segment_type:'intro',start_sec:null,end_sec:30}]},job.report),/numeric boundaries/);
 assert.throws(()=>validateDraft(draft,{...job.report,video_duration:7000}),/within the video duration/);
});

test('desktop records chapter, analysis and manual evidence outside the upload payload', async () => {
 const {fetcher}=mock(); const service=createUploadService({fetcher}); service.configure({introdbKey:'key',tmdbToken:'token'});
 const chapter = {...draft.segments[0],suggestion:'outro',issues:[]};
 service.check({...job,report:{...job.report,chapters:[chapter]}},draft);
 const run=await idle(service);
 assert.equal(run.evidence[0].source,'chapter');
 assert.equal(run.evidence[0].raw_start,draft.segments[0].start_sec);
 assert.equal('_timing' in run.payloads[0],false);
 service.check({...job,report:{...job.report,analysis:{...job.report.analysis,suggestions:draft.segments}}},draft);
 assert.equal((await idle(service)).evidence[0].source,'visual-analysis');
 service.check(job,draft);
 assert.equal((await idle(service)).evidence[0].source,'manual');
});
test('desktop shared core retains late segments and normalizes capture IDs', () => {
 const core = createCore({request() {}});
 const intro = {_showId:'100',_eid:123,season:1,episode:1,segment_type:'intro',start_sec:1,end_sec:11};
 assert.equal(core.capturedSegmentKey(intro),core.capturedSegmentKey({...intro,_eid:'123'}));
 assert.notEqual(core.capturedSegmentKey(intro),core.capturedSegmentKey({...intro,segment_type:'outro',start_sec:1500,end_sec:1600}));
});
function mock({existing=none,keywords=[],fail=false,imdb=true}={}) {
 const calls=[];
 const fetcher=async(url,options={})=>{
  calls.push({url,options});
  if(url.includes('media-imdb'))return Response.json({d:imdb?[{id:draft.imdb_id,l:'Test Movie',y:2026,qid:'movie'}]:[]});
  if(url.includes('/segments?'))return fail?new Response('',{status:503}):Response.json(existing);
  if(url.includes('/find/'))return Response.json({movie_results:[{id:100}]});
  if(url.endsWith('/keywords'))return Response.json({keywords:keywords.map(name=>({name}))});
  if(url.endsWith('/submit'))return Response.json({ok:true,submission:{id:'receipt'}});
  throw new Error('Unexpected URL: '+url);
 };return {fetcher,calls};
}
async function idle(service){for(let i=0;i<100;i++){if(!service.active())return service.list().at(-1);await new Promise(r=>setTimeout(r,1));}assert.fail('Service did not settle');}
test('movie uploads use official IntroDB schema and retain decimal seconds',async()=>{
 const {fetcher,calls}=mock();const service=createUploadService({fetcher});service.configure({introdbKey:'private',tmdbToken:'tmdb'});
 service.check(job,draft);const run=await idle(service);assert.equal(run.status,'ready');assert.equal(run.steps.length,5);assert.deepEqual(run.introdbSegments,[]);
 await assert.rejects(service.submit(run.id,{reviewed:false}),/personally/);
 await service.submit(run.id,{reviewed:true,introdbReviewed:true});assert.equal((await idle(service)).status,'complete');
 const post=calls.find(c=>c.url.endsWith('/submit'));assert.equal(post.options.headers['X-API-Key'],'private');assert.deepEqual(JSON.parse(post.options.body),{imdb_id:draft.imdb_id,is_movie:true,...draft.segments[0]});
 assert.ok(!JSON.stringify(service.list()).includes('private'));
 service.check(job,draft);const next=await idle(service);assert.deepEqual(next.duplicates,[true]);
});
test('upload requires a separate manual approval of the IntroDB comparison',async()=>{
 const {fetcher,calls}=mock({existing:{...none,outro:{start_sec:6800,end_sec:7100.5}}});const service=createUploadService({fetcher});service.configure({introdbKey:'key',tmdbToken:'token'});service.check(job,draft);const run=await idle(service);
 assert.deepEqual(run.introdbSegments,[{segment_type:'outro',start_sec:6800,end_sec:7100.5,credit_part:null}]);
 await assert.rejects(service.submit(run.id,{reviewed:true}),/Compare the scraper timestamps/);
 assert.equal(calls.some(c=>c.url.endsWith('/submit')),false);
});
test('existing exact ranges skip upload but differing ranges can correct data',async()=>{
 for(const [start,duplicate] of [[6900.125,true],[6800,false]]){
 const {fetcher,calls}=mock({existing:{...none,outro:{start_sec:start,end_sec:7100.5}}});const service=createUploadService({fetcher});service.configure({introdbKey:'key',tmdbToken:'token'});service.check(job,draft);const r=await idle(service);assert.equal(r.duplicates[0],duplicate);await service.submit(r.id,{reviewed:true,introdbReviewed:true});await idle(service);assert.equal(calls.some(c=>c.url.endsWith('/submit')),!duplicate);
 }
});

test('desktop selection uploads only the approved scene and retains the unselected outro',async()=>{
 const {fetcher,calls}=mock();const service=createUploadService({fetcher});service.configure({introdbKey:'key',tmdbToken:'token'});
 const scene={segment_type:'post-credits',start_sec:7120,end_sec:7140};
 service.check(job,{...draft,segments:[...draft.segments,scene]});const run=await idle(service);
 await assert.rejects(service.submit(run.id,{reviewed:true,introdbReviewed:true,selectedIndices:[]}),/Approve/);
 await assert.rejects(service.submit(run.id,{reviewed:true,introdbReviewed:true,selectedIndices:[2]}),/Approve/);
 await service.submit(run.id,{reviewed:true,introdbReviewed:true,selectedIndices:[1]});const done=await idle(service);
 const posts=calls.filter(c=>c.url.endsWith('/submit'));
 assert.equal(posts.length,1);assert.equal(JSON.parse(posts[0].options.body).segment_type,'post-credits');
 assert.equal(done.results[0].status,'unselected');assert.equal(done.payloads.length,2);
});

test('desktop skips an exact range created after validation',async()=>{
 const fixture=mock();let fresh=false;
 const fetcher=(url,options)=>fresh&&url.includes('/segments?')?Promise.resolve(Response.json({...none,outro:draft.segments[0]})):fixture.fetcher(url,options);
 const service=createUploadService({fetcher});service.configure({introdbKey:'key',tmdbToken:'token'});
 service.check(job,draft);const run=await idle(service);assert.equal(run.duplicates[0],false);fresh=true;
 await service.submit(run.id,{reviewed:true,introdbReviewed:true,selectedIndices:[0]});const done=await idle(service);
 assert.equal(done.results[0].status,'duplicate');assert.equal(fixture.calls.some(c=>c.url.endsWith('/submit')),false);
});

test('shared exact duplicate comparison uses milliseconds and segment type',()=>{
 const {sameIntrodbRange}=createCore({request(){}}),p=draft.segments[0];
 assert.equal(sameIntrodbRange(p,{...p,start_sec:6900.1250000001}),true);
 assert.equal(sameIntrodbRange(p,{...p,start_sec:6900.126}),false);
 assert.equal(sameIntrodbRange(p,{...p,segment_type:'post-credits'}),false);
 assert.equal(sameIntrodbRange(p,{...p,start_sec:null}),false);
});

test('invalid existing timestamps block instead of silently marking a duplicate',async()=>{
 const service=createUploadService({fetcher:mock({existing:{...none,outro:{start_sec:null,end_sec:7100}}}).fetcher});service.configure({tmdbToken:'token'});service.check(job,draft);const run=await idle(service);assert.equal(run.status,'blocked');assert.ok(run.blockers.some(x=>x.includes('invalid timestamps')));assert.equal(run.duplicates,undefined);
});
test('accepted uploads persist across service restart but validation authorization does not',async()=>{
 let saved;const service=createUploadService({fetcher:mock().fetcher,onState:async state=>{saved=structuredClone(state);}});service.configure({introdbKey:'secret',tmdbToken:'token'});service.check(job,draft);const run=await idle(service);await service.submit(run.id,{reviewed:true,introdbReviewed:true});await idle(service);
 assert.equal(saved.history.at(-1).status,'complete');assert.ok(!JSON.stringify(saved).includes('secret'));
 const next=createUploadService({fetcher:mock().fetcher,initialState:saved});next.configure({tmdbToken:'token'});assert.equal(next.list().length,0);assert.equal(next.history().length,1);next.check(job,draft);assert.deepEqual((await idle(next)).duplicates,[true]);await assert.rejects(next.submit(run.id,{reviewed:true}),/validation again/);
});
test('failed duplicate checks block and never silently pass; override requires code and audit',async()=>{
 const audit=[];const {fetcher,calls}=mock({fail:true});const service=createUploadService({fetcher,adminCode:'secret-code',onAudit:async x=>audit.push(x)});service.configure({introdbKey:'key',tmdbToken:'token'});service.check(job,draft);const r=await idle(service);assert.equal(r.status,'blocked');assert.match(r.blockers.join(),/503/);
 await assert.rejects(service.submit(r.id,{reviewed:true,introdbReviewed:true,code:'wrong',reason:'Manual review done'}),/Invalid admin/);assert.equal(calls.some(c=>c.url.endsWith('/submit')),false);
 await service.submit(r.id,{reviewed:true,introdbReviewed:true,code:'secret-code',reason:'Manual review done'});await idle(service);assert.equal(audit.length,1);assert.ok(!JSON.stringify(audit).includes('secret-code'));
});
test('known extra scenes require explicit desktop scene ranges; missing TMDB remains blocked',async()=>{
 for(const params of [{keywords:['duringcreditsstinger']},{existing:{...none,post_credits:{start_sec:7100,end_sec:7200}}},{}]){
 const {fetcher}=mock(params);const service=createUploadService({fetcher});service.configure({tmdbToken:Object.keys(params).length?'token':''});service.check(job,draft);const r=await idle(service);assert.equal(r.status,'blocked');assert.ok(r.blockers.some(x=>x.includes('Movie extra-scene')));
 }
});
test('invalid identity, specials, missing boundaries, overlaps and movie intros cannot be forced',()=>{
 for(const changes of [{imdb_id:'bad'},{media_type:'tv',season:0,episode:1},{segments:[{segment_type:'outro',start_sec:null,end_sec:20}]},{segments:[{segment_type:'outro',start_sec:7000,end_sec:7201}]},{segments:[{segment_type:'intro',start_sec:10,end_sec:30}]},{segments:[...draft.segments,...draft.segments]}])assert.throws(()=>validateDraft({...draft,...changes},job.report));
});
test('IMDb type mismatch blocks validation',async()=>{const service=createUploadService({fetcher:mock({imdb:false}).fetcher});service.configure({tmdbToken:'token'});service.check(job,draft);assert.ok((await idle(service)).blockers.some(x=>x.includes('IMDb identity')));});
test('TV mapping requires exact episode title, uses canonical numbering and skips movie checks',async()=>{
 const base=mock();const fetcher=async(url,opts)=>{
 if(url.includes('media-imdb'))return Response.json({d:[{id:draft.imdb_id,l:'Test Series',qid:'tvseries'}]});
 if(url.endsWith('/login'))return Response.json({data:{token:'tvdb-session'}});
 if(url.includes('/search/remoteid/'))return Response.json({data:[{series:{id:99}}]});
 if(url.includes('/episodes/default/'))return Response.json({data:{episodes:[{id:1,seasonNumber:2,number:5,name:'The Arrival',nameLanguage:'eng'}]}});
 return base.fetcher(url,opts);
 };const service=createUploadService({fetcher});service.configure({tvdbKey:'key'});service.check(job,{...draft,media_type:'tv',season:1,episode:1,episodeTitle:'The Arrival'});const r=await idle(service);assert.equal(r.status,'ready');assert.equal(r.payloads[0].season,2);assert.equal(r.payloads[0].episode,5);
});
test('update gate requires a published desktop installer and remembers mandatory versions offline',async()=>{
 const release=v=>({tag_name:v,assets:[{name:`SegmentScraper-Desktop-${v}-x64-Setup.exe`,size:100}]});
 const checker=createUpdateChecker({version:'1.9.5',fetcher:async()=>Response.json([{tag_name:'9.0.0',assets:[]},release('1.10.0'),{...release('2.0.0'),prerelease:true}])});
 assert.equal((await checker.check()).latestVersion,'1.10.0');assert.equal(checker.get().required,true);
 const offline=createUpdateChecker({version:'1.9.5',requiredVersion:'1.10.0',fetcher:async()=>{throw new Error();}});assert.equal((await offline.check()).required,true);
});
test('required updates are enforced by the backend, not only a dialog',async t=>{
 const app=createApp({updates:{get:()=>({required:true}),check:async()=>({required:true})}});app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>new Promise(r=>{app.close(r);app.closeAllConnections();}));const base=`http://127.0.0.1:${app.address().port}`;const {token}=await(await fetch(base+'/api/session')).json();
 const response=await fetch(base+'/api/upload-settings',{method:'POST',headers:{'X-App-Token':token,'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,423);
});
test('TVDB matching reads later catalogue pages',async()=>{
 const pages=[];
 const core=createCore({request:opts=>{
 let body;
 if(opts.url.endsWith('/login'))body={data:{token:'token'}};
 else if(opts.url.includes('/search/remoteid/'))body={data:[{series:{id:99}}]};
 else if(opts.url.includes('/translations/'))body={data:{name:'Earlier',language:'eng'}};
 else {const page=Number(new URL(opts.url).searchParams.get('page'));pages.push(page);body={data:{episodes:[{id:page+1,seasonNumber:1,number:page+1,name:page?'Target':'Earlier',nameLanguage:'eng'}]},links:{next:page===0?'next-page':null}};}
 opts.onload({status:200,responseText:JSON.stringify(body)});
 }});core.saveTvdbSettings('key');
 const result=await core.mapSeriesItemsToTvdb([{imdb_id:draft.imdb_id,season:1,episode:1,_tvdbRequireTitleMatch:true}],[{season:1,episode:1,title:'Target'}]);
 assert.equal(result.success,true);assert.equal(result.items[0].episode,2);assert.deepEqual(pages,[0,1]);
});
 test('discarding a post-credit chapter suggestion does not bypass movie protection',async()=>{
 const service=createUploadService({fetcher:mock().fetcher});service.configure({tmdbToken:'token'});service.check({...job,report:{...job.report,chapters:[{suggestion:'post-credits',issues:[]}]}},draft);assert.ok((await idle(service)).blockers.some(x=>x.includes('extra scene')));
});
test('desktop accepts a reviewed mid-credits scene even when TMDB confirms its presence',async()=>{
 const {fetcher,calls}=mock({keywords:['duringcreditsstinger']});const service=createUploadService({fetcher});service.configure({introdbKey:'key',tmdbToken:'token'});
 const movie={...job,report:{...job.report,analysis:{status:'needs-review',scenes:[{start_sec:7000,end_sec:7050,kind:'mid-credits'}]}}};
 const data={...draft,sceneReview:['scene'],segments:[{segment_type:'outro',start_sec:6900,end_sec:7000},{segment_type:'post-credits',start_sec:7000,end_sec:7050}]};
 service.check(movie,data);const r=await idle(service);assert.equal(r.status,'ready');await service.submit(r.id,{reviewed:true,introdbReviewed:true});await idle(service);
 const bodies=calls.filter(c=>c.url.endsWith('/submit')).map(c=>JSON.parse(c.options.body));assert.equal(bodies.length,2);assert.equal(bodies[0].end_sec,7000);assert.equal(bodies[1].segment_type,'post-credits');assert.ok(bodies.every(b=>!('mid-credits'in b)&&!('credit_part'in b)));
});
test('multiple confirmed scenes and overlapping movie ranges cannot be force-uploaded',()=>{
 assert.throws(()=>validateDraft({...draft,segments:[{segment_type:'outro',start_sec:6800,end_sec:7100},{segment_type:'post-credits',start_sec:7000,end_sec:7050}]},job.report),/outro must end/);
 assert.throws(()=>validateDraft({...draft,segments:[{segment_type:'post-credits',start_sec:6900,end_sec:6950},{segment_type:'post-credits',start_sec:7000,end_sec:7050}]},job.report),/one outro and one/);
 assert.throws(()=>validateDraft({...draft,sceneReview:['scene','scene']},{...job.report,analysis:{scenes:[{},{}]}}),/Multiple real scenes/);
});
test('desktop movie checks require completed analysis and explicit ending review',async()=>{
 for(const [report,reviewed]of [[{...job.report,analysis:null},true],[job.report,false]]){const service=createUploadService({fetcher:mock().fetcher});service.configure({tmdbToken:'token'});service.check({...job,report},{...draft,endingReviewed:reviewed});const r=await idle(service);assert.equal(r.status,'blocked');assert.match(r.blockers.join(),/ending|overview/);}
});
test('failed audit prevents a force upload and concurrent submissions are rejected',async()=>{
 const {fetcher,calls}=mock({fail:true});const service=createUploadService({fetcher,adminCode:'secret',onAudit:async()=>{throw new Error('disk');}});service.configure({introdbKey:'key',tmdbToken:'token'});service.check(job,draft);const r=await idle(service);await service.submit(r.id,{reviewed:true,introdbReviewed:true,code:'secret',reason:'Verified manually'});await idle(service);assert.equal(calls.some(c=>c.url.endsWith('/submit')),false);assert.equal(service.list()[0].status,'partial');await assert.rejects(service.submit(r.id,{reviewed:true,introdbReviewed:true}),/validation again/);
});
