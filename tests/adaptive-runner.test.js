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

test('a text model outage can still publish independently verified video results', async () => {
 const x=setup(); x.deps.generate=async()=>{throw Object.assign(new Error('timeout'),{code:'ETIMEDOUT'});};
 await x.store.put('dfp_state','latest',{snapshotId:'old'});
 const result=await runTick(x.deps);
 assert.equal(result.status,'partial');
 const snapshot=await x.store.get('dfp_snapshots',result.snapshotId);
 assert.equal(snapshot.boards.week,1);assert.ok(snapshot.coverage.gaps.includes('MODEL_UNAVAILABLE'));
 const row=await x.store.get('dfp_candidates',`20260912-0900_${id(1)}`);
 assert.equal(row.note.textJudgment.verdict,'error');assert.equal(row.note.judgment.verdict,'cooking');
 assert.equal(x.counts().visualCalls,1);
});
test('two consecutive text failures stop new text calls, while eligible videos still use bounded vision',async()=>{
 const x=setup({items:[raw(1),raw(2),raw(3)]});let textCalls=0;
 x.deps.generate=async()=>{textCalls++;throw Error('service unavailable');};
 const result=await runTick(x.deps);
 assert.equal(result.status,'partial');assert.equal(textCalls,2);assert.equal(x.counts().visualCalls,3);
 const round=await x.store.get('dfp_rounds','20260912-0900');assert.equal(round.progress.aiCalls,2);
 assert.equal((await x.store.get('dfp_snapshots',result.snapshotId)).count,3);
});
test('text failures with vision disabled preserve the old snapshot and never classify unknown content as rejected',async()=>{
 const x=setup({items:[raw(1),raw(2),raw(3)]});let textCalls=0;
 x.deps.config={...base,vision:{...base.vision,enabled:false}};
 x.deps.generate=async()=>{textCalls++;throw Error('service unavailable');};
 await x.store.put('dfp_state','latest',{snapshotId:'old'});
 const result=await runTick(x.deps);assert.equal(result.status,'failed');assert.equal(textCalls,2);
 assert.equal((await x.store.get('dfp_state','latest')).snapshotId,'old');assert.equal(x.counts().visualCalls,0);
 const rows=await x.store.list('dfp_candidates',{filters:{roundId:'20260912-0900'}});
 assert.ok(rows.every(x=>x.outcome==='incomplete'));
});
test('local incomplete-body decisions do not spend text calls or reset a failed model circuit',async()=>{
 const x=setup({items:[raw(1),raw(2,{desc:undefined}),raw(3),raw(4,{desc:undefined}),raw(5)]});let textCalls=0;
 x.deps.generate=async()=>{textCalls++;throw Error('service unavailable');};
 await runTick(x.deps);assert.equal(textCalls,2);
 const round=await x.store.get('dfp_rounds','20260912-0900');assert.equal(round.progress.aiCalls,2);assert.equal(round.progress.textFailureStreak,2);
});
test('an interrupted second text failure stays counted after recovery', async () => {
 const x=setup({items:[raw(1),raw(2),raw(3)]});x.deps.config={...base,vision:{...base.vision,enabled:false}};
 let calls=0;x.deps.generate=async()=>{calls++;throw Error('timeout');};
 const transact=x.store.transaction.bind(x.store);let interrupt=true;
 x.store.transaction=fn=>transact(async tx=>{const put=tx.put.bind(tx);tx.put=async(collection,key,value)=>{
  if(interrupt&&collection==='dfp_rounds'&&value.progress?.textFailureStreak===2){interrupt=false;throw Object.assign(Error('simulated interruption'),{code:'LEASE_EXPIRED'});}return put(collection,key,value);};return fn(tx);});
 await assert.rejects(()=>runTick(x.deps),e=>e.code==='LEASE_EXPIRED');await runTick(x.deps);
 assert.equal(calls,2);const round=await x.store.get('dfp_rounds','20260912-0900');assert.equal(round.progress.textFailureStreak,2);
 await runTick(x.deps);assert.equal(calls,2);
});
test('a crash after text reservation is counted conservatively once and never replayed',async()=>{
 const x=setup({items:[raw(1),raw(2),raw(3)]});x.deps.config={...base,vision:{...base.vision,enabled:false}};
 let calls=0;x.deps.generate=async()=>{calls++;throw Error('timeout');};
 const transact=x.store.transaction.bind(x.store);let interrupt=true;
 x.store.transaction=async fn=>{const result=await transact(fn);const r=await x.store.get('dfp_rounds','20260912-0900');
  if(interrupt&&r?.progress?.aiCalls===1){const rows=await x.store.list('dfp_candidates',{filters:{roundId:'20260912-0900'}});if(rows.some(r=>r.stage==='judging'&&r.textCallReserved)){interrupt=false;throw Object.assign(Error('simulated interruption'),{code:'LEASE_EXPIRED'});}}return result;};
 await assert.rejects(()=>runTick(x.deps),e=>e.code==='LEASE_EXPIRED');assert.equal(calls,0);
 await runTick(x.deps);assert.equal(calls,1);const r=await x.store.get('dfp_rounds','20260912-0900');assert.equal(r.progress.aiCalls,2);assert.equal(r.progress.textFailureStreak,2);
 await runTick(x.deps);assert.equal(calls,1);
});
test('invalid visual evidence retains the old snapshot and preserves safe attempt diagnostics',async()=>{
 const x=setup();await x.store.put('dfp_state','latest',{snapshotId:'old'});
 x.deps.review=async()=>({verdict:'error',reason:'VISION_OUTPUT_INVALID',validationIssue:'EVIDENCE_MISSING',attemptId:'vision_'+'a'.repeat(48),httpStatus:200});
 assert.equal((await runTick(x.deps)).status,'failed');assert.equal((await x.store.get('dfp_state','latest')).snapshotId,'old');
 const row=await x.store.get('dfp_candidates',`20260912-0900_${id(1)}`);assert.equal(row.errorCode,'VISION_OUTPUT_INVALID');assert.equal(row.outcome,'incomplete');assert.equal(row.visualDiagnostics.validationIssue,'EVIDENCE_MISSING');assert.equal(row.visualDiagnostics.httpStatus,200);assert.equal(row.visualDiagnostics.attemptId,'vision_'+'a'.repeat(48));
 const round=await x.store.get('dfp_rounds','20260912-0900');assert.match(round.partialReason,/缺少有效证据/);assert.doesNotMatch(round.partialReason,/暂不可用/);
});
test('refill inspects new cooking content after rejecting the first batch without resetting spent calls',async()=>{
 const store=new MemoryStore(),first=Array.from({length:12},(_,i)=>raw(i+1,{title:'餐厅探店'+(i+1),desc:'我在餐厅吃饭，没做菜。'}));
 const good=raw(30,{title:'蒸蛋做法',desc:'鸡蛋2个，加水搅匀，蒸十分钟。'});let modelCalls=0,searches=0;
 const deps={store,config:{...base,budgetTier:'expanded250',dailyCalls:250,dailyMicroUsd:2500000,sweepCalls:100,vision:{...base.vision,enabled:false}},key:'fixture-key',clock:()=>NOW,verify:async()=>PRICE,
  generate:async messages=>{modelCalls++;const n=JSON.parse(messages[1].content);return JSON.stringify(n.title.startsWith('餐厅探店')?{verdict:'not_cooking',evidence:'在餐厅吃饭'}:{verdict:'cooking',evidence:'加水搅匀'});},
  makeProvider:options=>new Provider({...options,fetcher:async url=>{const u=new URL(url),kind=u.pathname.split('/').at(-1);
   if(kind==='search_notes'){searches++;return response({items:(modelCalls>=12?[good]:first).map(note=>({note}))});}
   if(kind==='get_creator_hot_inspiration_feed')return response({items:[]});if(kind==='get_creator_inspiration_feed')return response({inspirations:[]});
   if(kind==='get_video_note_detail'){const n=[...first,good].find(n=>n.id===u.searchParams.get('note_id'));return response([{note_list:[n]}]);}
   if(kind==='get_user_info')return response({fans:100,share_link:'https://www.xiaohongshu.com/user/profile/'+good.user.userid+'?xsec_token=sample&xsec_source=app_share'});
   throw Error('UNEXPECTED_REQUEST');
  }})};
 let result;for(let i=0;i<8;i++){result=await runTick(deps);if(result.status!=='running')break;}
 assert.ok(['complete','partial'].includes(result.status));const snapshot=await store.get('dfp_snapshots',result.snapshotId);assert.equal(snapshot.boards.week,1);
 const round=await store.get('dfp_rounds','20260912-0900');assert.ok(round.progress.discovery.refillPasses>=1);assert.ok(round.calls>12);assert.ok(round.calls<=50);assert.equal(round.progress.discovery.pendingCandidateCount,0);assert.equal(round.progress.candidateIds.length,13);assert.equal(new Set(round.progress.candidateIds).size,13);assert.ok(searches>1);assert.equal(modelCalls,13);
});
test('refill ordering preserves a missing queued ID instead of silently deleting it',async()=>{
 const x=setup();x.deps.config={...base,budgetTier:'expanded250',dailyCalls:250,dailyMicroUsd:2500000,sweepCalls:100,vision:{...base.vision,enabled:false}};
 const {scheduledRound}=require('../cloudfunctions/collectTick/lib/config'),round=scheduledRound(NOW,x.deps.config);
 const progress={candidateIds:[id(1),id(2)],candidateIndex:1,aiCalls:0,gaps:[],successfulSearches:0,discovery:{jobs:[],index:0,done:true,refillNeedsOrdering:true,candidateCount:2,pendingCandidateCount:1,freshContent:0,successfulContent:0,successfulMetadata:0}};
 await x.store.put('dfp_rounds',round.id,{status:'running',definition:round,progress,calls:0,microUsd:0});await x.store.put('dfp_candidates',round.id+'_'+id(1),{roundId:round.id,stage:'skipped',outcome:'rejected_content',note:{noteId:id(1),authorId:id(101)}});await x.store.put('dfp_state','latest',{snapshotId:'old'});
 assert.equal((await runTick(x.deps)).status,'failed');assert.deepEqual((await x.store.get('dfp_rounds',round.id)).progress.candidateIds,[id(1),id(2)]);assert.equal((await x.store.get('dfp_state','latest')).snapshotId,'old');
});
