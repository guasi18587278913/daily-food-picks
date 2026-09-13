'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./helpers');
const { createAccount } = require('../cloudfunctions/account/lib/actions');

const appId = 'wx8a2388888683b769';
const ctx = openId => ({ APPID: appId, OPENID: openId });
const config = { appId, bootstrapAdminOpenId: '', migrationFallback: false, fallbackOpenIds: [] };
const NOW = Date.parse('2026-09-13T10:00:00+08:00');
const DAY = 86400000;

function user(role = 'member', status = 'active', overrides = {}) {
  return { role, status, grantedAt: '2026-09-12T00:00:00.000Z', grantedVia: 'invite', inviteCode: 'ABCDEFGHJK',
    updatedAt: '2026-09-12T00:00:00.000Z', updatedBy: 'owner', ...overrides };
}
async function setup(records = { owner: user('admin'), 'member-1': user() }, overrides = {}) {
  const store = new MemoryStore();
  for (const [openId, record] of Object.entries(records)) await store.put('dfp_users', openId, record);
  return { store, api: createAccount({ store, config: { ...config, ...overrides }, now: () => NOW }) };
}
const ADMIN_ACTIONS = ['admin.listUsers', 'admin.setUserStatus', 'admin.setUserRole',
  'admin.createInvite', 'admin.listInvites', 'admin.revokeInvite', 'admin.migrateWhitelist'];

test('management is refused to everyone who is not an active administrator', async () => {
  const { api, store } = await setup({ owner: user('admin'), 'member-1': user(), held: user('admin', 'suspended') });
  for (const action of ADMIN_ACTIONS) {
    const payload = { action, openId: 'member-1', status: 'suspended', role: 'admin',
      maxUses: 1, expiresInDays: 1, code: 'ABCDEFGHJK' };
    assert.equal((await api(payload, ctx('member-1'))).error.code, 'FORBIDDEN', `${action} must refuse a member`);
    assert.equal((await api(payload, ctx('stranger'))).error.code, 'NOT_REGISTERED');
    assert.equal((await api(payload, ctx('held'))).error.code, 'SUSPENDED', `${action} must refuse a suspended admin`);
    assert.equal((await api(payload, {})).error.code, 'UNAUTHENTICATED');
  }
  // Nothing was changed by any of the refused calls.
  assert.equal((await store.get('dfp_users', 'member-1')).status, 'active');
  assert.equal((await store.list('dfp_invites', { limit: 10 })).length, 0);
});

test('a refused management call leaks no user list, invite code or other account', async () => {
  const { api, store } = await setup();
  await store.put('dfp_invites', 'SECRETCODE', { maxUses: 5, usedCount: 0, expiresAt: new Date(NOW + DAY).toISOString(),
    active: true, createdAt: new Date(NOW - DAY).toISOString(), createdBy: 'owner', note: '内部' });
  for (const action of ADMIN_ACTIONS) {
    const body = JSON.stringify(await api({ action, openId: 'owner', code: 'SECRETCODE' }, ctx('member-1')));
    for (const leak of ['SECRETCODE', 'owner', 'member-1', '内部', 'grantedAt']) {
      assert.equal(body.includes(leak), false, `${action} leaked ${leak}`);
    }
  }
});

test('the user list is paged and carries only fields the system itself records', async () => {
  const records = { owner: user('admin') };
  for (let n = 1; n <= 5; n++) records[`user-${n}`] = user();
  const { api } = await setup(records);

  const first = await api({ action: 'admin.listUsers', limit: 3 }, ctx('owner'));
  assert.equal(first.ok, true);
  assert.equal(first.data.users.length, 3);
  assert.ok(first.data.nextCursor);
  assert.deepEqual(Object.keys(first.data.users[0]).sort(),
    ['grantedAt', 'grantedVia', 'inviteCode', 'openId', 'role', 'status']);

  const second = await api({ action: 'admin.listUsers', limit: 3, cursor: first.data.nextCursor }, ctx('owner'));
  assert.equal(second.data.users.length, 3);
  assert.equal(second.data.nextCursor, null);
  const ids = [...first.data.users, ...second.data.users].map(u => u.openId);
  assert.equal(new Set(ids).size, 6, 'paging must not repeat or drop an account');

  for (const limit of [0, 51, 1.5, '10']) {
    assert.equal((await api({ action: 'admin.listUsers', limit }, ctx('owner'))).error.code, 'INVALID_ARGUMENT');
  }
  for (const cursor of ['../other', 'a'.repeat(200), 42, {}]) {
    assert.equal((await api({ action: 'admin.listUsers', cursor }, ctx('owner'))).error.code, 'INVALID_ARGUMENT');
  }
});

