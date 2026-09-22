const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
class Element {
  constructor(tag){this.tag=tag;this.style={};this.children=[];this.listeners={};}
  set textContent(value){this.text=value;this.children=[];}
  get textContent(){return this.text||'';}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  setAttribute(){} addEventListener(name,fn){this.listeners[name]=fn;} focus(){} remove(){}
}
const items=['intro','recap','outro'].map((segment_type,i)=>({imdb_id:'tt1234567',season:1,episode:1,segment_type,start_sec:i*20,end_sec:i*20+10}));

test('userscript type filter limits rows, exports and approval; switching clears hidden approvals',()=>{
  const document={body:new Element('body'),getElementById:()=>null,createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text})};
  const context=vm.createContext({document,PANEL_COLORS:{},getProviderConfig:()=>({name:'Netflix',colors:{}})});
  for(const file of ['core/output-policy.js','ui/panel.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src',file),'utf8').replace(/^import .*$/gm,'').replace(/^export /gm,''),context);
  let exported,uploaded;
  context.showExportPreview({items,uploadItems:items,rows:items.map(item=>({item,status:'NEW'})),onConfirm:(_,visible)=>{exported=visible;},onUpload:selected=>{uploaded=selected;}});
  const dialog=document.body.children[0].children[0],summary=dialog.children[1],preview=dialog.children[2],actions=dialog.children[3];
  const setFilter=value=>{const select=summary.children[0].children[0];select.value=value;select.listeners.change();};
  const approveAll=()=>{const input=preview.children[0].children[0];input.checked=true;input.listeners.change();};
  approveAll();assert.equal(actions.children[2].disabled,false);
  setFilter('recap');assert.equal(actions.children[2].disabled,true);
  assert.equal(preview.children.filter(node=>node.tag==='div').length,1);
  actions.children[1].listeners.click();assert.deepEqual(Array.from(exported,item=>item.segment_type),['recap']);
  approveAll();actions.children[2].listeners.click();assert.deepEqual(Array.from(uploaded,item=>item.segment_type),['recap']);
  setFilter('post-credits');assert.equal(actions.children[1].disabled,true);assert.equal(actions.children[2].disabled,true);
});

test('desktop type filter preserves real indices and clears approval for hidden types',()=>{
  const host=new Element('host'),approvedSegments=new Set([0,1,2]);
  const context=vm.createContext({approvedSegments,uploadSnapshot:'',poll:()=>Promise.resolve(),notice(){},time:String,$:()=>host,
    document:{createTextNode:text=>({textContent:text})},el:(tag,text)=>{const node=new Element(tag);node.textContent=text;return node;}});
  const source=fs.readFileSync(path.join(__dirname,'../app/public/upload.js'),'utf8');
  vm.runInContext(source.slice(source.indexOf("let comparisonSnapshot=''")),context);
  const run={status:'ready',steps:[],payloads:items,introdbSegments:[],duplicates:[]};
  context.renderIntrodbComparison(run);
  const select=host.children[1].children[0];select.value='outro';select.onchange();
  assert.equal(approvedSegments.size,0);
  const approve=host.children[2].children[0];approve.checked=true;approve.onchange();
  assert.deepEqual([...approvedSegments],[2]);
  const grid=host.children[3];assert.equal(grid.children.length,1);
});
