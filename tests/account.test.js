'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./helpers');
const { createAccount, ERRORS } = require('../cloudfunctions/account/lib/actions');

const appId = 'wx8a2388888683b769';
const ctx = openId => ({ APPID: appId, OPENID: openId });
const config = { appId, bootstrapAdminOpenId: '', migrationFallback: false, fallbackOpenIds: [] };
const NOW = Date.parse('2026-09-13T10:00:00+08:00');
const active = { role: 'member', status: 'active', grantedAt: '2026-09-13T00:00:00.000Z', grantedVia: 'invite',
  inviteCode: 'ABCDEFGHJK', updatedAt: '2026-09-13T00:00:00.000Z', updatedBy: 'member-1' };

async function setup(records = { 'member-1': active }, overrides = {}) {
  const store = new MemoryStore();
  for (const [openId, record] of Object.entries(records)) await store.put('dfp_users', openId, record);
  return { store, api: createAccount({ store, config: { ...config, ...overrides }, now: () => NOW }) };
}

test('every failure is reported as a mapped code with a readable message and no data', async () => {
  const { api } = await setup();
  for (const [event, context, code] of [
    [{ action: 'me' }, {}, 'UNAUTHENTICATED'],
    [{ action: 'me' }, ctx('stranger'), 'NOT_REGISTERED'],
    [{ action: 'me' }, { APPID: 'wxother', OPENID: 'member-1' }, 'UNAUTHENTICATED'],
    [{ action: 'nope' }, ctx('member-1'), 'INVALID_ARGUMENT'],
    [{}, ctx('member-1'), 'INVALID_ARGUMENT'],
    [null, ctx('member-1'), 'INVALID_ARGUMENT'],
    [{ action: 42 }, ctx('member-1'), 'INVALID_ARGUMENT']
  ]) {
    const result = await api(event, context);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(result.error.message, ERRORS[code]);
    assert.equal(result.data, undefined, 'a failure must not carry data');
  }
});

test('an unexpected internal failure is reported as BACKEND_UNAVAILABLE without leaking details', async () => {
  const store = new MemoryStore();
  store.get = async () => { throw new Error('connection string leaked here'); };
  const api = createAccount({ store, config, now: () => NOW });
  const result = await api({ action: 'me' }, ctx('member-1'));
  assert.equal(result.error.code, 'BACKEND_UNAVAILABLE');
  assert.equal(result.error.message, ERRORS.BACKEND_UNAVAILABLE);
  assert.doesNotMatch(JSON.stringify(result), /connection string/);
});

test('me reports the caller own role, status and grant time and nothing about others', async () => {
  const { api } = await setup({ 'member-1': active, 'admin-1': { ...active, role: 'admin', updatedBy: 'admin-1' } });
  const mine = await api({ action: 'me' }, ctx('member-1'));
  assert.deepEqual(mine, { ok: true, data: { role: 'member', status: 'active', grantedAt: active.grantedAt } });

  const theirs = await api({ action: 'me' }, ctx('admin-1'));
  assert.equal(theirs.data.role, 'admin');
  // The payload is exactly three fields, so no stored field reaches the client by accident.
  assert.deepEqual(Object.keys(theirs.data).sort(), ['grantedAt', 'role', 'status']);
});

test('me is the client signal for which screen to show', async () => {
  const { api } = await setup({ 'member-1': active, 'held': { ...active, status: 'suspended' } });
  assert.equal((await api({ action: 'me' }, ctx('member-1'))).data.status, 'active');
  assert.equal((await api({ action: 'me' }, ctx('held'))).error.code, 'SUSPENDED');
  assert.equal((await api({ action: 'me' }, ctx('newcomer'))).error.code, 'NOT_REGISTERED');
});

test('me bootstraps the configured first administrator and leaves everyone else untouched', async () => {
  const { api, store } = await setup({}, { bootstrapAdminOpenId: 'owner' });
  assert.equal((await api({ action: 'me' }, ctx('owner'))).data.role, 'admin');
  assert.equal((await store.get('dfp_users', 'owner')).grantedVia, 'bootstrap');
  assert.equal((await api({ action: 'me' }, ctx('someone-else'))).error.code, 'NOT_REGISTERED');
  assert.equal(await store.get('dfp_users', 'someone-else'), null);
});

test('identity fields inside the request payload are ignored', async () => {
  const { api } = await setup();
  const forged = await api({ action: 'me', OPENID: 'member-1', APPID: appId, openId: 'member-1', role: 'admin' }, ctx('stranger'));
  assert.equal(forged.error.code, 'NOT_REGISTERED');
});

