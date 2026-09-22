const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const read = file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '');
const identity = { provider:'netflix',showId:'show',imdbId:'tt1234567',mediaType:'tv',season:1,episode:1,episodeTitle:'Pilot',segmentType:'intro',page:'/watch/123' };
function fixture() {
  const context = vm.createContext({});
  vm.runInContext(read('core/output-policy.js') + read('providers/manual-capture.js'), context);
  const events = new Map(), saved = [], renders = [];
  const video = { currentTime:0,duration:100,currentSrc:'blob:one',seeking:false,paused:false,
    pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();},
    addEventListener(type,fn){events.set(type,fn);},removeEventListener(type){events.delete(type);},
    requestVideoFrameCallback(fn){this.frame=fn;return 1;},cancelVideoFrameCallback(){this.frame=null;},
  };
  let current = {...identity}, selected=video;
  const capture=context.createManualCapture({ getContext:()=>current, record:item=>saved.push(item),render:v=>renders.push(v),findVideo:()=>selected });
  return {context,video,capture,events,saved,renders,setContext:value=>{current=value;},setVideo:value=>{selected=value;}};
}

test('manual capture pauses the actual player and stores explicit zero/fractional boundaries without offset', () => {
  const f=fixture();f.capture.mark('start');assert.equal(f.video.paused,true);
  f.video.currentTime=12.125;f.capture.mark('end');
  assert.throws(()=>f.capture.save(false),/Confirm/);
  const item=f.capture.save(true);
  assert.equal(item.start_sec,0);assert.equal(item.end_sec,12.125);
  assert.equal(item._timing.source,'manual');assert.equal(item._timing.correction_sec,0);
  assert.equal(f.saved.length,1);assert.equal(f.renders.at(-1).start,null);
  assert.equal(f.events.size,0);assert.equal(f.video.frame,null);
  assert.equal('page' in item,false);
});

test('manual capture rejects missing/reversed/out-of-video/short boundaries and uncertain players', () => {
  const f=fixture();assert.throws(()=>f.capture.mark('end'),/start first/);
  f.video.currentTime=10;f.capture.mark('start');
  assert.throws(()=>f.capture.save(true),/valid start and end/);
  for(const time of [9,12,101]){f.video.currentTime=time;f.capture.mark('end');assert.throws(()=>f.capture.save(true),/valid start and end/);}
  f.video.seeking=true;assert.throws(()=>f.capture.mark('end'),/finish seeking/);
  f.video.seeking=false;f.setVideo(null);assert.throws(()=>f.capture.mark('end'),/one visible video/);
  assert.equal(f.saved.length,0);
});

test('changing identity, source, duration or video invalidates an unfinished range', () => {
  for(const change of [f=>f.setContext({...identity,episode:2}),f=>{f.video.currentSrc='blob:next';},f=>{f.video.duration=200;},f=>f.setVideo({...f.video})]){
    const f=fixture();f.capture.mark('start');change(f);f.video.currentTime=10;
    assert.throws(()=>f.capture.mark('end'),/changed/);assert.equal(f.renders.at(-1).start,null);assert.equal(f.saved.length,0);
  }
  const f=fixture();f.capture.mark('start');f.events.get('loadstart')();assert.equal(f.renders.at(-1).start,null);
});

test('fresh frame timestamps are used, while a seek falls back to the media clock', () => {
  const f=fixture();f.capture.mark('start');
  f.video.currentTime=10.02;f.video.frame(0,{mediaTime:10});f.capture.mark('end');
  assert.equal(f.renders.at(-1).end,10);
  f.video.currentTime=20.25;f.capture.mark('end');assert.equal(f.renders.at(-1).end,20.25);
});

test('an end-first mistake does not bind the next start to an old player', () => {
  const f=fixture();assert.throws(()=>f.capture.mark('end'),/start first/);
  const next={...f.video,currentTime:20,currentSrc:'blob:two'};
  f.setVideo(next);f.setContext({...identity,episode:2});f.capture.mark('start');
  next.currentTime=30;f.capture.mark('end');
  const item=f.capture.save(true);
  assert.equal(item.start_sec,20);assert.equal(item.end_sec,30);assert.equal(item.episode,2);
});

test('boundary previews seek two seconds back and stop after the boundary', async () => {
  const f=fixture();f.video.currentTime=10;f.capture.mark('start');f.video.currentTime=20;f.capture.mark('end');
  await f.capture.preview('start');assert.equal(f.video.currentTime,8);assert.equal(f.video.paused,false);
  f.video.currentTime=12;f.events.get('timeupdate')();assert.equal(f.video.paused,true);
  assert.equal(f.capture.save(true).start_sec,10);
});

test('reset and save stop only playback started by a boundary preview', async () => {
  for (const action of ['reset', 'save']) {
    const f=fixture();f.video.currentTime=10;f.capture.mark('start');f.video.currentTime=20;f.capture.mark('end');
    await f.capture.preview('end');assert.equal(f.video.paused,false);
    f.capture[action](true);assert.equal(f.video.paused,true);assert.equal(f.events.has('timeupdate'),false);
  }
  const f=fixture();f.capture.mark('start');f.video.paused=false;f.capture.reset();
  assert.equal(f.video.paused,false,'ordinary playback is not owned by the capture controller');
});