test('suspending a member blocks reading but keeps its favourites', async () => {
  const { api, store } = await setup();
  await store.put('dfp_favorites', 'member-1', { items: { ['a'.repeat(24)]: NOW }, updatedAt: new Date(NOW).toISOString(), mergedAt: null });

  const suspended = await api({ action: 'admin.setUserStatus', openId: 'member-1', status: 'suspended' }, ctx('owner'));
  assert.deepEqual(suspended, { ok: true, data: { openId: 'member-1', status: 'suspended' } });
  assert.equal((await api({ action: 'me' }, ctx('member-1'))).error.code, 'SUSPENDED');
  assert.deepEqual((await store.get('dfp_favorites', 'member-1')).items, { ['a'.repeat(24)]: NOW });
  const record = await store.get('dfp_users', 'member-1');
  assert.equal(record.updatedBy, 'owner');
  assert.equal(record.updatedAt, new Date(NOW).toISOString());
  assert.equal(record.grantedAt, '2026-09-12T00:00:00.000Z', 'how access was granted does not change');

  await api({ action: 'admin.setUserStatus', openId: 'member-1', status: 'active' }, ctx('owner'));
  assert.equal((await api({ action: 'me' }, ctx('member-1'))).data.status, 'active');
  assert.deepEqual((await store.get('dfp_favorites', 'member-1')).items, { ['a'.repeat(24)]: NOW });
});

test('the last usable administrator cannot be suspended or demoted, including by itself', async () => {
  const { api, store } = await setup();
  assert.equal((await api({ action: 'admin.setUserStatus', openId: 'owner', status: 'suspended' }, ctx('owner'))).error.code, 'LAST_ADMIN');
  assert.equal((await api({ action: 'admin.setUserRole', openId: 'owner', role: 'member' }, ctx('owner'))).error.code, 'LAST_ADMIN');
  assert.equal((await store.get('dfp_users', 'owner')).role, 'admin');
  assert.equal((await store.get('dfp_users', 'owner')).status, 'active');

  // A suspended admin does not count as usable, so it cannot be the one that makes a demotion safe.
  await store.put('dfp_users', 'second', user('admin', 'suspended'));
  assert.equal((await api({ action: 'admin.setUserRole', openId: 'owner', role: 'member' }, ctx('owner'))).error.code, 'LAST_ADMIN');

  await api({ action: 'admin.setUserStatus', openId: 'second', status: 'active' }, ctx('owner'));
  assert.equal((await api({ action: 'admin.setUserRole', openId: 'owner', role: 'member' }, ctx('owner'))).data.role, 'member');
  // Now 'second' is alone and protected in turn.
  assert.equal((await api({ action: 'admin.setUserStatus', openId: 'second', status: 'suspended' }, ctx('second'))).error.code, 'LAST_ADMIN');
});

test('two administrators demoting themselves at the same time cannot empty the system', async () => {
  // Without a transaction both checks read "2 active admins" and both writes land, leaving zero.
  // Recovery would need a console edit: bootstrap only creates a record when none exists.
  const { api, store } = await setup({ owner: user('admin'), second: user('admin') });
  const results = await Promise.allSettled([
    api({ action: 'admin.setUserRole', openId: 'owner', role: 'member' }, ctx('owner')),
    api({ action: 'admin.setUserRole', openId: 'second', role: 'member' }, ctx('second'))
  ]);
  const refused = results.filter(r => r.value && r.value.ok === false);
  assert.equal(refused.length, 1, 'exactly one of the two must be refused');
  assert.equal(refused[0].value.error.code, 'LAST_ADMIN');

  const admins = await store.list('dfp_users', { limit: 10, filters: { role: 'admin', status: 'active' } });
  assert.equal(admins.length, 1, 'one usable administrator always remains');
});

