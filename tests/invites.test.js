'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./helpers');
const { createInvite, normalizeCode, redeem, ATTEMPT_WINDOW_MS, ATTEMPT_LIMIT } = require('../cloudfunctions/account/lib/invites');

const NOW = Date.parse('2026-09-13T10:00:00+08:00');
const DAY = 86400000;
const CODE = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{10}$/;

function invite(overrides = {}) {
  return { maxUses: 1, usedCount: 0, expiresAt: new Date(NOW + 7 * DAY).toISOString(), active: true,
    createdAt: new Date(NOW - DAY).toISOString(), createdBy: 'owner', note: null, ...overrides };
}
async function withInvite(code = 'ABCDEFGHJK', overrides = {}) {
  const store = new MemoryStore();
  await store.put('dfp_invites', code, invite(overrides));
  return store;
}
function refuses(promise, code) {
  return assert.rejects(promise, error => { assert.equal(error.code, code); return true; });
}

test('generated codes use the unambiguous alphabet and do not repeat', async () => {
  const store = new MemoryStore();
  const seen = new Set();
  for (let n = 0; n < 40; n++) {
    const created = await createInvite(store, { maxUses: 5, expiresInDays: 30, createdBy: 'owner', at: NOW });
    assert.match(created.code, CODE);
    // I, L, O, U, 0 and 1 are excluded so a code can be read aloud without confusion.
    assert.doesNotMatch(created.code, /[ILOU01]/);
    assert.equal(seen.has(created.code), false, 'a generated code must not collide with an earlier one');
    seen.add(created.code);
    assert.equal(created.maxUses, 5);
    assert.equal(created.expiresAt, new Date(NOW + 30 * DAY).toISOString());
  }
  assert.equal((await store.list('dfp_invites', { limit: 100 })).length, 40);
});

test('a generated code that already exists is retried instead of overwriting the stored one', async () => {
  const store = await withInvite('AAAAAAAAAA', { maxUses: 9, note: 'already here' });
  const sequence = ['AAAAAAAAAA', 'AAAAAAAAAA', 'BBBBBBBBBB'];
  let index = 0;
  const created = await createInvite(store, { maxUses: 1, expiresInDays: 1, createdBy: 'owner', at: NOW,
    generate: () => sequence[index++] });
  assert.equal(created.code, 'BBBBBBBBBB');
  const untouched = await store.get('dfp_invites', 'AAAAAAAAAA');
  assert.equal(untouched.maxUses, 9);
  assert.equal(untouched.note, 'already here');
});

test('invite creation records its origin and rejects values outside the data model', async () => {
  const store = new MemoryStore();
  const created = await createInvite(store, { maxUses: 10, expiresInDays: 14, note: '给大芙', createdBy: 'owner', at: NOW });
  const stored = await store.get('dfp_invites', created.code);
  assert.deepEqual(stored, { maxUses: 10, usedCount: 0, expiresAt: new Date(NOW + 14 * DAY).toISOString(),
    active: true, createdAt: new Date(NOW).toISOString(), createdBy: 'owner', note: '给大芙' });

  for (const input of [{ maxUses: 0 }, { maxUses: 101 }, { maxUses: 1.5 }, { maxUses: '5' }, { maxUses: -1 },
    { expiresInDays: 0 }, { expiresInDays: 366 }, { expiresInDays: 1.5 }, { expiresInDays: '7' },
    { note: 'x'.repeat(51) }, { note: 42 }]) {
    await refuses(createInvite(store, { maxUses: 5, expiresInDays: 7, createdBy: 'owner', at: NOW, ...input }), 'INVALID_ARGUMENT');
  }
});

