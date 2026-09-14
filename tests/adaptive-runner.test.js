'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { MemoryStore, NOW, PRICE } = require('./helpers');
const { runTick } = require('../cloudfunctions/collectTick/lib/runner');
const { Provider } = require('../cloudfunctions/collectTick/lib/provider');
const { loadConfig } = require('../cloudfunctions/collectTick/lib/config');
const id = n => n.toString(16).padStart(24, '0');
const base = { enabled: true, freeAiConfirmed: true, dailyCalls: 50, dailyMicroUsd: 500000,
 validationCalls: 20, validationMicroUsd: 200000, maxAiCallsPerRound: 20, discoveryMode: 'adaptive',
 vision: { enabled: true, dailyMicroCny: 500000, roundCalls: 3, validationCalls: 6, validationMicroCny: 200000 } };
function raw(n, patch = {}) { return { id: id(n), user: { userid: id(100+n), nickname: '作者' }, type: 'video',
 time: (NOW - 2*86400000)/1000, liked_count: 15000, title: '一盘菜', desc: '', ...patch }; }
const response = data => Response.json({ code: 200, data: { success: true, code: 0, data } });
function setup({ items = [raw(1)], related = [], failContent = false, visionError = false } = {}) {
 const store = new MemoryStore(); const calls = []; let modelCalls = 0; let visualCalls = 0;
 const deps = { store, config: base, key: 'fixture-key', clock: () => NOW, verify: async () => PRICE,
  generate: async messages => { modelCalls++; const note = JSON.parse(messages[1].content);
   return JSON.stringify(note.desc ? {verdict:'cooking',evidence:'加水蒸十分钟'} : {verdict:'uncertain',evidence:''}); },
  review: async () => { visualCalls++; if (visionError) return {verdict:'error',reason:'VISION_HTTP_ERROR'};
   return {verdict:'cooking',evidenceSource:'frames',evidence:[{frame:1,observation:'加水搅拌'},{frame:2,observation:'加热煮熟'}]}; },
  makeProvider: options => new Provider({...options, fetcher: async (url) => {
   const kind = new URL(url).pathname.split('/').at(-1); calls.push(kind);
   if (kind === 'get_creator_hot_inspiration_feed') return response({items:[{title:'家常菜做法',hot_id:'1234567'}]});
   if (kind === 'get_creator_inspiration_feed') return response({inspirations:[]});
   if (kind === 'search_notes') return failContent ? new Response('',{status:400}) : response({items:items.map(note=>({note}))});
   if (kind === 'get_video_note_detail') return response([{note_list:[...items,...related]}]);
   throw Error('UNEXPECTED_REQUEST');
  }}) };
 return {store,calls,deps,counts:()=>({modelCalls,visualCalls})};
}
test('adaptive discovery reserves four attempts then inspects; related full notes need no extra details', async () => {
 const x = setup({related:[raw(2,{desc:'加水蒸十分钟'})]});
 const result = await runTick(x.deps);
 assert.equal(result.status,'complete');
 assert.equal(x.calls.filter(k=>k==='get_video_note_detail').length,1);
 const snapshot = await x.store.get('dfp_snapshots',result.snapshotId);
 assert.equal(snapshot.boards.week,2); assert.equal(snapshot.coverage.discovery.relatedCandidates,1);
 assert.equal((await x.store.get('dfp_rounds','20260912-0900')).discoveryCalls,4);
 assert.deepEqual(x.counts(),{modelCalls:2,visualCalls:1});
 const before=x.calls.length; await runTick(x.deps);assert.equal(x.calls.length,before);
 assert.equal((await x.store.get('dfp_rounds','20260912-0900')).discoveryStatsApplied,true);
});
test('successful metadata with no successful content scan retains the old snapshot',async()=>{
 const x=setup({failContent:true});await x.store.put('dfp_state','latest',{snapshotId:'old'});
 assert.equal((await runTick(x.deps)).status,'failed');
 assert.equal((await x.store.get('dfp_state','latest')).snapshotId,'old');assert.equal(x.counts().visualCalls,0);
});
test('visual service failure retains old data and leaves candidates incomplete, not content-rejected',async()=>{
 const x=setup({visionError:true});await x.store.put('dfp_state','latest',{snapshotId:'old'});
 assert.equal((await runTick(x.deps)).status,'failed');assert.equal((await x.store.get('dfp_state','latest')).snapshotId,'old');
 const row=await x.store.get('dfp_candidates',`20260912-0900_${id(1)}`);
 assert.equal(row.outcome,'incomplete');assert.equal(row.note.textJudgment.verdict,'uncertain');
});
test('numeric-ineligible posts never trigger detail, text or visual calls',async()=>{
 const x=setup({items:[raw(1,{liked_count:10})]});assert.equal((await runTick(x.deps)).status,'complete');
 assert.deepEqual(x.counts(),{modelCalls:0,visualCalls:0});assert.equal(x.calls.includes('get_video_note_detail'),false);
});
test('configuration requires explicit visual caps and keeps keys out of round configuration',()=>{
 assert.throws(()=>loadConfig({DFP_DISCOVERY_MODE:'adaptive',DFP_VISION_ENABLED:'true'}),/INVALID_VISION_CONFIG/);
 const config=loadConfig({DFP_DISCOVERY_MODE:'adaptive',DFP_VISION_ENABLED:'true',DFP_VISION_DAILY_MICRO_CNY:'500000',
 DFP_VISION_ROUND_CALLS:'3',DFP_VISION_KEY:'fixture-only-secret-value'});
 assert.equal(JSON.stringify(config).includes('fixture-only-secret-value'),false);
 assert.throws(()=>loadConfig({DFP_DISCOVERY_MODE:'unknown'}),/INVALID_DISCOVERY_CONFIG/);
});
test('a source pool full of metadata lookups still performs a fresh post query within four attempts',async()=>{
 const {source}=require('../cloudfunctions/collectTick/lib/discovery'); const x=setup({items:[]});
 for(let i=0;i<8;i++){const seed=source('user',{user_id:id(200+i)},'公开性查询','faved',NOW);await x.store.put('dfp_results',seed.key,seed);}
 const result=await runTick(x.deps);assert.ok(x.calls.includes('search_notes'));
 assert.equal((await x.store.get('dfp_snapshots',result.snapshotId)).coverage.discovery.freshContent>0,true);
});
test('optional judgment-cache write failure preserves accepted content and reports a cache gap',async()=>{
 const x=setup({items:[raw(1,{desc:'加水蒸十分钟'})]});
 const transact=x.store.transaction.bind(x.store);
 x.store.transaction=fn=>transact(async tx=>{const put=tx.put.bind(tx);tx.put=async(c,id,v)=>{if(id.startsWith('judgment_'))throw Error('CACHE_WRITE_TEST');return put(c,id,v)};return fn(tx)});
 const result=await runTick(x.deps);const snapshot=await x.store.get('dfp_snapshots',result.snapshotId);
 assert.equal(snapshot?.boards.week,1);assert.equal(result.status,'partial');assert.ok(snapshot.coverage.gaps.includes('CACHE_UNAVAILABLE'));
});