test('concurrent changes to the same account do not overwrite each other', async () => {
  // A suspension and a promotion arriving together must not leave the suspension silently undone.
  const { api, store } = await setup({ owner: user('admin'), second: user('admin'), 'member-1': user() });
  await Promise.all([
    api({ action: 'admin.setUserStatus', openId: 'member-1', status: 'suspended' }, ctx('owner')),
    api({ action: 'admin.setUserRole', openId: 'member-1', role: 'admin' }, ctx('second'))
  ]);
  const record = await store.get('dfp_users', 'member-1');
  assert.equal(record.status, 'suspended', 'the suspension must survive the concurrent role change');
  assert.equal(record.role, 'admin');
});

test('a migration list longer than the cap is refused rather than half applied', async () => {
  const many = Array.from({ length: 201 }, (_, n) => `legacy-${n}`);
  const { api, store } = await setup({ owner: user('admin') }, { fallbackOpenIds: many });
  assert.equal((await api({ action: 'admin.migrateWhitelist' }, ctx('owner'))).error.code, 'INVALID_ARGUMENT');
  assert.equal((await store.list('dfp_users', { limit: 100 })).length, 1, 'nothing was created');
});

test('role and status changes reject values and targets outside the model', async () => {
  const { api } = await setup();
  for (const payload of [{ openId: 'member-1', status: 'deleted' }, { openId: 'member-1', status: '' },
    { openId: 'member-1' }, { openId: 'nobody', status: 'suspended' }, { openId: '../x', status: 'suspended' },
    { openId: 42, status: 'suspended' }]) {
    const result = await api({ action: 'admin.setUserStatus', ...payload }, ctx('owner'));
    assert.equal(result.ok, false);
    assert.ok(['INVALID_ARGUMENT', 'NOT_FOUND'].includes(result.error.code), `unexpected ${result.error.code}`);
  }
  for (const role of ['owner', 'ADMIN', '', null]) {
    assert.equal((await api({ action: 'admin.setUserRole', openId: 'member-1', role }, ctx('owner'))).error.code, 'INVALID_ARGUMENT');
  }
});

test('an administrator can create, list and revoke invite codes', async () => {
  const { api, store } = await setup();
  const created = await api({ action: 'admin.createInvite', maxUses: 3, expiresInDays: 7, note: '给大芙' }, ctx('owner'));
  assert.match(created.data.code, /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{10}$/);
  assert.equal(created.data.maxUses, 3);
  assert.equal(created.data.expiresAt, new Date(NOW + 7 * DAY).toISOString());
  assert.equal((await store.get('dfp_invites', created.data.code)).createdBy, 'owner');

  const listed = await api({ action: 'admin.listInvites', limit: 10 }, ctx('owner'));
  assert.equal(listed.data.invites.length, 1);
  assert.deepEqual(Object.keys(listed.data.invites[0]).sort(),
    ['active', 'code', 'createdAt', 'expiresAt', 'maxUses', 'note', 'usedCount']);

  // A member redeems it, then the code is revoked: the grant already made stands.
  assert.equal((await api({ action: 'redeem', code: created.data.code }, ctx('newcomer'))).ok, true);
  const revoked = await api({ action: 'admin.revokeInvite', code: created.data.code }, ctx('owner'));
  assert.deepEqual(revoked, { ok: true, data: { code: created.data.code, active: false } });
  assert.equal((await api({ action: 'redeem', code: created.data.code }, ctx('another'))).error.code, 'CODE_NOT_FOUND');
  assert.equal((await api({ action: 'me' }, ctx('newcomer'))).data.status, 'active');

  assert.equal((await api({ action: 'admin.revokeInvite', code: 'BBBBBBBBBB' }, ctx('owner'))).error.code, 'CODE_NOT_FOUND');
  assert.equal((await api({ action: 'admin.revokeInvite', code: 'nope' }, ctx('owner'))).error.code, 'INVALID_ARGUMENT');
});