test('code input is normalized before lookup, and illegal shapes never reach the database', async () => {
  assert.equal(normalizeCode(' abcdefghjk '), 'ABCDEFGHJK');
  assert.equal(normalizeCode('ABCDE-FGHJK'), 'ABCDEFGHJK');
  assert.equal(normalizeCode('abcde fghjk'), 'ABCDEFGHJK');
  for (const bad of ['', 'ABCDEFGHJ', 'ABCDEFGHJKL', 'ABCDEFGHI0', 'ABCDEFGHJ!', null, undefined, 42, ['ABCDEFGHJK'], 'ABCDEFGHJI']) {
    assert.equal(normalizeCode(bad), null);
  }

  let reads = 0;
  const store = await withInvite();
  const counted = { ...store, get: (...args) => { reads++; return store.get(...args); },
    put: store.put.bind(store), create: store.create.bind(store), remove: store.remove.bind(store),
    list: store.list.bind(store), transaction: store.transaction.bind(store) };
  await refuses(redeem(counted, { openId: 'newcomer', code: 'not-a-code', at: NOW }), 'INVALID_ARGUMENT');
  assert.equal(reads, 0, 'a malformed code must be refused without any read');
});

test('a valid code grants membership and records which code was consumed', async () => {
  const store = await withInvite('ABCDEFGHJK', { maxUses: 3 });
  const granted = await redeem(store, { openId: 'newcomer', code: ' abcde-fghjk ', at: NOW });
  assert.deepEqual(granted, { role: 'member', status: 'active', code: 'ABCDEFGHJK' });

  const user = await store.get('dfp_users', 'newcomer');
  assert.equal(user.role, 'member');
  assert.equal(user.status, 'active');
  assert.equal(user.grantedVia, 'invite');
  assert.equal(user.inviteCode, 'ABCDEFGHJK');
  assert.equal(user.grantedAt, new Date(NOW).toISOString());
  assert.equal((await store.get('dfp_invites', 'ABCDEFGHJK')).usedCount, 1);
});

test('an unusable code is refused with a code the client can act on', async () => {
  const missing = new MemoryStore();
  await refuses(redeem(missing, { openId: 'a', code: 'ABCDEFGHJK', at: NOW }), 'CODE_NOT_FOUND');
  // A revoked code is indistinguishable from one that never existed, so revocation leaks nothing.
  await refuses(redeem(await withInvite('ABCDEFGHJK', { active: false }), { openId: 'a', code: 'ABCDEFGHJK', at: NOW }), 'CODE_NOT_FOUND');
  await refuses(redeem(await withInvite('ABCDEFGHJK', { expiresAt: new Date(NOW - 1).toISOString() }),
    { openId: 'a', code: 'ABCDEFGHJK', at: NOW }), 'CODE_EXPIRED');
  await refuses(redeem(await withInvite('ABCDEFGHJK', { maxUses: 2, usedCount: 2 }),
    { openId: 'a', code: 'ABCDEFGHJK', at: NOW }), 'CODE_EXHAUSTED');

  for (const store of [await withInvite('ABCDEFGHJK', { active: false }),
    await withInvite('ABCDEFGHJK', { expiresAt: new Date(NOW - 1).toISOString() }),
    await withInvite('ABCDEFGHJK', { maxUses: 2, usedCount: 2 })]) {
    assert.equal(await store.get('dfp_users', 'a'), null, 'a refused redemption must not create a user record');
  }
});

test('redeeming twice neither duplicates the record nor spends another use', async () => {
  const store = await withInvite('ABCDEFGHJK', { maxUses: 3 });
  await redeem(store, { openId: 'newcomer', code: 'ABCDEFGHJK', at: NOW });
  await refuses(redeem(store, { openId: 'newcomer', code: 'ABCDEFGHJK', at: NOW + 1000 }), 'ALREADY_REGISTERED');
  assert.equal((await store.get('dfp_invites', 'ABCDEFGHJK')).usedCount, 1);
  assert.equal((await store.list('dfp_users', { limit: 100 })).length, 1);
  assert.equal((await store.get('dfp_users', 'newcomer')).grantedAt, new Date(NOW).toISOString());

  // A different code also cannot re-grant an account that already exists.
  await store.put('dfp_invites', 'BBBBBBBBBB', invite({ maxUses: 5 }));
  await refuses(redeem(store, { openId: 'newcomer', code: 'BBBBBBBBBB', at: NOW + 2000 }), 'ALREADY_REGISTERED');
  assert.equal((await store.get('dfp_invites', 'BBBBBBBBBB')).usedCount, 0);
});