test('an interrupted play promise cannot cancel the next preview', async () => {
  const f=fixture();f.video.currentTime=10;f.capture.mark('start');f.video.currentTime=20;f.capture.mark('end');
  let rejectFirst;f.video.play=()=>new Promise((resolve,reject)=>{rejectFirst=reject;});
  const first=f.capture.preview('start');
  f.video.play=()=>{f.video.paused=false;return Promise.resolve();};
  await f.capture.preview('end');rejectFirst(new Error('interrupted'));await first;
  assert.equal(f.video.paused,false);assert.equal(f.events.has('timeupdate'),true);
  f.video.currentTime=22;f.events.get('timeupdate')();assert.equal(f.video.paused,true);
});

test('preview startup failures clean up listeners and pause playback', async () => {
  for (const sync of [false,true]) {
    const f=fixture();f.video.currentTime=10;f.capture.mark('start');
    f.video.play=()=>{if(sync)throw new Error('failed');return Promise.reject(new Error('failed'));};
    await assert.rejects(async()=>f.capture.preview('start'),/Play button/);
    assert.equal(f.events.has('timeupdate'),false);assert.equal(f.video.paused,true);
  }
});

test('player selection ignores offscreen and ancestor-hidden videos but blocks multiple visible players', () => {
  const rect={width:800,height:450,top:0,left:0,bottom:450,right:800};
  const player=(overrides={})=>({readyState:2,getBoundingClientRect:()=>rect,...overrides});
  const active=player(),hidden=player({parentElement:{style:{opacity:'0'}}});
  const offscreen=player({getBoundingClientRect:()=>({...rect,top:900,bottom:1350})});
  let candidates=[active,hidden,offscreen];
  const document={querySelectorAll:()=>candidates};
  const context=vm.createContext({document,window:{innerHeight:720,innerWidth:1280},getComputedStyle:node=>node.style||{}});
  vm.runInContext(read('providers/manual-capture.js'),context);
  assert.equal(context.findManualCaptureVideo(),active);
  candidates=[active,player()];assert.equal(context.findManualCaptureVideo(),null);
  document.fullscreenElement={querySelectorAll:()=>[active]};assert.equal(context.findManualCaptureVideo(),active);
});

test('both clients enforce manual identity/type and movie timing policy', async () => {
  const {createCore}=await import('../app/shared-core.mjs');
  for(const core of [fixture().context,createCore({request(){}})]){
    const options={...identity,start:0,end:10,duration:100};
    for(const override of [{imdbId:''},{season:0},{episodeTitle:''},{segmentType:'post-credits'},{mediaType:'movie',segmentType:'intro'}]){
      assert.throws(()=>core.createManualSegment({...options,...override}));
    }
    const movie=core.createManualSegment({...options,mediaType:'movie',segmentType:'outro',start:90,end:100});
    assert.equal(movie.start_sec,90);assert.equal(movie.end_sec,100);assert.equal(movie._timing.correction_sec,0);
  }
});

test('provider UI callbacks save only after review, with manual identity and existing movie gates', () => {
  const f=fixture(), controls=Object.fromEntries(Object.entries({media:'tv',type:'intro',season:'1',episode:'1',title:'Pilot'}).map(([id,value])=>[`nfe-manual-${id}`,{value}]));
  controls['nfe-manual-reviewed']={checked:false};
  Object.assign(f.video,{readyState:2,getBoundingClientRect:()=>({width:800,height:450})});
  const messages=[],window={};
  const context=vm.createContext({window,location:{href:'/watch/123'},document:{getElementById:id=>controls[id]||null,querySelectorAll:()=>[f.video]},
    getComputedStyle:()=>({}),getProviderConfig:()=>({name:'Netflix'}),scheduleCaptureSave(){},updateCounters(){},updatePanelTitle(){},updateImdbInput(){},
    updateManualCapture(){},closePanel(){},toast:value=>messages.push(value),loadExistingSegmentsForEpisode:async()=>new Set(),console:{info(){},warn(){}}
  });
  vm.runInContext(['core/state.js','core/output-policy.js','providers/manual-capture.js','providers/bootstrap.js'].map(read).join('\n')+'\nglobalThis.api={state,configurePanelCallbacks};',context);
  Object.assign(context.api.state,{showId:'show',imdbId:'tt1234567',mediaType:'tv'});
  context.api.configurePanelCallbacks();window.nfePanelCallbacks.onManualStart();f.video.currentTime=10;window.nfePanelCallbacks.onManualEnd();
  window.nfePanelCallbacks.onManualSave();assert.equal(context.api.state.allItems.length,0);
  controls['nfe-manual-reviewed'].checked=true;window.nfePanelCallbacks.onManualSave();assert.equal(context.api.state.allItems.length,1);
  assert.equal(context.api.state.allItems[0]._timing.source,'manual');
  assert.equal(context.api.state.allItems[0]._tvdbRequireTitleMatch,true);
  assert.ok(messages.some(value=>value.includes('Confirm')));
  context.api.state.mediaType='movie';controls['nfe-manual-media'].value='movie';controls['nfe-manual-type'].value='outro';
  vm.runInContext("activeProviderName='prime-video';",context);
  window.nfePanelCallbacks.onManualStart();assert.match(messages.at(-1),/Movie capture is temporarily disabled/);
  assert.equal(context.api.state.allItems.length,1);
});
