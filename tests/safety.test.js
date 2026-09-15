'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NOW, LIMITS, PRICE, prepared } = require('./helpers');
const load = () => require('../cloudfunctions/collectTick/lib/budget');

test('missing approval, stale price, or an excessive budget cannot reserve a request', async () => {
  const { claimLease, reserveAttempt } = load();
  const store = await prepared();
  const lease = await claimLease(store, { owner: 'worker', now: NOW });
  const base = { roundId: '20260912-0900', requestKey: 'search-a', kind: 'search', attempt: 1, now: NOW, lease, limits: LIMITS, price: PRICE };
  for (const patch of [
    { limits: { ...LIMITS, dailyCalls: null } },
    { limits: { ...LIMITS, dailyCalls: 301 } },
    { limits: { ...LIMITS, dailyMicroUsd: 3000001 } },
    { limits: { ...LIMITS, roundCalls: 101 } },
    { price: { ...PRICE, expiresAt: NOW - 1 } },
    { price: { ...PRICE, microUsd: 20000 } }
  ]) await assert.rejects(() => reserveAttempt(store, { ...base, ...patch }));
  assert.equal((await store.list('dfp_attempts')).length, 0);
});

test('100 simultaneous reservations across three rounds cannot exceed the daily 50 calls', async () => {
  const { claimLease, reserveAttempt } = load();
  const store = await prepared();
  const lease = await claimLease(store, { owner: 'worker', now: NOW });
  const rounds = ['20260912-0900', '20260912-1200', '20260912-2000'];
  const results = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => reserveAttempt(store, {
    roundId: rounds[i % 3], requestKey: `request-${i}`, kind: 'search', attempt: 1,
    now: NOW, lease, price: PRICE, limits: { ...LIMITS, roundCalls: i % 3 === 2 ? 16 : 17 }
  })));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 50);
  const day = await store.get('dfp_budgets', '2026-09-12');
  assert.equal(day.calls, 50);
  assert.equal(day.microUsd, 500000);
});

test('a replayed reservation reuses the same attempt without spending again', async () => {
  const { claimLease, reserveAttempt } = load();
  const store = await prepared();
  const lease = await claimLease(store, { owner: 'worker', now: NOW });
  const request = { roundId: '20260912-0900', requestKey: 'author-a', kind: 'author', attempt: 1, now: NOW, lease, limits: LIMITS, price: PRICE };
  const first = await reserveAttempt(store, request);
  const second = await reserveAttempt(store, request);
  assert.equal(second.id, first.id);
  assert.equal(second.reused, true);
  assert.equal((await store.get('dfp_budgets', '2026-09-12')).calls, 1);
});

test('unknown or failed billed requests keep their reservation; a retry spends a second unit', async () => {
  const { claimLease, reserveAttempt, markInflight, finishAttempt } = load();
  const store = await prepared();
  const lease = await claimLease(store, { owner: 'worker', now: NOW });
  const base = { roundId: '20260912-0900', requestKey: 'request-timeout', kind: 'search', now: NOW, lease, limits: LIMITS, price: PRICE };
  const first = await reserveAttempt(store, { ...base, attempt: 1 });
  await markInflight(store, first.id, lease, NOW);
  await finishAttempt(store, first.id, lease, { status: 'unknown', errorCode: 'TIMEOUT' }, NOW);
  await reserveAttempt(store, { ...base, attempt: 2 });
  await assert.rejects(() => reserveAttempt(store, { ...base, attempt: 3 }));
  const day = await store.get('dfp_budgets', '2026-09-12');
  assert.deepEqual([day.calls, day.microUsd], [2, 20000]);
});

test('the first-validation 20-call budget is shared across different validation rounds', async () => {
  const { claimLease, reserveAttempt } = load();
  const store = await prepared();
  const lease = await claimLease(store, { owner: 'worker', now: NOW });
  for (let i = 0; i < 20; i++) await reserveAttempt(store, {
    roundId: i < 10 ? '20260912-0900' : '20260912-1200', requestKey: `validation-${i}`, kind: 'search',
    attempt: 1, now: NOW, lease, price: PRICE, limits: { ...LIMITS, roundCalls: 20 }, validation: true
  });
  await assert.rejects(() => reserveAttempt(store, {
    roundId: '20260912-2000', requestKey: 'new-validation-time-does-not-reset-budget', kind: 'search',
    attempt: 1, now: NOW, lease, price: PRICE, limits: { ...LIMITS, roundCalls: 20 }, validation: true
  }), /VALIDATION_BUDGET/);
  assert.equal((await store.get('dfp_budgets', 'initial-validation')).calls, 20);
});

test('an expired worker cannot dispatch requests after another worker claims the lease', async () => {
  const { claimLease, reserveAttempt, markInflight } = load();
  const store = await prepared();
  const old = await claimLease(store, { owner: 'old', now: NOW, ttlMs: 1000 });
  const a = await reserveAttempt(store, { roundId: '20260912-0900', requestKey: 'old-attempt', kind: 'search', attempt: 1, now: NOW, lease: old, limits: LIMITS, price: PRICE });
  assert.equal(await claimLease(store, { owner: 'new', now: NOW + 500 }), null);
  const fresh = await claimLease(store, { owner: 'new', now: NOW + 1001 });
  assert.ok(fresh.epoch > old.epoch);
  await assert.rejects(() => markInflight(store, a.id, old, NOW + 1002), /LEASE/);
});

