'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore, NOW } = require('./helpers');
const { claimLease } = require('../cloudfunctions/collectTick/lib/budget');
const { reserveVision, markVisionInflight, finishVision, costOf, RESERVATION_MICRO_CNY, PRICE_URL, MODEL } = require('../cloudfunctions/collectTick/lib/vision-budget');
const settings = { enabled: true, dailyMicroCny: 500000, roundCalls: 3, validationCalls: 6, validationMicroCny: 200000 };
const price = { source: PRICE_URL, model: MODEL, inputMicroCnyPerMillion: 1200000, outputMicroCnyPerMillion: 3500000, verifiedAt: NOW - 1000, expiresAt: NOW + 3600000 };
async function setup() { const store = new MemoryStore(); const lease = await claimLease(store, { owner: 'worker', now: NOW });
  await store.put('dfp_rounds', '20260912-0900', { status: 'running', definition: { visionRoundCalls: 3 } }); return { store, lease }; }
const req = (lease, n, extra = {}) => ({ lease, scope: 'round', roundId: '20260912-0900', key: n.toString(16).padStart(64, '0'), now: NOW, settings, price, ...extra });
test('missing approval or invalid price cannot reserve vision calls', async () => {
  const { store, lease } = await setup();
  await assert.rejects(() => reserveVision(store, req(lease, 1, { settings: { ...settings, enabled: false } })), /VISION_DISABLED/);
  await assert.rejects(() => reserveVision(store, req(lease, 1, { price: { ...price, expiresAt: NOW } })), /VISION_PRICE_UNVERIFIED/);
  assert.equal((await store.list('dfp_results')).length, 0);
});
test('round concurrency is capped at three; initial six calls also consume the daily money', async () => {
  const { store, lease } = await setup();
  const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reserveVision(store, req(lease, i))));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 3);
  for (let i = 0; i < 6; i++) await reserveVision(store, req(lease, i, { scope: 'validation', roundId: undefined }));
  await assert.rejects(() => reserveVision(store, req(lease, 7, { scope: 'validation' })), /VISION_VALIDATION_BUDGET/);
  assert.equal((await store.get('dfp_budgets', 'vision-day-2026-09-12')).allocatedMicroCny, 9 * RESERVATION_MICRO_CNY);
  assert.equal((await store.get('dfp_budgets', 'initial-validation')), null);
});
test('a repeat reserves once and complete valid usage settles the known amount once', async () => {
  const { store, lease } = await setup(); const a = await reserveVision(store, req(lease, 1));
  assert.equal((await reserveVision(store, req(lease, 1))).reused, true);
  await markVisionInflight(store, a.id, lease, NOW);
  const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
  const result = await finishVision(store, a.id, lease, { status: 'received', usage, result: { verdict: 'cooking' } }, NOW);
  assert.equal(result.actualMicroCny, 1550);
  assert.equal((await store.get('dfp_budgets', a.dayKey)).allocatedMicroCny, 1550);
  await assert.rejects(() => finishVision(store, a.id, lease, { status: 'received', usage }, NOW), /VISION_NOT_OWNED/);
});
test('timeouts and missing usage retain the whole reservation', async () => {
  const { store, lease } = await setup();
  for (const [n, status] of [[1, 'unknown'], [2, 'received']]) {
    const r = await reserveVision(store, req(lease, n)); await markVisionInflight(store, r.id, lease, NOW);
    const done = await finishVision(store, r.id, lease, { status }, NOW);
    assert.equal(done.allocatedMicroCny, RESERVATION_MICRO_CNY); assert.equal(done.result, null);
  }
});
test('an out-of-contract usage result blocks new vision and is never reduced to fit a cap', async () => {
  const { store, lease } = await setup(); const r = await reserveVision(store, req(lease, 1)); await markVisionInflight(store, r.id, lease, NOW);
  const usage = { prompt_tokens: 50000, completion_tokens: 1000, total_tokens: 51000 };
  const done = await finishVision(store, r.id, lease, { status: 'received', usage }, NOW);
  assert.equal(done.actualMicroCny, costOf(usage)); assert.equal(done.result, null);
  assert.equal((await store.get('dfp_budgets', r.dayKey)).allocatedMicroCny, costOf(usage));
  await assert.rejects(() => reserveVision(store, req(lease, 2)), /VISION_STOPPED/);
});
test('old owner cannot settle and yesterday reservation cannot be dispatched today', async () => {
  const { store, lease } = await setup(); const r = await reserveVision(store, req(lease, 1)); await markVisionInflight(store, r.id, lease, NOW);
  const later = NOW + 300000; const next = await claimLease(store, { owner: 'next', now: later });
  await assert.rejects(() => finishVision(store, r.id, lease, { status: 'unknown' }, later), /LEASE_EXPIRED/);
  await assert.rejects(() => finishVision(store, r.id, next, { status: 'unknown' }, later), /VISION_NOT_OWNED/);
  const midnight = Date.parse('2026-09-12T23:59:59+08:00');
  const night = await claimLease(store, { owner: 'night', now: midnight });
  const late = await reserveVision(store, req(night, 3, { now: midnight, price: { ...price, verifiedAt: midnight - 1000, expiresAt: midnight + 10000 } }));
  await assert.rejects(() => markVisionInflight(store, late.id, night, midnight + 2000), /REQUEST_DAY_CHANGED/);
});
test('a stopped channel cannot dispatch an already reserved second request', async () => {
  const { store, lease } = await setup();
  const a = await reserveVision(store, req(lease, 1)), b = await reserveVision(store, req(lease, 2));
  await markVisionInflight(store, a.id, lease, NOW);
  await finishVision(store, a.id, lease, { status: 'received', usage: { prompt_tokens: 20000, completion_tokens: 1, total_tokens: 20001 } }, NOW);
  await assert.rejects(() => markVisionInflight(store, b.id, lease, NOW), /VISION_STOPPED/);
  assert.equal((await store.get('dfp_results', b.id)).status, 'reserved');
});
test('very large computable usage is recorded and stops the channel', async () => {
  const { store, lease } = await setup(); const a = await reserveVision(store, req(lease, 1)); await markVisionInflight(store, a.id, lease, NOW);
  const usage = { prompt_tokens: 10000001, completion_tokens: 1, total_tokens: 10000002 };
  const result = await finishVision(store, a.id, lease, { status: 'received', usage }, NOW);
  assert.equal(result.actualMicroCny, 12000005);
  assert.equal((await store.get('dfp_budgets', a.dayKey)).allocatedMicroCny, 12000005);
  assert.equal((await store.get('dfp_state', 'vision_stop')).blocked, true);
});
test('existing negative round counts or zero limits fail closed', async () => {
  for (const patch of [{ visionCalls: -4 }, { definition: { visionRoundCalls: 0 } }]) {
    const { store, lease } = await setup();
    const round = await store.get('dfp_rounds', '20260912-0900'); await store.put('dfp_rounds', '20260912-0900', { ...round, ...patch });
    await assert.rejects(() => reserveVision(store, req(lease, 1)), /VISION_INVALID_BUDGET/);
    assert.equal((await store.list('dfp_results')).length, 0);
  }
});
