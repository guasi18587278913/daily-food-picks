'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, scheduledRound } = require('../cloudfunctions/collectTick/lib/config');
const { claimLease, reserveAttempt } = require('../cloudfunctions/collectTick/lib/budget');
const { runTick } = require('../cloudfunctions/collectTick/lib/runner');
const { readSnapshot } = require('../cloudfunctions/collectTick/lib/publisher');
const { MemoryStore, PRICE } = require('./helpers');
const AT = Date.parse('2026-09-14T13:30:00+08:00');
const env = { DFP_ENABLED: 'true', DFP_FREE_AI_CONFIRMED: 'true', DFP_TIMER_SECRET: 'a'.repeat(64),
  DFP_DAILY_CALLS: '150', DFP_DAILY_MICRO_USD: '1500000', DFP_SWEEP_CALLS: '100', DFP_VALIDATION_CALLS: '20',
  DFP_VALIDATION_MICRO_USD: '200000', DFP_SUPPLEMENT_AT: '2026-09-14T13:30:00+08:00', DFP_SUPPLEMENT_CALLS: '20' };
const price = { ...PRICE, verifiedAt: AT - 1000, expiresAt: AT + 3600000 };

test('a supplement is off by default and opens one 20-minute non-validation round when configured', () => {
  const config = loadConfig(env);
  const round = scheduledRound(AT, config);
  assert.ok(round);
  assert.deepEqual([round.id, round.kind, round.validation, round.supplement, round.roundCalls, round.reservedRegularCalls],
    ['20260914-1330', 'regular', false, true, 20, 16]);
  assert.equal(round.closesAt - round.scheduledAt, 20 * 60000);
  assert.equal(scheduledRound(AT - 1, config), null);
  assert.equal(scheduledRound(AT + 20 * 60000, config), null);
  assert.equal(scheduledRound(AT, loadConfig({ ...env, DFP_SUPPLEMENT_AT: '', DFP_SUPPLEMENT_CALLS: '' })), null);
});

test('supplement settings reject missing caps, overlaps, cross-day windows and ambiguous seconds', () => {
  for (const patch of [{ DFP_SUPPLEMENT_CALLS: '' }, { DFP_SUPPLEMENT_AT: '' }, { DFP_SUPPLEMENT_CALLS: '21' },
    { DFP_SUPPLEMENT_CALLS: '0' }, { DFP_SUPPLEMENT_AT: '2026-09-14T13:30:01+08:00' },
    { DFP_SUPPLEMENT_AT: '2026-09-14T05:00:00+08:00' },
    { DFP_SUPPLEMENT_AT: '2026-09-14T05:50:00+08:00' }, { DFP_SUPPLEMENT_AT: '2026-09-14T19:50:00+08:00' },
    { DFP_SUPPLEMENT_AT: '2026-09-14T23:50:00+08:00' }, { DFP_VALIDATION_AT: '2026-09-14T13:40:00+08:00' }]) {
    assert.throws(() => loadConfig({ ...env, ...patch }), /SUPPLEMENT|CONFIGURATION/, JSON.stringify(patch));
  }
});

test('reserved regular calls follow remaining scheduled rounds without changing their allocations', () => {
  const config = loadConfig(env);
  for (const [hour, expected] of [[8, 50], [10, 33], [13, 16], [21, 0]]) {
    const at = Date.parse(`2026-09-14T${String(hour).padStart(2, '0')}:30:00+08:00`);
    assert.equal(scheduledRound(at, { ...config, supplementAt: new Date(at).toISOString() }).reservedRegularCalls, expected);
  }
  assert.deepEqual([9, 12, 20].map(hour => scheduledRound(Date.parse(`2026-09-14T${hour.toString().padStart(2, '0')}:00:00+08:00`), config).roundCalls), [17, 17, 16]);
});

async function setup(used = 102) {
  const config = loadConfig(env); const round = scheduledRound(AT, config); const store = new MemoryStore();
  const lease = await claimLease(store, { owner: 'supplement-worker', now: AT });
  await store.put('dfp_rounds', round.id, { status: 'running', calls: 0, microUsd: 0, definition: round });
  await store.put('dfp_budgets', '2026-09-14', { calls: used, microUsd: used * 10000 });
  await store.put('dfp_budgets', 'initial-validation', { calls: 20, microUsd: 200000 });
  const request = { roundId: round.id, kind: 'search', attempt: 1, now: AT, lease, price,
    limits: { ...config, roundCalls: round.roundCalls }, validation: round.validation };
  return { config, round, store, request };
}

test('supplements use their own round and daily counters while leaving an exhausted first-validation ledger intact', async () => {
  const { store, request } = await setup();
  for (let i = 0; i < 20; i++) await reserveAttempt(store, { ...request, requestKey: `supplement-${i}` });
  await assert.rejects(reserveAttempt(store, { ...request, requestKey: 'too-many' }), /ROUND_BUDGET/);
  assert.deepEqual(await store.get('dfp_budgets', 'initial-validation'), { calls: 20, microUsd: 200000 });
  assert.equal((await store.get('dfp_budgets', '2026-09-14')).calls, 122);
});

test('parallel supplement reservations cannot consume the calls kept for 20:00', async () => {
  const { store, request } = await setup(133);
  const outcomes = await Promise.allSettled([0, 1].map(i => reserveAttempt(store, { ...request, requestKey: `parallel-${i}` })));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(x => x.status === 'rejected').length, 1);
  assert.equal((await store.get('dfp_budgets', '2026-09-14')).calls, 134);
});

test('the same request reuses its reservation and regular rounds can still use their reserved capacity', async () => {
  const { store, request } = await setup(133);
  const a = await reserveAttempt(store, { ...request, requestKey: 'same' });
  const b = await reserveAttempt(store, { ...request, requestKey: 'same' });
  assert.equal(a.id, b.id); assert.equal(b.reused, true);
  const eveningId = '20260914-2000';
  await store.put('dfp_rounds', eveningId, { status: 'running', calls: 0, definition: { kind: 'regular' } });
  await reserveAttempt(store, { ...request, roundId: eveningId, requestKey: 'evening', limits: { ...request.limits, roundCalls: 16 } });
  assert.equal((await store.get('dfp_budgets', '2026-09-14')).calls, 135);
});

test('money reservation protects the later regular run as well as the call count', async () => {
  const { store, request } = await setup(100);
  await store.put('dfp_budgets', '2026-09-14', { calls: 100, microUsd: 1340000 });
  await assert.rejects(reserveAttempt(store, { ...request, requestKey: 'no-money-left-for-evening' }), /BUDGET/);
  assert.equal((await store.get('dfp_budgets', '2026-09-14')).calls, 100);
});

test('repeated supplement ticks publish once with an honest notice and never charge the first-validation ledger', async () => {
  const config = loadConfig(env); const store = new MemoryStore(); let calls = 0;
  await store.put('dfp_budgets', 'initial-validation', { calls: 20, microUsd: 200000 });
  const deps = { store, config, clock: () => AT, verify: async () => price,
    makeProvider: () => ({ async request() { calls++; return {}; }, async notes() { return []; } }) };
  const first = await runTick(deps); const again = await runTick(deps);
  assert.equal(first.status, 'partial'); assert.equal(again.snapshotId, first.snapshotId); assert.equal(calls, 4);
  const snapshot = await readSnapshot(store, first.snapshotId);
  assert.equal(snapshot.coverage.supplement, true); assert.match(snapshot.coverage.notice, /临时补跑/);
  assert.equal((await store.get('dfp_budgets', 'initial-validation')).calls, 20);
});
