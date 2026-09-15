'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore, NOW } = require('./helpers');
const { claimLease } = require('../cloudfunctions/collectTick/lib/budget');
const { Discovery, source, jobFor, rankSources, finalizeStatistics } = require('../cloudfunctions/collectTick/lib/discovery');
const id = n => n.toString(16).padStart(24, '0');
const note = (n, patch = {}) => ({ noteId: id(n), authorId: id(999), author: '面包作者', title: '教你做面包',
  desc: '面粉加水搅拌。', type: 'video', likes: 20000, fans: null, publishedAt: new Date(NOW - 2 * 86400000).toISOString(),
  fetchedAt: new Date(NOW).toISOString(), bodyComplete: false, ...patch });
async function setup() {
  const store = new MemoryStore(); const lease = await claimLease(store, { owner: 'worker', now: NOW });
  const round = { id: '20260912-0900', kind: 'regular', scheduledAt: NOW, discoveryMode: 'adaptive', discoveryLimit: 4 };
  await store.put('dfp_rounds', round.id, { status: 'running', definition: round });
  const progress = { candidateIds: null, candidateIndex: 0, gaps: [] };
  const discovery = new Discovery({ store, lease, round, progress, clock: () => NOW }); await discovery.init();
  return { store, lease, round, progress, discovery };
}
function setJobs(ctx, seeds) {
  ctx.progress.discovery.jobs = seeds.map(s => jobFor(s, ctx.round)); ctx.progress.discovery.index = 0;
  for (const seed of seeds) ctx.discovery.sources.set(seed.key, seed);
}
test('real hot labels become bounded search tasks and are not counted as successful works', async () => {
  const ctx = await setup(); setJobs(ctx, [source('hot', { cursor: '' }, '热点', 'hot', NOW)]);
  const calls = [];
  const provider = { request: async (kind, params, options) => { calls.push({ kind, params, options }); return kind === 'hot'
    ? { signals: [{ label: '家宴布朗尼', pageId: null }, { label: '明星旅行', pageId: null }] } : { notes: [note(1)] }; }, notes: async result => result.notes };
  await ctx.discovery.step(provider);
  assert.equal(ctx.progress.discovery.successfulMetadata, 1); assert.equal(ctx.progress.discovery.successfulContent, 0);
  await ctx.discovery.step(provider);
  assert.equal(calls[1].kind, 'search'); assert.equal(calls[1].params.keyword, '家宴布朗尼');
  assert.equal(calls[1].options.forceFresh, true);
  assert.equal(ctx.progress.discovery.successfulContent, 1);
  assert.equal((await ctx.store.list('dfp_candidates', { filters: { roundId: ctx.round.id } })).length, 1);
});
test('inspiration follows its verified topic page and creator posts become candidates', async () => {
  const ctx = await setup(); setJobs(ctx, [source('inspiration', { cursor: '', tab: 0, source: 'creator_center' }, '灵感', 'inspiration', NOW)]);
  const calls = [];
  const provider = { request: async (kind, params) => { calls.push({ kind, params }); return kind === 'inspiration'
    ? { signals: [{ label: '美食日记', pageId: id(5) }] } : { notes: [note(2)] }; }, notes: async r => r.notes };
  await ctx.discovery.step(provider); await ctx.discovery.step(provider);
  assert.equal(calls[1].kind, 'topic'); assert.equal(calls[1].params.page_id, id(5));
});
test('public collections are checked before reading and can lead to author tasks', async () => {
  const ctx = await setup(); const seed = source('faved', { user_id: id(3), cursor: '' }, '作者收藏', 'faved', NOW);
  setJobs(ctx, [seed]); const calls = [];
  const provider = { request: async (kind) => { calls.push(kind); return kind === 'user'
    ? { collectionsPublic: true, fetchedAt: NOW } : { notes: [note(3, { title: '美食面包' })] }; }, notes: async r => r.notes };
  for (let i = 0; i < 4; i++) await ctx.discovery.step(provider);
  assert.deepEqual(calls.slice(0, 3), ['user', 'faved', 'author']);
});
test('private collections do not issue a faved request', async () => {
  const ctx = await setup(); setJobs(ctx, [source('faved', { user_id: id(3), cursor: '' }, '收藏', 'faved', NOW)]);
  const calls = [];
  const provider = { request: async kind => { calls.push(kind); return { collectionsPublic: false, fetchedAt: NOW }; } };
  for (let i = 0; i < 4; i++) await ctx.discovery.step(provider);
  assert.deepEqual(calls, ['user']);
});
test('duplicate origins do not duplicate candidates; complete related details skip another detail fetch', async () => {
  const ctx = await setup(); const first = source('search', { keyword: '面包' }, '面包', 'keyword', NOW);
  await ctx.discovery.addNotes([note(1)], { key: first.key, type: 'keyword' });
  ctx.progress.candidateIds = [id(1)]; ctx.progress.candidateIndex = 1;
  await ctx.discovery.addNotes([note(1), note(2, { bodyComplete: true })], { key: first.key, type: 'related' }, true);
  assert.deepEqual(ctx.progress.candidateIds, [id(1), id(2)]);
  assert.equal((await ctx.store.get('dfp_candidates', `${ctx.round.id}_${id(2)}`)).stage, 'judge');
  assert.equal(ctx.progress.discovery.relatedCandidates, 1);
});
test('the forty-candidate limit is cumulative even when earlier candidates are already processed', async () => {
  const ctx = await setup(); const origin = { key: source('hot', {}, '热点', 'hot', NOW).key, type: 'related' };
  await ctx.discovery.addNotes(Array.from({ length: 40 }, (_, i) => note(i + 1)), origin);
  ctx.progress.candidateIds = Array.from({ length: 40 }, (_, i) => id(i + 1)); ctx.progress.candidateIndex = 39;
  await ctx.discovery.addNotes([note(41)], origin, true);
  assert.equal(ctx.progress.candidateIds.length, 40); assert.ok(ctx.progress.gaps.includes('CANDIDATE_CAP'));
});
test('a full source pool admits a new source by replacing the oldest, rather than freezing forever', async () => {
  const ctx = await setup();
  for (let i = 0; i < 110; i++) await ctx.discovery.remember(source('author', { user_id: id(i + 1) }, `作者${i}`, 'author', NOW + i));
  assert.equal(ctx.discovery.sources.size, 100);
  assert.equal((await ctx.store.list('dfp_results', { limit: 100, filters: { recordType: 'discovery_source' } })).length, 100);
});
test('source outcomes are applied once and incomplete candidates do not become content failures', async () => {
  const ctx = await setup(); const key = source('author', { user_id: id(1) }, '作者', 'author', NOW).key;
  const rows = [{ origins: [{ key }], outcome: 'accepted' }, { origins: [{ key }], outcome: 'incomplete' }];
  await ctx.store.put('dfp_attempts', 'one', { roundId: ctx.round.id, sourceKey: key, status: 'succeeded' });
  for (let i = 0; i < 2; i++) await finalizeStatistics({ ...ctx, rows, now: NOW });
  const stats = (await ctx.store.get('dfp_results', 'source_statistics_v1')).sources[key];
  assert.equal(stats.requests, 1); assert.equal(stats.resolved, 1); assert.equal(stats.accepted, 1); assert.equal(stats.candidates, 2);
});
test('performance preference still gives an old untried source an exploration opportunity', () => {
  const a = source('author', { user_id: id(1) }, '好源', 'author', NOW), b = source('author', { user_id: id(2) }, '新源', 'author', NOW);
  const stats = { [a.key]: { requests: 3, candidates: 8, resolved: 4, accepted: 4, lastUsedAt: NOW } };
  assert.equal(rankSources([a, b], stats, NOW, false)[0].key, a.key);
  assert.equal(rankSources([a, b], stats, NOW, true)[0].key, b.key);
});
test('recovery appends durable related candidates missing from a previously saved queue', async () => {
  const { MemoryStore, NOW } = require('./helpers'); const { claimLease } = require('../cloudfunctions/collectTick/lib/budget');
  const store=new MemoryStore(),lease=await claimLease(store,{owner:'recovery',now:NOW});
  const round={id:'20260912-0900',kind:'regular',scheduledAt:NOW};
  const note={noteId:'2'.repeat(24),authorId:'3'.repeat(24),bodyComplete:true};
  await store.put('dfp_candidates',`${round.id}_${note.noteId}`,{roundId:round.id,note,stage:'judge'});
  const progress={candidateIds:['1'.repeat(24)],candidateIndex:1,gaps:[],discovery:{jobs:[],index:0,done:true}};
  await new Discovery({store,lease,round,progress,clock:()=>NOW}).init();
  assert.deepEqual(progress.candidateIds,['1'.repeat(24),'2'.repeat(24)]);
});
test('new active sources replace old statistics when the bounded learning history is full',async()=>{
 const ctx=await setup();const sources=Object.fromEntries(Array.from({length:100},(_,i)=>[`old-${i}`,{lastUsedAt:NOW-1000-i,requests:1}]));
 await ctx.store.put('dfp_results','source_statistics_v1',{sources});
 const key=source('author',{user_id:id(1000)},'新作者','author',NOW).key;
 await ctx.store.put('dfp_attempts','new',{roundId:ctx.round.id,sourceKey:key,status:'succeeded'});
 await finalizeStatistics({...ctx,rows:[],now:NOW});
 const stats=(await ctx.store.get('dfp_results','source_statistics_v1')).sources;
 assert.equal(Object.keys(stats).length,100);assert.equal(stats[key]?.requests,1);
});
test('new sweep topics use time order while accepted old definitions retain their behavior',()=>{
 const seed=source('topic',{page_id:id(7),sort:'trend'},'美食','topic',NOW);
 assert.equal(jobFor(seed,{kind:'sweep',discoveryAllocation:'candidate-reserve-v1'}).params.sort,'time');
 assert.equal(jobFor(seed,{kind:'sweep'}).params.sort,'trend');
});
test('sparse exhausted queues append unused type-specific searches and restore candidate counts without duplication',async()=>{
 const x=await setup();Object.assign(x.round,{discoveryAllocation:'candidate-reserve-v1',closesAt:NOW+1200000});
 x.progress.discovery.jobs=[];let calls=0;const provider={request:async()=>{calls++;return{notes:[note(1)]};},notes:async r=>r.notes};
 await x.discovery.step(provider);assert.equal(calls,1);assert.equal(x.progress.discovery.candidateCount,1);assert.ok(x.progress.discovery.jobs.length>4);assert.ok(x.progress.discovery.jobs.length<=64);
 assert.deepEqual(x.progress.discovery.jobs.slice(0,2).map(j=>j.params.note_type),['视频笔记','普通笔记']);
 for(const job of x.progress.discovery.jobs) assert.equal((await x.store.get('dfp_results',job.sourceKey))?.recordType,'discovery_source');
 const size=x.progress.discovery.jobs.length;x.progress.discovery.candidateCount=0;const resumed=new Discovery({...x,clock:()=>NOW});await resumed.init();assert.equal(x.progress.discovery.candidateCount,1);assert.equal(x.progress.discovery.jobs.length,size);
});
test('time or budget reserved for inspection ends discovery without marking a provider failure',async()=>{
 const x=await setup();Object.assign(x.round,{discoveryAllocation:'candidate-reserve-v1',closesAt:NOW+300000});
 await x.discovery.step({request:()=>assert.fail('no discovery at time boundary')});assert.equal(x.progress.discovery.stopReason,'inspection_time_reserve');
 const y=await setup();Object.assign(y.round,{discoveryAllocation:'candidate-reserve-v1',closesAt:NOW+1200000});
 await y.discovery.step({request:async()=>{throw Object.assign(Error('reserved'),{code:'DISCOVERY_INSPECTION_RESERVE'});}});assert.equal(y.progress.discovery.stopReason,'inspection_reserve');assert.deepEqual(y.progress.gaps,[]);
});
test('resolved candidates release inspection reserve and allow one refill per progress advance',async()=>{
 const x=await setup();Object.assign(x.round,{discoveryAllocation:'candidate-reserve-v2',closesAt:NOW+1200000,candidateTarget:20});
 await x.discovery.addNotes(Array.from({length:17},(_,i)=>note(i+1)),{key:'source',type:'keyword'});
 x.progress.candidateIds=[...x.discovery.ids];x.progress.candidateIndex=17;x.progress.aiCalls=12;
 for(const n of x.discovery.ids)x.discovery.resolved(n);assert.equal(x.progress.discovery.candidateCount,17);assert.equal(x.progress.discovery.pendingCandidateCount,0);
 Object.assign(x.progress.discovery,{done:true,stopReason:'inspection_reserve'});assert.equal(x.discovery.reopen(),true);
 const provider={request:async()=>({notes:[note(18)]}),notes:async r=>r.notes};await x.discovery.step(provider);assert.equal(x.progress.discovery.pendingCandidateCount,1);assert.equal(x.progress.candidateIds.at(-1),id(18));assert.equal(x.progress.candidateIndex,17);
 x.discovery.resolved(id(18));Object.assign(x.progress.discovery,{done:true,stopReason:'inspection_reserve'});assert.equal(x.discovery.reopen(),false);
 x.progress.candidateIndex++;assert.equal(x.discovery.reopen(),true);
});
