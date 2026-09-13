'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./helpers');
const { createAccount } = require('../cloudfunctions/account/lib/actions');
const { FAVORITE_LIMIT } = require('../cloudfunctions/account/lib/favorites');

const appId = 'wx8a2388888683b769';
const ctx = openId => ({ APPID: appId, OPENID: openId });
const config = { appId, bootstrapAdminOpenId: '', migrationFallback: false, fallbackOpenIds: [] };
const NOW = Date.parse('2026-09-13T10:00:00+08:00');
const note = n => String(n).padStart(24, '0');
const hex = n => n.toString(16).padStart(24, '0');

function user(status = 'active') {
  return { role: 'member', status, grantedAt: '2026-09-12T00:00:00.000Z', grantedVia: 'invite',
    inviteCode: 'ABCDEFGHJK', updatedAt: '2026-09-12T00:00:00.000Z', updatedBy: 'owner' };
}
async function setup(records = { 'a': user(), 'b': user() }) {
  const store = new MemoryStore();
  for (const [openId, record] of Object.entries(records)) await store.put('dfp_users', openId, record);
  return { store, api: createAccount({ store, config, now: () => NOW }) };
}

test('favourites start empty and toggle on and off with a real count', async () => {
  const { api } = await setup();
  assert.deepEqual(await api({ action: 'favorites.list' }, ctx('a')), { ok: true, data: { items: {}, mergedAt: null } });

  const added = await api({ action: 'favorites.toggle', noteId: note(1) }, ctx('a'));
  assert.deepEqual(added, { ok: true, data: { selected: true, count: 1 } });
  assert.deepEqual((await api({ action: 'favorites.list' }, ctx('a'))).data.items, { [note(1)]: NOW });

  const again = await api({ action: 'favorites.toggle', noteId: note(1) }, ctx('a'));
  assert.deepEqual(again, { ok: true, data: { selected: false, count: 0 } });
  assert.deepEqual((await api({ action: 'favorites.list' }, ctx('a'))).data.items, {});
});

test('favourites survive a device change because they are keyed by identity', async () => {
  const { api, store } = await setup();
  await api({ action: 'favorites.toggle', noteId: note(1) }, ctx('a'));
  // A fresh client with no local storage reads the same set back.
  const reopened = createAccount({ store, config, now: () => NOW + 86400000 });
  assert.deepEqual((await reopened({ action: 'favorites.list' }, ctx('a'))).data.items, { [note(1)]: NOW });
});

test('one account cannot read or write another account favourites', async () => {
  const { api, store } = await setup();
  await api({ action: 'favorites.toggle', noteId: note(1) }, ctx('a'));
  assert.deepEqual((await api({ action: 'favorites.list' }, ctx('b'))).data.items, {});

  // Identity fields in the payload are ignored: the write lands on the caller's own document.
  await api({ action: 'favorites.toggle', noteId: note(2), openId: 'a', OPENID: 'a' }, ctx('b'));
  assert.deepEqual(Object.keys((await store.get('dfp_favorites', 'a')).items), [note(1)]);
  assert.deepEqual(Object.keys((await store.get('dfp_favorites', 'b')).items), [note(2)]);
});

test('only a well-formed note id is accepted', async () => {
  const { api, store } = await setup();
  for (const noteId of [undefined, null, '', 'xyz', 'ABCDEF000000000000000000', `${note(1)}0`, note(1).slice(1),
    '../other', 42, [note(1)], 'abcdefg00000000000000000']) {
    assert.equal((await api({ action: 'favorites.toggle', noteId }, ctx('a'))).error.code, 'INVALID_ARGUMENT');
  }
  assert.equal(await store.get('dfp_favorites', 'a'), null);
});

test('a local set is merged into the cloud as a union, keeping the earlier timestamp', async () => {
  const { api } = await setup();
  await api({ action: 'favorites.toggle', noteId: note(1) }, ctx('a'));

  const merged = await api({ action: 'favorites.merge',
    items: { [note(1)]: NOW - 5000, [note(2)]: NOW - 1000 } }, ctx('a'));
  assert.equal(merged.ok, true);
  assert.equal(merged.data.count, 2);
  assert.equal(merged.data.mergedAt, new Date(NOW).toISOString());
  // The local entry is older, so it wins; nothing is dropped from either side.
  assert.deepEqual(merged.data.items, { [note(1)]: NOW - 5000, [note(2)]: NOW - 1000 });

  const later = await api({ action: 'favorites.merge', items: { [note(1)]: NOW + 9000 } }, ctx('a'));
  assert.equal(later.data.items[note(1)], NOW - 5000, 'a newer local timestamp does not overwrite an earlier one');
});

test('merging is repeatable and an empty side never clears the other', async () => {
  const { api } = await setup();
  await api({ action: 'favorites.merge', items: { [note(1)]: NOW, [note(2)]: NOW } }, ctx('a'));
  const again = await api({ action: 'favorites.merge', items: { [note(1)]: NOW, [note(2)]: NOW } }, ctx('a'));
  assert.equal(again.data.count, 2);

  const empty = await api({ action: 'favorites.merge', items: {} }, ctx('a'));
  assert.equal(empty.data.count, 2, 'an empty local set must not wipe the cloud set');
  assert.deepEqual(Object.keys(empty.data.items).sort(), [note(1), note(2)].sort());
});

