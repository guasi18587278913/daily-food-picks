'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ENDPOINTS, endpoint, detailKind } = require('../cloudfunctions/collectTick/lib/endpoints');
const { validateParams } = require('../cloudfunctions/collectTick/lib/provider');
const { reserveAttempt, claimLease, PRICE_URL, PRICE_MICRO_USD } = require('../cloudfunctions/collectTick/lib/budget');
const { MemoryStore, NOW } = require('./helpers');
const ID = '1'.repeat(24);

test('every endpoint row is complete for the readers that depend on it', () => {
  assert.deepEqual(Object.keys(ENDPOINTS).sort(),
    ['author', 'faved', 'hot', 'inspiration', 'note_image', 'note_video', 'pgy_bloggers', 'pgy_fans_history', 'search', 'topic', 'user']);
  for (const [kind, spec] of Object.entries(ENDPOINTS)) {
    assert.match(spec.path, /^[a-z_]+$/, kind);
    assert.ok(Array.isArray(spec.params) && spec.params.length > 0 && typeof spec.accepts === 'function', kind);
    assert.ok(['notes', 'signals', 'profile', 'bloggers', 'fans_history'].includes(spec.yields), kind);
    // The Pugongying rows are the only ones that leave App V2 or send a body.
    assert.equal(spec.method === 'POST', kind.startsWith('pgy_'), kind);
    assert.equal(typeof spec.base === 'string', kind.startsWith('pgy_'), kind);
    if (spec.yields === 'notes') assert.ok(typeof spec.rows === 'function' && typeof spec.source === 'string', kind);
    if (spec.yields === 'signals') assert.equal(typeof spec.signalRows, 'function', kind);
    assert.equal(spec.detail === true, kind.startsWith('note_'), kind);
    assert.equal(spec.discoveryOnly === true, ['search', 'hot', 'inspiration', 'topic', 'faved'].includes(kind), kind);
  }
});

test('prototype names never resolve to an endpoint', () => {
  for (const kind of ['constructor', '__proto__', 'toString', '', undefined, 42]) assert.equal(endpoint(kind), null);
  assert.throws(() => validateParams('constructor', { note_id: ID }), /INVALID_PARAMETERS/);
  assert.throws(() => validateParams('__proto__', {}), /INVALID_PARAMETERS/);
});

test('detail kind follows the note type', () => {
  assert.equal(detailKind('video'), 'note_video');
  assert.equal(detailKind('normal'), 'note_image');
});

test('budget reads the discovery-only flag from the same table', async () => {
  const store = new MemoryStore();
  const lease = await claimLease(store, { owner: 'worker', now: NOW });
  await store.put('dfp_rounds', '20260915-0900', { status: 'running', calls: 0, microUsd: 0, definition: { kind: 'regular' } });
  const price = { source: PRICE_URL, microUsd: PRICE_MICRO_USD, verifiedAt: NOW - 1000, expiresAt: NOW + 3600000 };
  const limits = { dailyCalls: 50, dailyMicroUsd: 500000, roundCalls: 17, validationCalls: 20, validationMicroUsd: 200000 };
  const base = { roundId: '20260915-0900', attempt: 1, now: NOW, lease, limits, price };
  await assert.rejects(reserveAttempt(store, { ...base, requestKey: 'bogus:1', kind: 'constructor' }), /INVALID_REQUEST/);
  for (const [kind, spec] of Object.entries(ENDPOINTS)) {
    if (spec.discoveryOnly) {
      await assert.rejects(reserveAttempt(store, { ...base, requestKey: `${kind}:i`, kind, purpose: 'inspection' }), /INVALID_REQUEST/, kind);
      assert.equal((await reserveAttempt(store, { ...base, requestKey: `${kind}:d`, kind })).purpose, 'discovery', kind);
    } else {
      assert.equal((await reserveAttempt(store, { ...base, requestKey: `${kind}:i`, kind, purpose: 'inspection' })).purpose, 'inspection', kind);
    }
  }
});