test('invite creation bounds are enforced at the action layer', async () => {
  const { api } = await setup();
  for (const payload of [{ maxUses: 0, expiresInDays: 7 }, { maxUses: 101, expiresInDays: 7 },
    { maxUses: 5, expiresInDays: 0 }, { maxUses: 5, expiresInDays: 366 }, { maxUses: 5, expiresInDays: 7, note: 'x'.repeat(51) },
    { expiresInDays: 7 }, { maxUses: 5 }]) {
    assert.equal((await api({ action: 'admin.createInvite', ...payload }, ctx('owner'))).error.code, 'INVALID_ARGUMENT');
  }
});

test('every successful management action leaves one audit entry', async () => {
  const { api, store } = await setup({ owner: user('admin'), second: user('admin'), 'member-1': user() });
  const created = await api({ action: 'admin.createInvite', maxUses: 1, expiresInDays: 1 }, ctx('owner'));
  await api({ action: 'admin.setUserStatus', openId: 'member-1', status: 'suspended' }, ctx('owner'));
  await api({ action: 'admin.setUserStatus', openId: 'member-1', status: 'active' }, ctx('owner'));
  await api({ action: 'admin.setUserRole', openId: 'member-1', role: 'admin' }, ctx('owner'));
  await api({ action: 'admin.revokeInvite', code: created.data.code }, ctx('owner'));

  const log = await store.list('dfp_access_log', { limit: 50 });
  assert.deepEqual(log.map(entry => entry.action).sort(),
    ['createInvite', 'restore', 'revokeInvite', 'setRole', 'suspend']);
  for (const entry of log) {
    assert.equal(entry.actor, 'owner');
    assert.equal(entry.result, 'ok');
    assert.equal(typeof entry.at, 'string');
    assert.ok(entry.target, 'every entry names what it acted on');
  }
});

test('a refused management action writes no audit entry', async () => {
  const { api, store } = await setup();
  await api({ action: 'admin.setUserStatus', openId: 'owner', status: 'suspended' }, ctx('owner'));
  await api({ action: 'admin.setUserStatus', openId: 'member-1', status: 'suspended' }, ctx('member-1'));
  assert.deepEqual(await store.list('dfp_access_log', { limit: 10 }), []);
});

test('migration creates records for listed identities and reports what it did', async () => {
  const { api, store } = await setup({ owner: user('admin') }, { fallbackOpenIds: ['legacy-1', 'legacy-2', 'legacy-3'] });
  const result = await api({ action: 'admin.migrateWhitelist' }, ctx('owner'));
  assert.deepEqual(result, { ok: true, data: { created: 3, skipped: 0, total: 3 } });
  for (const openId of ['legacy-1', 'legacy-2', 'legacy-3']) {
    const record = await store.get('dfp_users', openId);
    assert.equal(record.role, 'member');
    assert.equal(record.status, 'active');
    assert.equal(record.grantedVia, 'migration');
    assert.equal(record.inviteCode, null);
  }
  const log = await store.list('dfp_access_log', { limit: 10 });
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'migrate');
});

test('migration is repeatable and never overwrites a record an administrator changed', async () => {
  const { api, store } = await setup({ owner: user('admin') }, { fallbackOpenIds: ['legacy-1', 'legacy-2', 'legacy-3'] });
  await api({ action: 'admin.migrateWhitelist' }, ctx('owner'));

  await api({ action: 'admin.setUserRole', openId: 'legacy-1', role: 'admin' }, ctx('owner'));
  await api({ action: 'admin.setUserStatus', openId: 'legacy-2', status: 'suspended' }, ctx('owner'));

  const again = await api({ action: 'admin.migrateWhitelist' }, ctx('owner'));
  assert.deepEqual(again, { ok: true, data: { created: 0, skipped: 3, total: 3 } });
  assert.equal((await store.get('dfp_users', 'legacy-1')).role, 'admin', 'a promotion survives a re-run');
  assert.equal((await store.get('dfp_users', 'legacy-2')).status, 'suspended', 'a suspension survives a re-run');
});

test('migration with an empty list is a no-op rather than an error', async () => {
  const { api } = await setup({ owner: user('admin') });
  assert.deepEqual(await api({ action: 'admin.migrateWhitelist' }, ctx('owner')),
    { ok: true, data: { created: 0, skipped: 0, total: 0 } });
});
