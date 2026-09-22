const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');

function fixture() {
  const inputs=[{value:'100'},{value:'115'}],row={querySelectorAll:()=>inputs};
  const controls={'segment-editor':{children:[row]},'selected-segment':{value:'0'},'ending-reviewed':{checked:true},'undo-boundary':{disabled:true}};
  let invalidations=0,displayPosition=103;
  const viewer={currentTime:7.125,duration:20,readyState:2,seeking:false,pause(){this.paused=true;}};
  const context=vm.createContext({viewer,activeClip:{speed:1,sourceStart:100,sourceEnd:120},undoEdits:[],
    $:id=>controls[id],sourcePosition:()=>displayPosition,updatePosition:value=>{displayPosition=value;},invalidateUpload:()=>invalidations++});
  const source=fs.readFileSync(path.join(__dirname,'../app/public/review.js'),'utf8');
  vm.runInContext(source.slice(source.indexOf('function markBoundary('),source.indexOf("bind('mark-start'")),context);
  return {context,viewer,inputs,controls,get position(){return displayPosition;},get invalidations(){return invalidations;}};
}

test('desktop marks the paused video clock rather than a stale slider and revokes approval',()=>{
  const f=fixture();f.context.markBoundary(0);
  assert.equal(f.inputs[0].value,'107.125');assert.equal(f.viewer.paused,true);assert.equal(f.position,107.125);
  assert.equal(f.controls['ending-reviewed'].checked,false);assert.equal(f.invalidations,1);
  assert.equal(f.context.undoEdits[0].start,'100');
});

test('desktop refuses seeking, unloaded, invalid and overview playback without changing edits',()=>{
  for(const overrides of [{seeking:true},{readyState:1},{error:{}},{duration:NaN},{currentTime:NaN},{currentTime:21},{currentTime:-1}]){
    const f=fixture();Object.assign(f.viewer,overrides);assert.throws(()=>f.context.markBoundary(1));
    assert.equal(f.inputs[1].value,'115');assert.equal(f.invalidations,0);assert.equal(f.context.undoEdits.length,0);
  }
  const f=fixture();f.context.activeClip.speed=12;assert.throws(()=>f.context.markBoundary(1),/1× clip/);
});