test('a malformed merge payload is refused without touching stored favourites', async () => {
  const { api, store } = await setup();
  await api({ action: 'favorites.toggle', noteId: note(1) }, ctx('a'));
  for (const items of [undefined, null, 'x', 42, [note(1)], { bad: NOW }, { [note(2)]: 0 }, { [note(2)]: -1 },
    { [note(2)]: 1.5 }, { [note(2)]: '123' }, { [note(2)]: null }]) {
    assert.equal((await api({ action: 'favorites.merge', items }, ctx('a'))).error.code, 'INVALID_ARGUMENT');
  }
  assert.deepEqual(Object.keys((await store.get('dfp_favorites', 'a')).items), [note(1)]);
});

test('the cap refuses a new entry instead of silently dropping one', async () => {
  const { api, store } = await setup();
  const full = {};
  for (let n = 1; n <= FAVORITE_LIMIT; n++) full[hex(n)] = NOW;
  await store.put('dfp_favorites', 'a', { items: full, updatedAt: new Date(NOW).toISOString(), mergedAt: null });

  const refused = await api({ action: 'favorites.toggle', noteId: hex(FAVORITE_LIMIT + 1) }, ctx('a'));
  assert.equal(refused.error.code, 'LIMIT_EXCEEDED');
  assert.equal(Object.keys((await store.get('dfp_favorites', 'a')).items).length, FAVORITE_LIMIT);

  // Removing still works at the cap, and frees room for one more.
  assert.equal((await api({ action: 'favorites.toggle', noteId: hex(1) }, ctx('a'))).data.selected, false);
  assert.equal((await api({ action: 'favorites.toggle', noteId: hex(FAVORITE_LIMIT + 1) }, ctx('a'))).data.selected, true);
});

test('a merge that would exceed the cap writes nothing at all', async () => {
  const { api, store } = await setup();
  const items = {};
  for (let n = 1; n <= FAVORITE_LIMIT + 1; n++) items[hex(n)] = NOW;
  const refused = await api({ action: 'favorites.merge', items }, ctx('a'));
  assert.equal(refused.error.code, 'LIMIT_EXCEEDED');
  assert.equal(await store.get('dfp_favorites', 'a'), null, 'a refused merge is not partially applied');
});

test('a write failure is reported as a failure and leaves existing favourites alone', async () => {
  const { api, store } = await setup();
  await api({ action: 'favorites.toggle', noteId: note(1) }, ctx('a'));
  const failing = createAccount({
    store: { ...store, get: store.get.bind(store), list: store.list.bind(store), create: store.create.bind(store),
      remove: store.remove.bind(store), put: store.put.bind(store),
      transaction: async () => { throw new Error('storage unavailable'); } },
    config, now: () => NOW
  });
  const result = await failing({ action: 'favorites.toggle', noteId: note(2) }, ctx('a'));
  assert.equal(result.ok, false, 'a failed write must never be reported as success');
  assert.equal(result.error.code, 'BACKEND_UNAVAILABLE');
  assert.deepEqual(Object.keys((await store.get('dfp_favorites', 'a')).items), [note(1)]);
});

test('favourites are unreachable while suspended and intact after a restore', async () => {
  const { api, store } = await setup({ a: user(), owner: { ...user(), role: 'admin' } });
  await api({ action: 'favorites.toggle', noteId: note(1) }, ctx('a'));

  await api({ action: 'admin.setUserStatus', openId: 'a', status: 'suspended' }, ctx('owner'));
  for (const action of ['favorites.list', 'favorites.toggle', 'favorites.merge']) {
    assert.equal((await api({ action, noteId: note(2), items: {} }, ctx('a'))).error.code, 'SUSPENDED');
  }
  assert.deepEqual(Object.keys((await store.get('dfp_favorites', 'a')).items), [note(1)]);

  await api({ action: 'admin.setUserStatus', openId: 'a', status: 'active' }, ctx('owner'));
  assert.deepEqual((await api({ action: 'favorites.list' }, ctx('a'))).data.items, { [note(1)]: NOW });
});

test('an unregistered account cannot touch favourites at all', async () => {
  const { api, store } = await setup();
  for (const action of ['favorites.list', 'favorites.toggle', 'favorites.merge']) {
    assert.equal((await api({ action, noteId: note(1), items: {} }, ctx('stranger'))).error.code, 'NOT_REGISTERED');
  }
  assert.equal(await store.get('dfp_favorites', 'stranger'), null);
});

test('concurrent toggles on the same account do not lose an entry', async () => {
  const { api } = await setup();
  await Promise.all([note(1), note(2), note(3), note(4)]
    .map(noteId => api({ action: 'favorites.toggle', noteId }, ctx('a'))));
  const listed = (await api({ action: 'favorites.list' }, ctx('a'))).data.items;
  assert.deepEqual(Object.keys(listed).sort(), [note(1), note(2), note(3), note(4)].sort());
});
