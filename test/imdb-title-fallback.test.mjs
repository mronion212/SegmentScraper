import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createCore } from '../app/shared-core.mjs';
import { createUploadService } from '../app/upload.mjs';

const source=readFileSync(new URL('../src/core/network.js',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace(/^export /gm,'');
const series={id:'tt0477217',l:'Gooische vrouwen',y:2005,qid:'tvSeries'};
const movie={id:'tt1700423',l:'Gooische vrouwen',y:2011,qid:'movie'};
const plain=value=>JSON.parse(JSON.stringify(value));
function client(kind, handler) {
  const requests=[];
  const request=options=>{requests.push(options.url);handler(options,requests.length);};
  const core=kind==='desktop'?createCore({request}):vm.runInNewContext(`${source}\n({searchImdbByTitle,imdbSearchQueries})`,{state:{},GM_xmlhttpRequest:request,console:{log(){},error(){}}});
  return {core,requests};
}

test('both clients resolve Gooische Vrouwen De Serie after the original query returns no results',async()=>{
  for(const kind of ['userscript','desktop']){
    const {core,requests}=client(kind,(options,count)=>options.onload({status:200,responseText:JSON.stringify({d:count===1?[]:[movie,series]})}));
    const result=await core.searchImdbByTitle('Gooische Vrouwen De Serie','',{mediaType:'tv'});
    assert.deepEqual(plain(result),{success:true,imdbId:series.id,title:series.l,year:2005});
    assert.deepEqual(requests.map(url=>decodeURIComponent(url.split('/x/')[1])),['gooische vrouwen de serie.json','gooische vrouwen.json']);
  }
});

test('fallback preserves original titles, never shortens movies, and requires an exact series title and supplied year',async()=>{
  for(const kind of ['userscript','desktop']){
    const original=client(kind,options=>options.onload({status:200,responseText:JSON.stringify({d:[{...series,l:'Gooische Vrouwen De Serie'}]})}));
    assert.equal((await original.core.searchImdbByTitle('Gooische Vrouwen De Serie')).success,true);
    assert.equal(original.requests.length,1);
    assert.deepEqual(plain(original.core.imdbSearchQueries('Example: The Series')),['Example: The Series','Example']);
    assert.deepEqual(plain(original.core.imdbSearchQueries('The Series')),['The Series']);
    const movieSearch=client(kind,options=>options.onload({status:200,responseText:'{"d":[]}'}));
    await movieSearch.core.searchImdbByTitle('Example The Series','',{mediaType:'movie'});
    assert.equal(movieSearch.requests.length,1);
    for(const [candidate,year]of [[{...series,l:'Gooische Vrouwen Making Of'},''],[series,'2025'],[movie,'']]){
      const search=client(kind,(options,count)=>options.onload({status:200,responseText:JSON.stringify({d:count===1?[]:[candidate]})}));
      assert.equal((await search.core.searchImdbByTitle('Gooische Vrouwen De Serie',year)).success,false);
    }
  }
});

test('HTTP, timeout, network and parse failures do not trigger a misleading title fallback',async()=>{
  for(const kind of ['userscript','desktop'])for(const failure of [options=>options.onload({status:503,responseText:'{"d":[]}'}),options=>options.ontimeout(),options=>options.onerror({error:'offline'}),options=>options.onload({status:200,responseText:'not json'})]){
    const {core,requests}=client(kind,failure);
    assert.equal((await core.searchImdbByTitle('Gooische Vrouwen De Serie')).success,false);
    assert.equal(requests.length,1);
  }
});

test('browser fetch fallback applies the same title and media checks',async()=>{
  const requests=[];
  const core=vm.runInNewContext(`${source}\n({searchImdbByTitle})`,{state:{},AbortSignal,console:{log(){},error(){}},fetch:async url=>{
    requests.push(url);return Response.json({d:requests.length===1?[]:[movie,series]});
  }});
  assert.equal((await core.searchImdbByTitle('Gooische Vrouwen De Serie')).imdbId,series.id);
  assert.equal(requests.length,2);
});

test('desktop lookup uses the shared fallback while leaving final identity selection to the user',async()=>{
  const requests=[];
  const service=createUploadService({fetcher:async url=>{requests.push(url);return Response.json({d:requests.length===1?[]:[movie,series]});}});
  assert.deepEqual(await service.lookup('Gooische Vrouwen De Serie','tv'),[{id:series.id,title:series.l,year:2005,type:'tvSeries'}]);
  assert.equal(requests.length,2);
});

const regionalSeries = [
  {id:'tt32816352',l:'Bestemming X Nederland',y:2024,qid:'tvSeries'},
  {id:'tt26931980',l:'Bestemming X',y:2023,qid:'tvSeries'},
];

test('both clients require confirmation for regional versions even when one title is exact',async()=>{
  for(const kind of ['userscript','desktop'])for(const results of [regionalSeries,[...regionalSeries].reverse()]){
    const {core,requests}=client(kind,options=>options.onload({status:200,responseText:JSON.stringify({d:results})}));
    const result=await core.searchImdbByTitle('Bestemming X');
    assert.equal(result.success,false);
    assert.equal(result.ambiguous,true);
    assert.equal(result.imdbId,undefined);
    assert.deepEqual(plain(result.candidates),results.map(r=>({imdbId:r.id,title:r.l,year:r.y})));
    assert.equal(requests.length,1);
    assert.equal((await core.searchImdbByTitle('Bestemming X',2024)).imdbId,'tt32816352');
    assert.equal((await core.searchImdbByTitle('Bestemming X',2026)).success,false);
  }
});

test('shared lookup requires confirmation for same-year namesakes and ambiguous title fallbacks',async()=>{
  for(const kind of ['userscript','desktop']){
    const {core}=client(kind,options=>options.onload({status:200,responseText:JSON.stringify({d:regionalSeries.map(r=>({...r,y:2024}))})}));
    assert.equal((await core.searchImdbByTitle('Bestemming X',2024)).ambiguous,true);
    const fallback=client(kind,(options,count)=>options.onload({status:200,responseText:JSON.stringify({d:count===1?[]:[series,{...series,id:'tt1234567'}]})}));
    assert.equal((await fallback.core.searchImdbByTitle('Gooische Vrouwen De Serie')).ambiguous,true);
  }
});

test('desktop displays both regional choices for explicit selection',async()=>{
  const service=createUploadService({fetcher:async()=>Response.json({d:regionalSeries})});
  assert.deepEqual(await service.lookup('Bestemming X','tv'),regionalSeries.map(r=>({id:r.id,title:r.l,year:r.y,type:r.qid})));
});