test('calendar day accounting uses Shanghai time, including around UTC midnight', () => {
  const { shanghaiDay } = load();
  assert.equal(shanghaiDay(Date.parse('2026-09-12T16:00:00Z')), '2026-09-13');
  assert.equal(shanghaiDay(Date.parse('2026-09-12T15:59:59Z')), '2026-09-12');
});

test('catalog authorization never trusts an event-supplied identity', async () => {
  const { authorize } = require('../cloudfunctions/catalog/lib/access');
  const { MemoryStore } = require('./helpers');
  const config = { appId: 'wx8a2388888683b769', bootstrapAdminOpenId: '', migrationFallback: false, fallbackOpenIds: [] };
  const store = new MemoryStore();
  await store.put('dfp_users', 'owner', { role: 'member', status: 'active', grantedAt: '2026-09-13T00:00:00.000Z',
    grantedVia: 'invite', inviteCode: 'ABCDEFGHJK', updatedAt: '2026-09-13T00:00:00.000Z', updatedBy: 'owner' });
  const rejects = (context, code, cfg = config) => assert.rejects(() => authorize(context, cfg, store),
    error => { assert.equal(error.code, code); return true; });

  await rejects({ APPID: config.appId, OPENID: 'stranger' }, 'NOT_REGISTERED');
  await rejects({ APPID: 'other-app', OPENID: 'owner' }, 'UNAUTHENTICATED');
  await rejects({}, 'UNAUTHENTICATED');
  // A name list in configuration no longer grants anything once the migration window is closed.
  await rejects({ APPID: config.appId, OPENID: 'listed-only' }, 'NOT_REGISTERED', { ...config, fallbackOpenIds: ['listed-only'] });
  assert.equal((await authorize({ APPID: config.appId, OPENID: 'owner' }, config, store)).openId, 'owner');
});

test('a client cannot forge a timer event to invoke the collector', () => {
  const { assertTimer } = require('../cloudfunctions/collectTick/lib/config');
  const event = { Type: 'Timer', TriggerName: 'food-picks-timer', Time: '2026-09-12T01:00:00Z' };
  assert.throws(() => assertTimer(event, { OPENID: 'stranger', APPID: 'wx8a2388888683b769' }), /UNAUTHORIZED/);
  assert.throws(() => assertTimer({ ...event, TriggerName: 'other-trigger' }, {}), /UNAUTHORIZED/);
  assert.throws(() => assertTimer({}, {}), /UNAUTHORIZED/);
  assert.throws(() => assertTimer(event, { SOURCE: 'server' }), /UNAUTHORIZED/);
  assert.throws(() => assertTimer(event, {}), /UNAUTHORIZED/);
  assert.doesNotThrow(() => assertTimer(event, { SOURCE: 'wx_trigger' }));
});

test('a request reserved yesterday cannot be sent against yesterday’s budget after midnight', async () => {
  const { claimLease, reserveAttempt, markInflight } = load();
  const store = await prepared();
  const before = Date.parse('2026-09-12T23:59:59.900+08:00');
  const lease = await claimLease(store, { owner: 'night', now: before });
  const price = { ...PRICE, verifiedAt: before - 1000, expiresAt: before + 3600000 };
  const record = await reserveAttempt(store, { roundId: '20260912-2000', requestKey: 'late', kind: 'search', attempt: 1, now: before, lease, limits: LIMITS, price });
  await assert.rejects(markInflight(store, record.id, lease, before + 200), /REQUEST_DAY_CHANGED/);
});

test('invalid or normalized-overflow validation dates stop configuration loading', () => {
  const { loadConfig } = require('../cloudfunctions/collectTick/lib/config');
  for (const value of ['2026-13-99T00:00:00Z', '2026-02-30T00:00:00Z', '2026-09-12T24:00:00+08:00']) {
    assert.throws(() => loadConfig({ DFP_VALIDATION_AT: value }), /INVALID_VALIDATION_TIME/);
  }
  assert.doesNotThrow(() => loadConfig({ DFP_VALIDATION_AT: '2026-09-12T16:00:00+08:00' }));
});

test('a native SCF timer needs a server-only secret and a client cannot replay that credential', () => {
  const { assertTimer } = require('../cloudfunctions/collectTick/lib/config');
  const config = { timerSecret: 'a'.repeat(64) };
  const event = { Type: 'Timer', TriggerName: 'food-picks-timer', Message: config.timerSecret };
  assert.doesNotThrow(() => assertTimer(event, {}, config));
  assert.throws(() => assertTimer({ ...event, Message: 'b'.repeat(64) }, {}, config), /UNAUTHORIZED/);
  assert.throws(() => assertTimer(event, {}, {}), /UNAUTHORIZED/);
  assert.throws(() => assertTimer(event, { SOURCE: 'wx_client', OPENID: 'owner', APPID: 'wx8a2388888683b769' }, config), /UNAUTHORIZED/);
  assert.throws(() => assertTimer(event, { SOURCE: 'web' }, config), /UNAUTHORIZED/);
  assert.throws(() => assertTimer({ ...event, TriggerName: 'other' }, {}, config), /UNAUTHORIZED/);
});
