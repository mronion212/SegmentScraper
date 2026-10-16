import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createCore } from '../app/shared-core.mjs';

const source = readFileSync(new URL('../src/core/videoland.js', import.meta.url),'utf8').replace(/^export /gm,'');
const clients = () => [vm.runInNewContext(`${source}\n({extractVideolandEpisodeCatalog,loadVideolandEpisodeCatalog})`,{URL}),createCore({request(){}})];
const plain = value => JSON.parse(JSON.stringify(value));
const card = (number, extra = {}) => ({itemContent:{extraTitle:`${number}. Aflevering ${number}`,action:{target:{type:'layout',value_layout:{type:'video',id:`clip_${number}`,parent:{type:'program',id:'series-a'}}}},...extra}});
const block = (season, items, nextPage = null) => ({blockId:`season-${season}`,analytics:{tealium:{from:'feature.videos_by_program',block_title:`Seizoen ${season}`}},content:{items,pagination:{nextPage}}});
const url = 'https://layout.videoland.bedrock.tech/front/v1/rtlnl/m6group_web/main/token-web-31/program/series-a/layout?blockPage=1&nbPages=2';

test('both clients count all episode cards without chapters and omit recommendations, trailers and upcoming cards',()=>{
  const layout={blocks:[block(1,[card(1),card(2),card(3,{isComingSoon:true}),card(4,{isAvailable:false}),card(5,{isPlayable:false}),card(1)]),
    {...block(2,[card(9)]),analytics:{tealium:{from:'feature.recommendations_by_program',block_title:'Seizoen 2'}}},
    {...block(3,[card(8)]),analytics:{tealium:{from:'feature.videos_by_program',block_title:'Trailers Seizoen 3'}}},
    block(4,[card(6,{action:{target:{type:'layout',value_layout:{type:'video',id:'wrong',parent:{id:'series-b'}}}}})]) ]};
  const results=clients().map(core=>core.extractVideolandEpisodeCatalog(layout,'series-a'));
  assert.deepEqual(plain(results[0]),plain(results[1]));
  assert.deepEqual(plain(results[0]),[{providerId:'clip_1',season:1,episode:1,title:'Aflevering 1'},{providerId:'clip_2',season:1,episode:2,title:'Aflevering 2'}]);
});

test('both clients follow section and item pagination, retaining full seasons without playback',async()=>{
  for(const core of clients()){
    const layout={entity:{id:'series-a',type:'program'},blocks:[block(1,[card(1),card(2)],2)],pagination:{nextPage:2}};
    const requests=[];
    const result=await core.loadVideolandEpisodeCatalog({layout,url,programId:'series-a',request:async address=>{
      requests.push(address);const next=new URL(address);
      if(next.pathname.endsWith('/layout')){assert.equal(next.searchParams.get('blockPage'),'2');return {blocks:[block(2,[card(4)])]};}
      assert.match(next.pathname,/\/program\/series-a\/block\/season-1$/);
      assert.equal(next.searchParams.get('page'),'2');
      assert.equal(next.searchParams.has('blockPage'),false);
      return {content:{items:[card(2),card(3)],pagination:{nextPage:null}}};
    }});
    assert.equal(requests.length,2);
    assert.deepEqual(plain(result.map(e=>[e.season,e.episode])),[[1,1],[1,2],[1,3],[2,4]]);
  }
});

test('a player window loads the complete programme rather than counting only nearby episodes',async()=>{
  for(const core of clients()){
    const addresses=[];
    const result=await core.loadVideolandEpisodeCatalog({layout:{blocks:[block(1,[card(7),card(8),card(9)])]},url:url.replace('/program/series-a/','/video/clip_9/'),programId:'series-a',request:async address=>{
      addresses.push(address);return {entity:{id:'series-a'},blocks:[block(1,Array.from({length:9},(_,i)=>card(i+1)))]};
    }});
    assert.equal(addresses.length,1);
    assert.match(addresses[0],/\/program\/series-a\/layout/);
    assert.equal(result.length,9);
  }
});