test('a suspended account cannot bring itself back with an invite code', async () => {
  const store = await withInvite('ABCDEFGHJK', { maxUses: 3 });
  await store.put('dfp_users', 'held', { role: 'member', status: 'suspended', grantedAt: new Date(NOW - DAY).toISOString(),
    grantedVia: 'invite', inviteCode: 'OLDCODEXXX', updatedAt: new Date(NOW - DAY).toISOString(), updatedBy: 'owner' });
  await refuses(redeem(store, { openId: 'held', code: 'ABCDEFGHJK', at: NOW }), 'SUSPENDED');
  assert.equal((await store.get('dfp_invites', 'ABCDEFGHJK')).usedCount, 0, 'a suspended account must not spend a use');
  assert.equal((await store.get('dfp_users', 'held')).status, 'suspended');
});

test('concurrent redemptions of a single-use code admit exactly one account', async () => {
  const store = await withInvite('ABCDEFGHJK', { maxUses: 1 });
  const results = await Promise.allSettled([
    redeem(store, { openId: 'first', code: 'ABCDEFGHJK', at: NOW }),
    redeem(store, { openId: 'second', code: 'ABCDEFGHJK', at: NOW })
  ]);
  const granted = results.filter(r => r.status === 'fulfilled');
  const refused = results.filter(r => r.status === 'rejected');
  assert.equal(granted.length, 1);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reason.code, 'CODE_EXHAUSTED');

  const stored = await store.get('dfp_invites', 'ABCDEFGHJK');
  assert.equal(stored.usedCount, 1, 'usedCount must never exceed maxUses');
  assert.ok(stored.usedCount >= 0);
  assert.equal((await store.list('dfp_users', { limit: 100 })).length, 1);
});

test('concurrent redemptions never oversell a multi-use code', async () => {
  const store = await withInvite('ABCDEFGHJK', { maxUses: 3 });
  const results = await Promise.allSettled(['a', 'b', 'c', 'd', 'e']
    .map(openId => redeem(store, { openId, code: 'ABCDEFGHJK', at: NOW })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
  for (const failure of results.filter(r => r.status === 'rejected')) assert.equal(failure.reason.code, 'CODE_EXHAUSTED');
  assert.equal((await store.get('dfp_invites', 'ABCDEFGHJK')).usedCount, 3);
  assert.equal((await store.list('dfp_users', { limit: 100 })).length, 3);
});

test('repeated wrong codes are throttled with a recovery hint, and the window resets', async () => {
  const store = await withInvite('ABCDEFGHJK');
  for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt++) {
    await refuses(redeem(store, { openId: 'guesser', code: 'BBBBBBBBBB', at: NOW }), 'CODE_NOT_FOUND');
  }
  await assert.rejects(redeem(store, { openId: 'guesser', code: 'BBBBBBBBBB', at: NOW }), error => {
    assert.equal(error.code, 'TOO_MANY_ATTEMPTS');
    assert.match(error.hint, /分钟/, 'the refusal must tell the user when they can try again');
    return true;
  });
  // Throttling must not let a guesser past it even with a code that is actually valid.
  await refuses(redeem(store, { openId: 'guesser', code: 'ABCDEFGHJK', at: NOW }), 'TOO_MANY_ATTEMPTS');
  assert.equal(await store.get('dfp_users', 'guesser'), null);

  // After the window passes the counter starts over rather than accumulating.
  assert.deepEqual(await redeem(store, { openId: 'guesser', code: 'ABCDEFGHJK', at: NOW + ATTEMPT_WINDOW_MS + 1 }),
    { role: 'member', status: 'active', code: 'ABCDEFGHJK' });
});

test('throttling reads no invite document and a success clears the counter', async () => {
  const store = await withInvite('ABCDEFGHJK', { maxUses: 5 });
  for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt++) {
    await refuses(redeem(store, { openId: 'guesser', code: 'BBBBBBBBBB', at: NOW }), 'CODE_NOT_FOUND');
  }
  const reads = [];
  const counted = { ...store, get: (collection, key) => { reads.push(collection); return store.get(collection, key); },
    put: store.put.bind(store), create: store.create.bind(store), remove: store.remove.bind(store),
    list: store.list.bind(store), transaction: store.transaction.bind(store) };
  await refuses(redeem(counted, { openId: 'guesser', code: 'ABCDEFGHJK', at: NOW }), 'TOO_MANY_ATTEMPTS');
  assert.equal(reads.includes('dfp_invites'), false, 'a throttled attempt must not probe the invite collection');

  await redeem(store, { openId: 'fresh', code: 'ABCDEFGHJK', at: NOW });
  assert.equal(await store.get('dfp_redeem_attempts', 'fresh'), null, 'a successful redemption clears its counter');
});

