import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {analyzeCredits,disposeAnalysis,createReviewClip,analysisStart,frameFeatures,proposeTimeline} from '../app/analysis.mjs';
import {createApp} from '../app/server.mjs';
import {once} from 'node:events';

test('dark scenes and black frames are never classified as credit text alone',()=>{
 const black=frameFeatures(Buffer.alloc(320*180));assert.equal(black.creditLike,false);assert.equal(black.black,true);
 const gray=frameFeatures(Buffer.alloc(320*180,100));assert.equal(gray.creditLike,false);
 const frame=Buffer.alloc(320*180);for(let y=35;y<95;y+=15)for(let x=45;x<270;x+=12)for(let dy=0;dy<3;dy++)for(let dx=0;dx<2;dx++)frame[(y+dy)*320+x+dx]=240;
 assert.equal(frameFeatures(frame).creditLike,true);
});
const samples=(ranges,duration=120)=>Array.from({length:duration*2},(_,i)=>({time:i/2,creditLike:ranges.some(([s,e])=>i/2>=s&&i/2<e),black:i/2>=110}));
test('mid and post-credit candidates stay separate and outro stops at the first scene',()=>{
 const result=proposeTimeline({duration:120,start:0,samples:samples([[30,60],[70,95]]),blackRanges:[{start_sec:110,end_sec:120}]});
 assert.equal(result.scenes.length,2);assert.equal(result.scenes[0].kind,'mid-credits');assert.equal(result.scenes[1].kind,'post-credits');assert.ok(result.suggestions[0].end_sec<=result.scenes[0].start_sec);assert.equal(result.scenes[1].end_sec,110);assert.ok(result.warnings.some(w=>w.includes('Multiple')));
});
test('black transitions alone do not invent credits or a scene; unresolved EOF remains unresolved',()=>{
 const data=Array.from({length:240},(_,i)=>({time:i/2,black:i<20,creditLike:false}));
 assert.equal(proposeTimeline({duration:120,start:0,samples:data,blackRanges:[{start_sec:0,end_sec:10}]}).creditsStart,null);
 const trailing=samples([[30,60]]).map(s=>({...s,black:false}));const result=proposeTimeline({duration:120,start:0,samples:trailing});assert.equal(result.scenes[0].uncertainEnd,true);assert.equal(result.suggestions.filter(s=>s.segment_type==='post-credits').length,0);
});
const ffmpeg=path.resolve('vendor/ffmpeg/ffmpeg.exe');
test('real FFmpeg ending scan detects synthetic credits/scenes and creates playable private previews',{skip:!existsSync(ffmpeg),timeout:60000},async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'credits-test-'));t.after(()=>rm(folder,{recursive:true,force:true}));const file=path.join(folder,'fixture.mkv');
 const gate="between(t,12,32)+between(t,42,62)";
 const filters=[`drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='${gate}'`];
 for(let y=35;y<95;y+=15)for(let x=45;x<270;x+=12)filters.push(`drawbox=x=${x}:y=${y}:w=2:h=3:color=white:t=fill:enable='${gate}'`);
 filters.push("drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='gte(t,72)'");
 execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=gray:s=320x180:r=10:d=80','-vf',filters.join(','),'-c:v','libx264','-preset','ultrafast',file],{windowsHide:true});
 const progress=[];const result=await analyzeCredits({input:file,remote:false},{duration:80,chapters:[]},{scanFraction:1,executable:ffmpeg,onProgress:p=>progress.push(p)});t.after(()=>disposeAnalysis(result));
 assert.equal(result.analysis.scenes.length,2);assert.ok(Math.abs(result.analysis.creditsStart-12)<1);assert.ok(result.analysis.blackRanges.some(r=>Math.abs(r.start_sec-72)<1));assert.equal(result.artifacts.length,1);const clip=await createReviewClip({input:file,remote:false},80,32,result.directory,{executable:ffmpeg});result.artifacts.push(clip);assert.equal(clip.sourceStart,26);assert.equal(clip.sourceEnd,38);assert.equal(progress.at(-1).percent,100);
 const overviewDuration=Number(execFileSync(path.resolve('vendor/ffmpeg/ffprobe.exe'),['-v','error','-show_entries','format=duration','-of','csv=p=0',result.artifacts[0].file],{encoding:'utf8'}));assert.ok(Math.abs(overviewDuration-80/12)<.3,'overview must retain 12x source timing');
 for(const a of result.artifacts){
  assert.ok((await stat(a.file)).size>1000);
  execFileSync(ffmpeg,['-v','error','-xerror','-i',a.file,'-f','null','-'],{windowsHide:true});
 }
 // Input seek must retain absolute source times, including nonzero offsets.
 const tail=await analyzeCredits({input:file,remote:false},{duration:80,chapters:[]},{scanFraction:.5,executable:ffmpeg});t.after(()=>disposeAnalysis(tail));assert.equal(tail.analysis.scanStart,40);assert.ok(Math.abs(tail.analysis.creditsStart-42)<1);assert.ok(tail.analysis.scenes.some(s=>Math.abs(s.start_sec-62)<1));
});
test('cancelled/missing FFmpeg never yields a successful analysis',async()=>{
 const controller=new AbortController();controller.abort();await assert.rejects(analyzeCredits({input:path.resolve('missing.mkv')},{duration:100,chapters:[]},{signal:controller.signal,executable:ffmpeg}));
 await assert.rejects(analyzeCredits({input:path.resolve('missing.mkv')},{duration:100,chapters:[]},{executable:'missing-ffmpeg-test'}),/FFmpeg is missing/);
});
test('desktop generated core cannot silently drift from shared source',()=>{
 execFileSync(process.execPath,['build/desktop-core.cjs','--check'],{windowsHide:true});
});
test('analysis API uses the inspected source, reports progress and invalidates old upload runs',async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'analysis-api-'));t.after(()=>rm(folder,{recursive:true,force:true}));const file=path.join(folder,'test.mkv');await import('node:fs/promises').then(fs=>fs.writeFile(file,'fixture'));
 let resolveAnalysis,invoked,invalidated;const server=createApp({probe:async()=>({duration:100,chapters:[]}),uploads:{active:()=>false,list:()=>[],adminConfigured:()=>false,invalidate:id=>{invalidated=id;}},analyzer:async(source,report,options)=>{invoked=source;options.onProgress({phase:'scanning',percent:20});return new Promise(r=>{resolveAnalysis=r;});}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));const base=`http://127.0.0.1:${server.address().port}`;const {token}=await(await fetch(base+'/api/session')).json();const api=async(route,body)=>await(await fetch(base+'/api/'+route,{method:body?'POST':'GET',headers:{'X-App-Token':token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})).json();await api('local',{paths:[file],mode:'movie'});
 let job;for(let n=0;n<100;n++){job=(await api('status')).jobs[0];if(job.status==='done')break;await new Promise(r=>setTimeout(r,5));}
 await api('analyze-credits',{jobId:job.id,scanFraction:.25,input:'C:\\not-authorized.mkv'});assert.equal(invoked.input,file);assert.equal(invalidated,job.id);assert.equal((await api('status')).jobs[0].analysisProgress.percent,20);
 resolveAnalysis({analysis:{status:'needs-review',scenes:[],suggestions:[]},artifacts:[]});
 for(let n=0;n<200;n++){job=(await api('status')).jobs[0];if(job.status==='done')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(job.status,'done');
});

test('bounded scan windows preserve explicit coverage and reject invalid input',()=>{assert.equal(analysisStart(6448.61,'last-15-minutes'),5548.61);assert.equal(analysisStart(80,'last-15-minutes'),0);assert.equal(analysisStart(80,.25),60);assert.throws(()=>analysisStart(80,'bad'));});