test('redeem is reachable without a record and returns only the caller own role and status', async () => {
  const { api, store } = await setup({});
  await store.put('dfp_invites', 'ABCDEFGHJK', { maxUses: 2, usedCount: 0,
    expiresAt: new Date(NOW + 86400000).toISOString(), active: true,
    createdAt: new Date(NOW - 1000).toISOString(), createdBy: 'owner', note: null });

  const granted = await api({ action: 'redeem', code: ' abcde-fghjk ' }, ctx('newcomer'));
  assert.deepEqual(granted, { ok: true, data: { role: 'member', status: 'active' } });
  // The consumed code is needed for the audit trail but must not travel to the client.
  assert.equal(JSON.stringify(granted).includes('ABCDEFGHJK'), false);
  assert.equal((await store.get('dfp_users', 'newcomer')).inviteCode, 'ABCDEFGHJK');

  const logged = await store.list('dfp_access_log', { limit: 10 });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].action, 'redeem');
  assert.equal(logged[0].actor, 'newcomer');
  assert.equal(logged[0].target, 'ABCDEFGHJK');
  assert.equal(logged[0].result, 'ok');
});

test('redeem still requires a trustworthy identity and reports code problems verbatim', async () => {
  const { api, store } = await setup({});
  await store.put('dfp_invites', 'BBBBBBBBBB', { maxUses: 1, usedCount: 1,
    expiresAt: new Date(NOW + 86400000).toISOString(), active: true,
    createdAt: new Date(NOW - 1000).toISOString(), createdBy: 'owner', note: null });
  assert.equal((await api({ action: 'redeem', code: 'ABCDEFGHJK' }, {})).error.code, 'UNAUTHENTICATED');
  assert.equal((await api({ action: 'redeem', code: 'ABCDEFGHJK' }, ctx('newcomer'))).error.code, 'CODE_NOT_FOUND');
  assert.equal((await api({ action: 'redeem', code: 'BBBBBBBBBB' }, ctx('newcomer'))).error.code, 'CODE_EXHAUSTED');
  assert.equal((await api({ action: 'redeem', code: 'nope' }, ctx('newcomer'))).error.code, 'INVALID_ARGUMENT');
  assert.equal((await api({ action: 'redeem' }, ctx('newcomer'))).error.code, 'INVALID_ARGUMENT');
  assert.equal(await store.get('dfp_users', 'newcomer'), null);
});

test('an already active account is told so instead of consuming another use', async () => {
  const { api, store } = await setup();
  await store.put('dfp_invites', 'ABCDEFGHJK', { maxUses: 5, usedCount: 0,
    expiresAt: new Date(NOW + 86400000).toISOString(), active: true,
    createdAt: new Date(NOW - 1000).toISOString(), createdBy: 'owner', note: null });
  assert.equal((await api({ action: 'redeem', code: 'ABCDEFGHJK' }, ctx('member-1'))).error.code, 'ALREADY_REGISTERED');
  assert.equal((await store.get('dfp_invites', 'ABCDEFGHJK')).usedCount, 0);
});

test('a throttled redemption carries the recovery hint in its message', async () => {
  const { api } = await setup({});
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await api({ action: 'redeem', code: 'BBBBBBBBBB' }, ctx('guesser'))).error.code, 'CODE_NOT_FOUND');
  }
  const throttled = await api({ action: 'redeem', code: 'BBBBBBBBBB' }, ctx('guesser'));
  assert.equal(throttled.error.code, 'TOO_MANY_ATTEMPTS');
  assert.match(throttled.error.message, /尝试次数过多。请 \d+ 分钟后再试。/);
});

test('every mapped code has a message and no message mentions internal identifiers', () => {
  const expected = ['UNAUTHENTICATED', 'NOT_REGISTERED', 'SUSPENDED', 'FORBIDDEN', 'INVALID_ARGUMENT',
    'NOT_FOUND', 'CODE_NOT_FOUND', 'CODE_EXPIRED', 'CODE_EXHAUSTED', 'ALREADY_REGISTERED', 'TOO_MANY_ATTEMPTS',
    'LAST_ADMIN', 'LIMIT_EXCEEDED', 'BACKEND_UNAVAILABLE'];
  assert.deepEqual(Object.keys(ERRORS).sort(), [...expected].sort());
  for (const [code, message] of Object.entries(ERRORS)) {
    assert.equal(typeof message, 'string');
    assert.ok(message.length > 0, `${code} needs a message`);
    assert.doesNotMatch(message, /dfp_|openId|cloud:\/\/|undefined/, `${code} must not expose internals`);
  }
});
