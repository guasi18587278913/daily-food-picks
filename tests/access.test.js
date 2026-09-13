'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./helpers');
const { authorize, accessConfig } = require('../cloudfunctions/account/lib/access');

const appId = 'wx8a2388888683b769';
const ctx = openId => ({ APPID: appId, OPENID: openId });
const base = { appId, bootstrapAdminOpenId: '', migrationFallback: false, fallbackOpenIds: [] };
const NOW = Date.parse('2026-09-13T10:00:00+08:00');

async function withUser(record, openId = 'member-1') {
  const store = new MemoryStore();
  if (record) await store.put('dfp_users', openId, record);
  return store;
}
const active = { role: 'member', status: 'active', grantedAt: '2026-09-13T00:00:00.000Z', grantedVia: 'invite', inviteCode: 'ABCDEFGHJK' };

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code);
    return true;
  });
}

test('identity must come from the invocation context, never from request parameters', async () => {
  const store = await withUser(active);
  for (const context of [null, undefined, {}, 'member-1', ['member-1'], { OPENID: 'member-1' }, { APPID: appId },
    { APPID: 'wxother', OPENID: 'member-1' }, { APPID: appId, OPENID: '' }, { APPID: appId, OPENID: 42 }]) {
    await rejects(authorize(context, base, store, { now: NOW }), 'UNAUTHENTICATED');
  }
  // A caller cannot promote itself by putting identity fields in the payload.
  await rejects(authorize({ ...ctx('stranger'), event: { OPENID: 'member-1' } }, base, store, { now: NOW }), 'NOT_REGISTERED');
});

test('authorization reads the user record and never widens on missing or illegal values', async () => {
  await rejects(authorize(ctx('member-1'), base, new MemoryStore(), { now: NOW }), 'NOT_REGISTERED');
  const granted = await authorize(ctx('member-1'), base, await withUser(active), { now: NOW });
  assert.equal(granted.openId, 'member-1');
  assert.equal(granted.role, 'member');
  assert.equal(granted.status, 'active');
  // The stored record travels with the decision so callers need no second read.
  assert.deepEqual(granted.record, active);

  for (const broken of [{}, { role: 'member' }, { status: 'active' }, { role: 'owner', status: 'active' },
    { role: 'member', status: 'pending' }, { role: 'ADMIN', status: 'active' }, { role: null, status: null },
    { role: 'member', status: 'active ' }, { role: ['admin'], status: 'active' }]) {
    await rejects(authorize(ctx('member-1'), base, await withUser(broken), { now: NOW }), 'NOT_REGISTERED');
  }
});

test('suspended accounts are rejected with their own code and keep their record', async () => {
  const store = await withUser({ ...active, status: 'suspended' });
  await rejects(authorize(ctx('member-1'), base, store, { now: NOW }), 'SUSPENDED');
  assert.equal((await store.get('dfp_users', 'member-1')).status, 'suspended');
  const admin = await withUser({ ...active, role: 'admin', status: 'suspended' }, 'admin-1');
  await rejects(authorize(ctx('admin-1'), base, admin, { now: NOW }), 'SUSPENDED');
});

test('admin records are returned with their role so callers can gate management actions', async () => {
  const store = await withUser({ ...active, role: 'admin' }, 'admin-1');
  const session = await authorize(ctx('admin-1'), base, store, { now: NOW });
  assert.equal(session.role, 'admin');
  assert.equal(session.status, 'active');
  assert.equal(session.record.grantedAt, active.grantedAt);
});

