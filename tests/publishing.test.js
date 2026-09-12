'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore, NOW } = require('./helpers');
const { claimLease } = require('../cloudfunctions/collectTick/lib/budget');
const { publish, previouslyPublished, readSnapshot } = require('../cloudfunctions/collectTick/lib/publisher');

const ID = '000000000000000000000001';
const note = { noteId: ID, authorId: '000000000000000000000002', title: '蒸蛋', desc: '鸡蛋加水蒸熟',
  author: '作者', type: 'normal', likes: 2000, boards: ['today'], judgment: { verdict: 'cooking', evidence: '加水蒸熟' } };
async function setup() {
  const store = new MemoryStore(); const lease = await claimLease(store, { owner: 'worker', now: NOW });
  const round = { id: '20260912-0900', scheduledAt: NOW - 120000, validation: false };
  await store.put('dfp_rounds', round.id, { status: 'running' });
  return { store, lease, round, now: NOW };
}
test('publishing exposes only a fully verified snapshot and cross-round dedup starts at publication', async () => {
  const ctx = await setup();
  assert.equal(await previouslyPublished(ctx.store, ID), false);
  const snapshot = await publish({ ...ctx, notes: [note], status: 'complete', coverage: {}, successfulSearches: 1 });
  assert.equal(await previouslyPublished(ctx.store, ID), true);
  assert.equal((await readSnapshot(ctx.store, snapshot.id)).notes.length, 1);
  assert.equal((await ctx.store.get('dfp_state', 'latest')).snapshotId, snapshot.id);
  const round2 = { ...ctx.round, id: '20260912-1200' };
  await ctx.store.put('dfp_rounds', round2.id, { status: 'running' });
  const second = await publish({ ...ctx, round: round2, notes: [note], status: 'complete', coverage: {}, successfulSearches: 1 });
  assert.equal((await readSnapshot(ctx.store, second.id)).notes.length, 0);
});
test('a crash before pointer commit does not erase old results or permanently deduplicate a draft', async () => {
  const ctx = await setup();
  const original = ctx.store.transaction.bind(ctx.store);
  ctx.store.transaction = fn => original(async tx => {
    const put = tx.put.bind(tx);
    tx.put = async (collection, id, value) => {
      if (collection === 'dfp_state' && id === 'latest') throw new Error('simulated crash');
      return put(collection, id, value);
    };
    return fn(tx);
  });
  await assert.rejects(publish({ ...ctx, notes: [note], status: 'complete', coverage: {}, successfulSearches: 1 }), /simulated crash/);
  assert.equal(await previouslyPublished(ctx.store, ID), false);
  assert.equal(await ctx.store.get('dfp_state', 'latest'), null);
});
test('failure without valid results retains the old snapshot; partial requires an explanation', async () => {
  const ctx = await setup();
  await ctx.store.put('dfp_state', 'latest', { snapshotId: 'old' });
  await assert.rejects(publish({ ...ctx, notes: [], status: 'complete', successfulSearches: 0, coverage: {} }), /NO_VALID_DATA/);
  await assert.rejects(publish({ ...ctx, notes: [note], status: 'partial', successfulSearches: 1, coverage: {} }), /PARTIAL_REASON_REQUIRED/);
  assert.equal((await ctx.store.get('dfp_state', 'latest')).snapshotId, 'old');
});
test('expired workers cannot publish; corruption in a part is detected on read', async () => {
  const ctx = await setup();
  await assert.rejects(publish({ ...ctx, now: NOW + 220000, notes: [note], status: 'complete', coverage: {}, successfulSearches: 1 }), /LEASE_EXPIRED/);
  const snapshot = await publish({ ...ctx, notes: [note], status: 'complete', coverage: {}, successfulSearches: 1 });
  await ctx.store.put('dfp_parts', snapshot.parts[0].id, { notes: [] });
  await assert.rejects(readSnapshot(ctx.store, snapshot.id), /CORRUPT_SNAPSHOT/);
});
test('a stale publisher cannot overwrite the winning snapshot search and favorite references', async () => {
  const ctx = await setup(); let now = NOW; let paused; let resume;
  const reached = new Promise(resolve => { paused = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const originalPut = ctx.store.put.bind(ctx.store); let intercept = true;
  ctx.store.put = async (collection, id, value) => {
    if (intercept && collection === 'dfp_notes') { intercept = false; paused(); await gate; }
    return originalPut(collection, id, value);
  };
  const old = publish({ ...ctx, now: undefined, clock: () => now, notes: [note], status: 'complete', coverage: {}, successfulSearches: 1 });
  await reached;
  now += 220000;
  const fresh = await claimLease(ctx.store, { owner: 'new-worker', now });
  const winning = await publish({ ...ctx, lease: fresh, now: undefined, clock: () => now,
    notes: [note, { ...note, noteId: '000000000000000000000009' }], status: 'complete', coverage: {}, successfulSearches: 1 });
  resume(); await assert.rejects(old, /LEASE_EXPIRED/);
  assert.equal(await previouslyPublished(ctx.store, ID), true);
  const reference = await ctx.store.get('dfp_candidates', `published_${ID}`);
  assert.equal(reference.snapshotId, winning.id);
  assert.equal((await ctx.store.get('dfp_notes', reference.indexId)).snapshotId, winning.id);
});