test('large catalogues fetch eight episode pages at a time instead of exhausting the request limit',async()=>{
  for(const core of clients()){
    let requests=0;
    const result=await core.loadVideolandEpisodeCatalog({layout:{blocks:[block(1,Array.from({length:10},(_,i)=>card(i+1)),2)]},url,programId:'series-a',request:async address=>{
      requests++;
      const query=new URL(address).searchParams;
      assert.equal(query.get('nbPages'),'8');
      const first=Number(query.get('page'));
      const last=Math.min(400,first+7);
      return {content:{items:Array.from({length:(last-first+1)*10},(_,i)=>card((first-1)*10+i+1)),pagination:{nextPage:last<400?last+1:null}}};
    }});
    assert.equal(result.length,4000);
    assert.equal(requests,50);
  }
});

test('unsupported batches retry the same cursor once with single-page requests',async()=>{
  for(const core of clients()){
    const requests=[];
    const result=await core.loadVideolandEpisodeCatalog({layout:{blocks:[block(1,[card(1)],2)]},url,programId:'series-a',request:async address=>{
      const query=new URL(address).searchParams;
      requests.push([query.get('page'),query.get('nbPages')]);
      if(query.get('nbPages')==='8')throw Object.assign(new Error('HTTP 503'),{status:503});
      const page=Number(query.get('page'));
      return {content:{items:[card(page)],pagination:{nextPage:page<3?page+1:null}}};
    }});
    assert.deepEqual(requests,[['2','8'],['2','1'],['3','1']]);
    assert.equal(result.length,3);
  }
});

test('advancing cursors cannot repeatedly return the same section or episode contents',async()=>{
  for(const core of clients()){
    let calls=0;
    await assert.rejects(core.loadVideolandEpisodeCatalog({layout:{blocks:[block(1,[card(1)])],pagination:{nextPage:2}},url,programId:'series-a',request:async()=>{
      calls++;return {blocks:[block(1,[card(1)])],pagination:{nextPage:3,totalPages:9}};
    }}),/repeated the same season sections at page 2; nextPage=3, totalPages=9/);
    assert.equal(calls,1);
    calls=0;
    await assert.rejects(core.loadVideolandEpisodeCatalog({layout:{blocks:[block(1,[card(1)],2)]},url,programId:'series-a',request:async()=>{
      calls++;return {content:{items:[card(1)],pagination:{nextPage:3,totalItems:10}}};
    }}),/repeated episode contents for season 1, episode page 2; nextPage=3, totalItems=10/);
    assert.equal(calls,1);
  }
});

test('both clients reject failed, repeated, unrelated and incomplete catalogue pages',async()=>{
  for(const core of clients()){
    await assert.rejects(core.loadVideolandEpisodeCatalog({layout:{blocks:[block(1,[card(1)],2)]},url,programId:'series-a',request:async()=>({content:{items:[card(1)],pagination:{nextPage:2}}})}),/did not advance|repeated episode/);
    await assert.rejects(core.loadVideolandEpisodeCatalog({layout:{pagination:{nextPage:2}},url,programId:'series-a',request:async()=>({blocks:[]})}),/incomplete/);
    await assert.rejects(core.loadVideolandEpisodeCatalog({layout:{},url:url.replace('/program/series-a/','/video/clip_1/'),programId:'series-a',request:async()=>({entity:{id:'series-b'},blocks:[block(1,[card(1)])]})}),/another programme/);
    await assert.rejects(core.loadVideolandEpisodeCatalog({layout:{},url,programId:'series-a',request:async()=>{throw Error('HTTP 401');}}),/usable season/);
    await assert.rejects(core.loadVideolandEpisodeCatalog({layout:{},url:url.replace('/program/series-a/','/video/clip_1/'),programId:'series-a',request:async()=>{throw Error('HTTP 401');}}),/HTTP 401/);
    await assert.rejects(core.loadVideolandEpisodeCatalog({layout:{},url:url.replace('layout.videoland.bedrock.tech','untrusted.example'),programId:'series-a',request:async()=>{throw Error('must not request');}}),/Unsupported/);
  }
});
