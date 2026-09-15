'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore, NOW, PRICE, LIMITS } = require('./helpers');
const { claimLease, reserveAttempt } = require('../cloudfunctions/collectTick/lib/budget');
async function prepared(kind = 'regular') {
  const store = new MemoryStore();
  await store.put('dfp_rounds', '20260912-0900', { status: 'running', definition: {
    kind, discoveryMode: 'adaptive', discoveryLimit: kind === 'sweep' ? 18 : 4 } });
  const lease = await claimLease(store, { owner: 'worker', now: NOW });
  return { store, lease };
}
const req = (lease, key, kind = 'search', extra = {}) => ({ roundId: '20260912-0900', requestKey: key,
  kind, purpose: 'discovery', attempt: 1, now: NOW, lease, price: PRICE, limits: LIMITS, ...extra });
test('metadata, derived queries, and concurrent reservations share the four-call discovery cap', async () => {
  const { store, lease } = await prepared();
  const kinds = ['hot', 'inspiration', 'topic', 'faved', 'author', 'search'];
  const outcomes = await Promise.allSettled(kinds.map((kind, i) => reserveAttempt(store, req(lease, `job-${i}`, kind))));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 4);
  const round = await store.get('dfp_rounds', '20260912-0900');
  assert.equal(round.discoveryCalls, 4); assert.equal(round.calls, 4);
  await reserveAttempt(store, req(lease, 'detail', 'note_video', { purpose: 'inspection' }));
  assert.equal((await store.get('dfp_rounds', '20260912-0900')).discoveryCalls, 4);
});
test('retry occupies another discovery unit; replay does not buy a new unit', async () => {
  const { store, lease } = await prepared();
  const a = await reserveAttempt(store, req(lease, 'hot', 'hot'));
  const repeat = await reserveAttempt(store, req(lease, 'hot', 'hot'));
  assert.equal(repeat.reused, true); assert.equal(a.id, repeat.id);
  await reserveAttempt(store, req(lease, 'hot', 'hot', { attempt: 2 }));
  await reserveAttempt(store, req(lease, 'a')); await reserveAttempt(store, req(lease, 'b'));
  await assert.rejects(() => reserveAttempt(store, req(lease, 'after-restart')), /DISCOVERY_BUDGET/);
  assert.equal((await store.get('dfp_budgets', '2026-09-12')).calls, 4);
});
test('search cannot relabel itself as inspection to evade the discovery budget', async () => {
  const { store, lease } = await prepared();
  await assert.rejects(() => reserveAttempt(store, req(lease, 'pretend', 'search', { purpose: 'inspection' })), /INVALID_REQUEST/);
  assert.equal((await store.list('dfp_attempts')).length, 0);
});
test('the discovery ceiling itself cannot be raised past its approved range', async () => {
  const { store, lease } = await prepared();
  const r = await store.get('dfp_rounds', '20260912-0900'); r.definition.discoveryLimit = 50;
  await store.put('dfp_rounds', '20260912-0900', r);
  await assert.rejects(() => reserveAttempt(store, req(lease, 'oversized')), /INVALID_BUDGET/);
});
async function dynamicSetup({calls=18,candidates=5,dailyCalls=calls,research=0,roundCalls=100,supplementReserve=0}={}){
 const store=new MemoryStore(),lease=await claimLease(store,{owner:'dynamic',now:NOW});
 const definition={kind:'sweep',budgetTier:'expanded250',discoveryMode:'adaptive',discoveryAllocation:'candidate-reserve-v1',roundCalls,...(supplementReserve?{supplement:true,reservedRegularCalls:supplementReserve}:{})};
 await store.put('dfp_rounds','20260912-0900',{status:'running',definition,calls,discoveryCalls:calls,progress:{discovery:{candidateCount:candidates}}});
 await store.put('dfp_budgets','2026-09-12',{calls:dailyCalls,microUsd:dailyCalls*10000,additionalResearchCalls:research,additionalResearchMicroUsd:research*10000});
 return{store,lease,request:req(lease,'next','search',{limits:{...LIMITS,budgetTier:'expanded250',dailyCalls:250,dailyMicroUsd:2500000,roundCalls}})};
}
test('a sparse new sweep continues past eighteen discovery calls while preserving inspection funds',async()=>{
 const x=await dynamicSetup();await reserveAttempt(x.store,x.request);assert.equal((await x.store.get('dfp_rounds','20260912-0900')).calls,19);
 const before=structuredClone(x.store.docs);assert.equal((await reserveAttempt(x.store,x.request)).reused,true);assert.deepEqual(x.store.docs,before);
});
test('the exact discovery plus inspection boundary allows one reservation and rejects the next without writes',async()=>{
 const x=await dynamicSetup({calls:79});await reserveAttempt(x.store,x.request);const before=structuredClone(x.store.docs);
 await assert.rejects(reserveAttempt(x.store,{...x.request,requestKey:'overflow'}),/DISCOVERY_INSPECTION_RESERVE/);assert.deepEqual(x.store.docs,before);
});
test('daily research money and later supplement rounds reduce discovery space before inspection does',async()=>{
 for(const settings of [{dailyCalls:220,research:10},{dailyCalls:160,research:20,supplementReserve:50}]){
  const x=await dynamicSetup(settings),before=structuredClone(x.store.docs);await assert.rejects(reserveAttempt(x.store,x.request),/DISCOVERY_INSPECTION_RESERVE/);assert.deepEqual(x.store.docs,before);
  await reserveAttempt(x.store,{...x.request,kind:'note_video',purpose:'inspection'});
 }
});
test('new dynamic discovery retries use real funds and corrupted candidate counts cannot spend',async()=>{
 const x=await dynamicSetup({calls:78});await reserveAttempt(x.store,x.request);await reserveAttempt(x.store,{...x.request,attempt:2});assert.equal((await x.store.get('dfp_rounds','20260912-0900')).calls,80);
 const row=await x.store.get('dfp_rounds','20260912-0900');row.progress.discovery.candidateCount=-1;await x.store.put('dfp_rounds','20260912-0900',row);
 await assert.rejects(reserveAttempt(x.store,{...x.request,requestKey:'invalid'}),/INVALID_BUDGET/);
});
test('new allocation never interprets missing or null durable candidate counts as zero',async()=>{
 for(const value of [undefined,null]){const x=await dynamicSetup();const row=await x.store.get('dfp_rounds','20260912-0900');row.progress.discovery.candidateCount=value;await x.store.put('dfp_rounds','20260912-0900',row);const before=structuredClone(x.store.docs);await assert.rejects(reserveAttempt(x.store,x.request),/INVALID_BUDGET/);assert.deepEqual(x.store.docs,before);}
});
test('refill budget uses pending candidates while cumulative candidates still remain recorded',async()=>{
 const x=await dynamicSetup({calls:21,roundCalls:50,candidates:17});const row=await x.store.get('dfp_rounds','20260912-0900');row.definition.discoveryAllocation='candidate-reserve-v2';row.progress.discovery.pendingCandidateCount=0;await x.store.put('dfp_rounds','20260912-0900',row);
 await reserveAttempt(x.store,x.request);const after=await x.store.get('dfp_rounds','20260912-0900');assert.equal(after.calls,22);assert.equal(after.progress.discovery.candidateCount,17);
 delete after.progress.discovery.pendingCandidateCount;await x.store.put('dfp_rounds','20260912-0900',after);await assert.rejects(reserveAttempt(x.store,{...x.request,requestKey:'missing-pending'}),/INVALID_BUDGET/);
});