test('a code with a damaged limit is refused rather than treated as unlimited', async () => {
  for (const broken of [{ maxUses: undefined }, { maxUses: null }, { maxUses: 0 }, { maxUses: '5' },
    { maxUses: 1.5 }, { maxUses: 101 }, { usedCount: undefined }, { usedCount: -1 }, { usedCount: '0' }]) {
    const store = await withInvite('ABCDEFGHJK', broken);
    await refuses(redeem(store, { openId: 'a', code: 'ABCDEFGHJK', at: NOW }), 'CODE_EXHAUSTED');
    assert.equal(await store.get('dfp_users', 'a'), null);
  }
});

test('a failed cleanup after a committed grant does not report failure', async () => {
  const store = await withInvite('ABCDEFGHJK', { maxUses: 2 });
  // Ten wrong guesses first, so there is a counter document to fail on.
  for (let attempt = 0; attempt < 3; attempt++) {
    await refuses(redeem(store, { openId: 'newcomer', code: 'BBBBBBBBBB', at: NOW }), 'CODE_NOT_FOUND');
  }
  const brittle = { ...store, get: store.get.bind(store), put: store.put.bind(store),
    create: store.create.bind(store), list: store.list.bind(store), transaction: store.transaction.bind(store),
    remove: async () => { throw new Error('storage unavailable'); } };
  const granted = await redeem(brittle, { openId: 'newcomer', code: 'ABCDEFGHJK', at: NOW });
  assert.deepEqual(granted, { role: 'member', status: 'active', code: 'ABCDEFGHJK' });
  assert.equal((await store.get('dfp_users', 'newcomer')).status, 'active', 'the grant really committed');
});

test('a storage failure during code generation surfaces instead of burning retries', async () => {
  const store = new MemoryStore();
  let attempts = 0;
  const failing = { ...store, get: store.get.bind(store), put: store.put.bind(store), list: store.list.bind(store),
    remove: store.remove.bind(store), transaction: store.transaction.bind(store),
    create: async () => { attempts++; throw new Error('storage unavailable'); } };
  await assert.rejects(createInvite(failing, { maxUses: 1, expiresInDays: 1, createdBy: 'owner', at: NOW }),
    error => { assert.equal(error.message, 'storage unavailable'); return true; });
  assert.equal(attempts, 1, 'a real failure stops immediately rather than drawing five codes');
});

test('a known account is not throttled by its own repeated submissions', async () => {
  const store = await withInvite('ABCDEFGHJK', { maxUses: 5 });
  await redeem(store, { openId: 'newcomer', code: 'ABCDEFGHJK', at: NOW });
  for (let attempt = 0; attempt < ATTEMPT_LIMIT + 3; attempt++) {
    await refuses(redeem(store, { openId: 'newcomer', code: 'ABCDEFGHJK', at: NOW }), 'ALREADY_REGISTERED');
  }
  assert.equal(await store.get('dfp_redeem_attempts', 'newcomer'), null,
    'an already-registered account is not a guesser, so nothing is counted against it');
});