test('bootstrap config creates the first admin once and never changes an existing record', async () => {
  const config = { ...base, bootstrapAdminOpenId: 'owner' };
  const store = new MemoryStore();
  assert.equal((await authorize(ctx('owner'), config, store, { now: NOW, mayProvision: true })).role, 'admin');
  const created = await store.get('dfp_users', 'owner');
  assert.equal(created.role, 'admin');
  assert.equal(created.status, 'active');
  assert.equal(created.grantedVia, 'bootstrap');
  assert.equal(created.grantedAt, new Date(NOW).toISOString());

  // Re-entry must not rewrite the record, and a later demotion must stick.
  await store.put('dfp_users', 'owner', { ...created, role: 'member' });
  assert.equal((await authorize(ctx('owner'), config, store, { now: NOW + 1000, mayProvision: true })).role, 'member');
  assert.equal((await store.get('dfp_users', 'owner')).role, 'member');
  await store.put('dfp_users', 'owner', { ...created, status: 'suspended' });
  await rejects(authorize(ctx('owner'), config, store, { now: NOW + 2000, mayProvision: true }), 'SUSPENDED');

  // Nobody else gains anything from the setting.
  await rejects(authorize(ctx('stranger'), config, new MemoryStore(), { now: NOW, mayProvision: true }), 'NOT_REGISTERED');
});

test('concurrent first calls from the bootstrap identity produce exactly one admin record', async () => {
  const config = { ...base, bootstrapAdminOpenId: 'owner' };
  const store = new MemoryStore();
  const results = await Promise.all([
    authorize(ctx('owner'), config, store, { now: NOW, mayProvision: true }),
    authorize(ctx('owner'), config, store, { now: NOW, mayProvision: true })
  ]);
  for (const result of results) { assert.equal(result.role, 'admin'); assert.equal(result.status, 'active'); }
  assert.equal((await store.list('dfp_users', {})).length, 1);
});

test('migration fallback grants listed identities only while the window is open', async () => {
  const open = { ...base, migrationFallback: true, fallbackOpenIds: ['legacy-1', 'legacy-2'] };
  const store = new MemoryStore();
  assert.equal((await authorize(ctx('legacy-1'), open, store, { now: NOW, mayProvision: true })).role, 'member');
  // Lazy migration: the window writes a real record so the window can be closed sooner.
  const migrated = await store.get('dfp_users', 'legacy-1');
  assert.equal(migrated.grantedVia, 'migration');
  assert.equal(migrated.role, 'member');
  assert.equal(migrated.inviteCode, null);

  await rejects(authorize(ctx('outsider'), open, new MemoryStore(), { now: NOW, mayProvision: true }), 'NOT_REGISTERED');

  const closed = { ...base, migrationFallback: false, fallbackOpenIds: ['legacy-1', 'legacy-2'] };
  await rejects(authorize(ctx('legacy-2'), closed, new MemoryStore(), { now: NOW, mayProvision: true }), 'NOT_REGISTERED');
  // An identity migrated during the window keeps working after the window closes.
  assert.equal((await authorize(ctx('legacy-1'), closed, store, { now: NOW })).role, 'member');
});

test('fallback never overrides a record that an administrator already changed', async () => {
  const open = { ...base, migrationFallback: true, fallbackOpenIds: ['legacy-1'] };
  const store = await withUser({ ...active, status: 'suspended' }, 'legacy-1');
  await rejects(authorize(ctx('legacy-1'), open, store, { now: NOW, mayProvision: true }), 'SUSPENDED');
  assert.equal((await store.get('dfp_users', 'legacy-1')).status, 'suspended');
});

test('bootstrap takes precedence over fallback for the same identity', async () => {
  const config = { ...base, bootstrapAdminOpenId: 'owner', migrationFallback: true, fallbackOpenIds: ['owner'] };
  const store = new MemoryStore();
  assert.equal((await authorize(ctx('owner'), config, store, { now: NOW, mayProvision: true })).role, 'admin');
  assert.equal((await store.get('dfp_users', 'owner')).grantedVia, 'bootstrap');
});

test('the user record is read once per invocation and never cached across invocations', async () => {
  let reads = 0;
  const store = await withUser(active);
  const counted = { ...store, get: (...args) => { if (args[0] === 'dfp_users') reads++; return store.get(...args); },
    put: store.put.bind(store), create: store.create.bind(store), list: store.list.bind(store), transaction: store.transaction.bind(store) };
  await authorize(ctx('member-1'), base, counted, { now: NOW });
  assert.equal(reads, 1);
  await authorize(ctx('member-1'), base, counted, { now: NOW });
  assert.equal(reads, 2, 'a second invocation must read the record again, not reuse the previous result');
});

