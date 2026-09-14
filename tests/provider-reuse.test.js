'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Provider } = require('../cloudfunctions/collectTick/lib/provider');
const { claimLease } = require('../cloudfunctions/collectTick/lib/budget');
const { MemoryStore, NOW, LIMITS, PRICE } = require('./helpers');
const raw = { id: '1'.repeat(24), user: { userid: '2'.repeat(24) }, type: 'video', title: '教你做面包',
  desc: '面粉加水拌匀。', likes: 20000, time: (NOW - 3 * 86400000) / 1000 };
async function create(store, time, roundId, fetcher) {
  const round = { id: roundId, kind: 'regular', roundCalls: 17, discoveryMode: 'adaptive', discoveryLimit: 4 };
  await store.put('dfp_rounds', roundId, { status: 'running', definition: round });
  const lease = await claimLease(store, { owner: roundId, now: time });
  return new Provider({ store, lease, round, config: { ...LIMITS, enabled: true, freeAiConfirmed: true },
    price: { ...PRICE, verifiedAt: time - 1000, expiresAt: time + 3600000 }, key: 'fixture-provider-key', fetcher, clock: () => time });
}
test('a second round reuses unchanged full detail and keeps newer discovery metrics', async () => {
  const store = new MemoryStore(); let requests = 0;
  const fetcher = async () => { requests++; return Response.json({ code: 200, data: { code: 0, success: true, data: [{ note_list: [raw] }] } }); };
  const first = await create(store, NOW, '20260912-0900', fetcher);
  const result = await first.request('note_video', { note_id: raw.id });
  const full = (await first.notes(result))[0];
  const later = NOW + 3 * 3600000;
  const second = await create(store, later, '20260912-1200', fetcher);
  const reused = await second.request('note_video', { note_id: raw.id }, { expectedNote: { ...full, likes: 22000, bodyComplete: false, fetchedAt: new Date(later).toISOString() } });
  assert.equal(requests, 1); assert.equal(second.sent, 0); assert.equal(reused.cached, true);
  assert.equal((await second.notes(reused))[0].likes, 22000);
  assert.equal((await store.get('dfp_budgets', '2026-09-12')).calls, 1);
});
test('forced current-round discovery is fetched even when an earlier result is cached', async () => {
  const store = new MemoryStore(); let requests = 0;
  const fetcher = async () => { requests++; return Response.json({ code: 200, data: { code: 0, success: true, data: { items: [] } } }); };
  const params = { keyword: '家常菜', page: 1, sort_type: 'popularity_descending', time_filter: '一周内', note_type: '不限' };
  const first = await create(store, NOW, '20260912-0900', fetcher);
  await first.request('search', params, { forceFresh: true });
  const next = await create(store, NOW + 3 * 3600000, '20260912-1200', fetcher);
  await next.request('search', params, { forceFresh: true });
  assert.equal(requests, 2);
  assert.equal((await store.get('dfp_rounds', '20260912-1200')).discoveryCalls, 1);
});
test('corrupt cached pages are not silently read as an empty successful response', async () => {
  const store = new MemoryStore();
  const provider = await create(store, NOW, '20260912-0900', async () => { throw Error('not called'); });
  await assert.rejects(() => provider.notes({ pages: ['missing'] }), /PROVIDER_SCHEMA/);
});
test('a reusable week detail cannot treat an expired attached today video as a complete fresh detail',async()=>{
 const store=new MemoryStore(); const today={...raw,id:'3'.repeat(24),time:(NOW-3600000)/1000,likes:1500};
 const fetcher=async()=>Response.json({code:200,data:{code:0,success:true,data:[{note_list:[raw,today]}]}});
 const first=await create(store,NOW,'20260912-0900',fetcher);await first.request('note_video',{note_id:raw.id});
 const later=await create(store,NOW+3*3600000,'20260912-1200',fetcher);
 const result=await later.request('note_video',{note_id:raw.id});assert.equal(result.cached,true);
 const notes=await later.notes(result);assert.equal(notes.find(n=>n.noteId===raw.id).bodyComplete,true);
 assert.equal(notes.find(n=>n.noteId===today.id).bodyComplete,false);
});
