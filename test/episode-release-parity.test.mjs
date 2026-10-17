import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createCore } from '../app/shared-core.mjs';

const source = readFileSync(new URL('../src/core/tvdb.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '');
const videolandSource = readFileSync(new URL('../src/core/videoland.js', import.meta.url),'utf8').replace(/^export /gm,'');
const plain = value => JSON.parse(JSON.stringify(value));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const episode = (number, aired, seasonNumber = 1) => ({ id: `${seasonNumber}-${number}`, seasonNumber, number, name: `Episode ${number}`, aired });
const segment = (number, extra = {}) => ({ imdb_id:'tt1234567',season:1,episode:number,segment_type:'intro',start_sec:10,end_sec:40,...extra });
function clients(episodes, { details = {} } = {}) {
  return ['userscript','desktop'].map(client => {
    const storage = new Map([['segmentScraper.tvdb.apikey','test']]);
    const requests = [];
    const request = options => {
      requests.push(options.url);
      let data;
      if (options.url.endsWith('/login')) data={token:'test'};
      else if (options.url.includes('/search/remoteid/')) data=[{series:{id:101}}];
      else if (options.url.includes('/episodes/default/eng?')) data={series:{episodes}};
      else if (/\/episodes\/[^/]+\/translations\/eng$/.test(options.url)) data={name:'',language:'eng'};
      else if (/\/episodes\/[^/]+$/.test(options.url)) data=details[decodeURIComponent(options.url.split('/').at(-1))] || null;
      else throw new Error(`Unexpected request: ${options.url}`);
      options.onload({status:200,responseText:JSON.stringify({data})});
    };
    const core = client === 'desktop' ? createCore({request,storage}) : vm.runInNewContext(
      `${source}\n${videolandSource}\n({ loadTvdbSettings, mapSeriesItemsToTvdb, extractVideolandEpisodeCatalog })`,
      {state:{},Date,console:{info(){},warn(){}},GM_xmlhttpRequest:request,GM_getValue:(key,fallback)=>storage.get(key)??fallback,GM_setValue:(key,value)=>storage.set(key,value)},
    );
    core.loadTvdbSettings();
    core.requests = requests;
    return core;
  });
}
async function compare(episodes, count, itemExtras = {}) {
  const catalog=Array.from({length:count},(_,i)=>({season:1,episode:i+1,title:`Episode ${i+1}`}));
  const results=await Promise.all(clients(episodes).map(core=>core.mapSeriesItemsToTvdb(catalog.map(e=>segment(e.episode,itemExtras)),catalog)));
  assert.deepEqual(plain(results[0]),plain(results[1]));
  return results[0];
}

test('both clients resolve TVDB through the corrected IMDb ID without reusing the previous series identity', async()=>{
  const catalog=[{season:1,episode:1,title:'Episode 1'}];
  for(const core of clients([episode(1,'2020-01-01')])){
    for(const imdb_id of ['tt26931980','tt32816352']){
      assert.equal((await core.mapSeriesItemsToTvdb([segment(1,{imdb_id})],catalog)).success,true);
    }
    assert.deepEqual(core.requests.filter(url=>url.includes('/search/remoteid/')).map(url=>url.split('/').at(-1)),['tt26931980','tt32816352']);
    const requests=core.requests.length;
    for(const items of [[segment(1,{imdb_id:'IMDB_PENDING'})],[segment(1,{imdb_id:'tt32816352'}),segment(1,{imdb_id:'tt26931980'})]]){
      assert.equal((await core.mapSeriesItemsToTvdb(items,catalog)).success,false);
    }
    assert.equal(core.requests.length,requests);
  }
});

test('a full Videoland catalogue uses the same unaired TVDB policy in both clients',async()=>{
  for(const extraDate of [undefined,'2999-01-01']){
    const rows=Array.from({length:9},(_,i)=>episode(i+1,'2020-01-01'));
    rows.push(episode(10,extraDate));
    for(const core of clients(rows)){
      const catalog=core.extractVideolandEpisodeCatalog({blocks:[{analytics:{tealium:{block_title:'Seizoen 1'}},content:{items:Array.from({length:9},(_,i)=>({itemContent:{extraTitle:`${i+1}. Aflevering ${i+1}`,action:{target:{type:'layout',value_layout:{type:'video',id:`clip_${i+1}`,parent:{id:'series-a'}}}}}}))}}]},'series-a');
      const result=await core.mapSeriesItemsToTvdb([segment(9)],catalog);
      assert.equal(result.success,true);
      assert.equal(result.method,'released-order');
      assert.equal(result.stats.providerRegular,9);
      assert.equal(result.stats.tvdbRegular,9);
    }
  }
});

test('both clients map nine released episodes with a tenth scheduled in the future',async()=>{
  const result=await compare([...Array.from({length:9},(_,i)=>episode(i+1,'2020-01-01')),episode(10,'2999-01-01'),episode(1,'2999-01-01',0)],9);
  assert.equal(result.success,true);
  assert.equal(result.method,'released-order');
  assert.equal(result.items.length,9);
  assert.equal(result.stats.tvdbRegular,9);
  assert.equal(result.stats.tvdbFutureExcluded,1);
  assert.equal(result.stats.tvdbSpecialsExcluded,1);
});

test('both clients recover the missing air date of S4E10 from its canonical episode record (36 vs 37)',async()=>{
  const rows=Array.from({length:4},(_,s)=>Array.from({length:9},(_,n)=>episode(n+1,'2020-01-01',s+1))).flat();
  rows.push({...episode(10,undefined,4),name:''});
  const catalog=rows.slice(0,36).map(e=>({season:e.seasonNumber,episode:e.number,title:e.name}));
  const details={'4-10':{id:'4-10',seriesId:101,seasonNumber:4,number:10,aired:'2999-01-01'}};
  const results=[];
  for(const core of clients(rows,{details})) {
    const result=await core.mapSeriesItemsToTvdb([segment(9,{season:4})],catalog);
    assert.equal(result.success,true);
    assert.equal(result.method,'released-order');
    assert.equal(result.stats.tvdbFutureExcluded,1);
    assert.equal(result.items[0].season,4);
    assert.equal(result.items[0].episode,9);
    assert.equal(core.requests.filter(url=>/\/episodes\/4-10$/.test(url)).length,1);
    results.push(result);
  }
  assert.deepEqual(plain(results[0]),plain(results[1]));
});

test('released or conflicting detail dates cannot excuse an extra episode',async()=>{
  for(const extra of [{id:'1-2',seasonNumber:1,number:2,aired:'2020-01-02'},{id:'1-2',seasonNumber:2,number:2,aired:'2999-01-01'},{id:'1-2',seriesId:202,seasonNumber:1,number:2,aired:'2999-01-01'}]) {
    for(const core of clients([episode(1,'2020-01-01'),episode(2,undefined)],{details:{'1-2':extra}})) {
      const result=await core.mapSeriesItemsToTvdb([segment(1)],[{season:1,episode:1,title:'Episode 1'}]);
      assert.equal(result.success,false);
      assert.match(result.reason,/Additional TVDB episode\(s\): S1E2/);
    }
  }
});

test('retry reloads a previously mismatched catalogue instead of keeping a stale placeholder forever',async()=>{
  const rows=[episode(1,'2020-01-01'),episode(2,'2020-01-02')];
  const cores=clients(rows);
  const catalog=[{season:1,episode:1,title:'Episode 1'}];
  for(const core of cores) assert.equal((await core.mapSeriesItemsToTvdb([segment(1)],catalog)).success,false);
  rows.pop();
  for(const core of cores) {
    assert.equal((await core.mapSeriesItemsToTvdb([segment(1)],catalog)).success,true);
    assert.equal(core.requests.filter(url=>url.includes('/episodes/default/eng?')).length,2);
  }
});
test('today counts as released and future seasons do not increase the released count',async()=>{
  const result=await compare([episode(1,today()),episode(1,'2999-01-01',2)],1);
  assert.equal(result.method,'released-order');
  assert.equal(result.items[0].season,1);
});
test('malformed and impossible air dates never excuse a count mismatch',async()=>{
  for(const date of ['unknown','2999-02-30','2999-13-01','2999-1-1']) {
    const result=await compare([episode(1,'2020-01-01'),episode(2,date)],1);
    assert.equal(result.success,false,`date ${date}`);
  }
});

test('undated extra placeholders do not count while available provider episodes remain usable',async()=>{
  for(const date of [undefined,null,'','  ']) {
    const result=await compare([episode(1,undefined),episode(2,date)],1);
    assert.equal(result.success,true);
    assert.equal(result.method,'released-order');
    assert.equal(result.stats.tvdbRegular,1);
    assert.equal(result.stats.tvdbUndatedExcluded,1);
    assert.equal(result.items[0].episode,1);
  }
});

test('Good Luck Guys 36 provider episodes match 37 TVDB rows with undated S4E10',async()=>{
  const rows=Array.from({length:4},(_,s)=>Array.from({length:9},(_,n)=>episode(n+1,undefined,s+1))).flat();
  rows.push({...episode(10,null,4),name:''});
  const catalog=rows.slice(0,36).map(e=>({season:e.seasonNumber,episode:e.number,title:`Aflevering ${e.number}`}));
  for(const core of clients(rows)) {
    const result=await core.mapSeriesItemsToTvdb([segment(9,{season:4})],catalog);
    assert.equal(result.success,true);
    assert.equal(result.stats.tvdbRegular,36);
    assert.equal(result.stats.tvdbUndatedExcluded,1);
    assert.equal(result.items[0].season,4);
    assert.equal(result.items[0].episode,9);
  }
});
test('a genuinely missing released episode is still rejected',async()=>{
  const result=await compare([episode(1,'2020-01-01'),episode(2,'2020-01-02'),episode(3,'2999-01-01')],1);
  assert.equal(result.success,false);
});
test('an already available full provider catalogue is allowed despite a future TVDB date',async()=>{
  const result=await compare([episode(1,'2020-01-01'),episode(2,'2999-01-01')],2);
  assert.equal(result.method,'order');
  assert.equal(result.items.length,2);
});

test('an early provider release stays counted even when an extra undated or future TVDB episode causes a mismatch',async()=>{
  for(const extraDate of [null,'2999-02-01']) {
    const result=await compare([episode(1,'2020-01-01'),episode(2,'2999-01-01'),episode(3,extraDate)],2);
    assert.equal(result.success,true);
    assert.equal(result.method,'released-order');
    assert.equal(result.stats.tvdbRegular,2);
    assert.equal(result.items[1].episode,2);
    assert.equal(result.stats.tvdbFutureExcluded || 0,extraDate?1:0);
    assert.equal(result.stats.tvdbUndatedExcluded || 0,extraDate?0:1);
  }
});
test('desktop/manual subsets continue to require exact non-generic title matches',async()=>{
  const result=await compare([episode(1,'2020-01-01'),episode(2,'2999-01-01')],1,{_tvdbRequireTitleMatch:true});
  assert.equal(result.success,false);
});
test('real titles can still map an early provider release without positional inference',async()=>{
  const rows=[{...episode(1,'2020-01-01'),name:'Pilot'},{...episode(2,'2999-01-01'),name:'Early finale'},{...episode(3,'2999-01-02'),name:'Reunion'}];
  const catalog=[{season:1,episode:1,title:'Early finale'}];
  for(const core of clients(rows)) {
    const result=await core.mapSeriesItemsToTvdb([segment(1,{_tvdbRequireTitleMatch:true})],catalog);
    assert.equal(result.method,'title');
    assert.equal(result.items[0].episode,2);
  }
});