test('a read-only caller never creates a permission record as a side effect', async () => {
  // The catalog calls authorize on every query. A query that writes a permission record would both
  // change state from a read path and, if it were ever given the bootstrap setting, mint an administrator.
  const config = { ...base, bootstrapAdminOpenId: 'owner', migrationFallback: true, fallbackOpenIds: ['legacy-1'] };
  const store = new MemoryStore();
  const listed = await authorize(ctx('legacy-1'), config, store, { now: NOW });
  assert.equal(listed.role, 'member');
  assert.equal(await store.get('dfp_users', 'legacy-1'), null, 'a read path must not write a record');

  // The bootstrap setting grants nothing through a read-only caller: an administrator can only be
  // minted where records are actually written.
  await rejects(authorize(ctx('owner'), { ...config, fallbackOpenIds: [] }, new MemoryStore(), { now: NOW }), 'NOT_REGISTERED');

  // Once the account function has created the record, the read-only caller reads it normally.
  await authorize(ctx('legacy-1'), config, store, { now: NOW, mayProvision: true });
  assert.equal((await store.get('dfp_users', 'legacy-1')).grantedVia, 'migration');
  assert.equal((await authorize(ctx('legacy-1'), config, store, { now: NOW })).role, 'member');
});

test('deploying the migration window does not sign existing users out of the read path', async () => {
  // The regression this covers: gating the fallback on `mayProvision` refused every listed identity
  // that had no record yet, so an existing user would lose access the moment this change shipped.
  const open = { ...base, migrationFallback: true, fallbackOpenIds: ['legacy-1', 'legacy-2'] };
  for (const openId of ['legacy-1', 'legacy-2']) {
    const granted = await authorize(ctx(openId), open, new MemoryStore(), { now: NOW });
    assert.equal(granted.status, 'active');
    assert.equal(granted.role, 'member');
  }
  // Outside the list, and once the window closes, the read path refuses as before.
  await rejects(authorize(ctx('outsider'), open, new MemoryStore(), { now: NOW }), 'NOT_REGISTERED');
  const closed = { ...open, migrationFallback: false };
  await rejects(authorize(ctx('legacy-1'), closed, new MemoryStore(), { now: NOW }), 'NOT_REGISTERED');
});

test('an unexpected create failure surfaces instead of looking like a lost race', async () => {
  const config = { ...base, bootstrapAdminOpenId: 'owner' };
  const store = new MemoryStore();
  store.create = async () => { throw new Error('DATABASE_TRANSACTION_CONFLICT'); };
  await assert.rejects(authorize(ctx('owner'), config, store, { now: NOW, mayProvision: true }),
    error => { assert.equal(error.message, 'DATABASE_TRANSACTION_CONFLICT'); return true; });
});

test('configuration comes from the environment with safe defaults', () => {
  const empty = accessConfig({});
  assert.equal(empty.appId, appId);
  assert.equal(empty.bootstrapAdminOpenId, '');
  assert.equal(empty.migrationFallback, false);
  assert.deepEqual(empty.fallbackOpenIds, []);

  const configured = accessConfig({ DFP_APP_ID: 'wxtest', DFP_BOOTSTRAP_ADMIN_OPENID: ' owner ',
    DFP_MIGRATION_FALLBACK: 'true', DFP_ALLOWED_OPENIDS: ' a , b ,,c ' });
  assert.equal(configured.appId, 'wxtest');
  assert.equal(configured.bootstrapAdminOpenId, 'owner');
  assert.equal(configured.migrationFallback, true);
  assert.deepEqual(configured.fallbackOpenIds, ['a', 'b', 'c']);

  // Only the exact string enables the window; anything else leaves it closed.
  for (const value of ['false', 'TRUE', '1', 'yes', '']) {
    assert.equal(accessConfig({ DFP_MIGRATION_FALLBACK: value }).migrationFallback, false);
  }
});
