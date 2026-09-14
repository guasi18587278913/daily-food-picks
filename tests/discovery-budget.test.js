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
