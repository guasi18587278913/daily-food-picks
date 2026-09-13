'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkInviteForm, userRow, inviteRow, shortId, displayCode } = require('../miniprogram/lib/admin');

const NOW = Date.parse('2026-09-13T10:00:00+08:00');
const DAY = 86400000;

function pageHarness() {
  let definition;
  global.wx = { cloud: { callFunction: async () => ({}) }, showToast() {}, setClipboardData() {} };
  global.Page = value => { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/admin/admin');
  delete require.cache[modulePath];
  require(modulePath);
  delete global.Page;
  return { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
}

test('the invite form refuses values the server would refuse anyway', () => {
  assert.deepEqual(checkInviteForm({ maxUses: '3', expiresInDays: '7', note: ' 给大芙 ' }),
    { ok: true, message: '', value: { maxUses: 3, expiresInDays: 7, note: '给大芙' } });
  assert.equal(checkInviteForm({ maxUses: '5', expiresInDays: '7', note: '' }).value.note, null);

  for (const form of [{ maxUses: '0', expiresInDays: '7' }, { maxUses: '101', expiresInDays: '7' },
    { maxUses: '1.5', expiresInDays: '7' }, { maxUses: 'abc', expiresInDays: '7' }, { maxUses: '', expiresInDays: '7' },
    { maxUses: '5', expiresInDays: '0' }, { maxUses: '5', expiresInDays: '366' }, { maxUses: '5', expiresInDays: 'x' },
    { maxUses: '5', expiresInDays: '7', note: 'x'.repeat(51) }]) {
    const checked = checkInviteForm({ note: '', ...form });
    assert.equal(checked.ok, false, JSON.stringify(form));
    assert.equal(checked.value, null);
    assert.ok(checked.message.length > 0);
  }
});

test('rows are shaped for reading without inventing data', () => {
  const row = userRow({ openId: 'o'.repeat(28), role: 'admin', status: 'suspended',
    grantedAt: '2026-09-12T16:00:00.000Z', grantedVia: 'bootstrap', inviteCode: null });
  assert.equal(row.roleLabel, '管理员');
  assert.equal(row.statusLabel, '已停用');
  assert.equal(row.suspended, true);
  assert.equal(row.isAdmin, true);
  assert.equal(row.originLabel, '初始管理员');
  assert.equal(row.inviteCode, '—');
  assert.equal(row.grantedLabel, '2026-09-13', 'dates are shown in Beijing time');
  assert.equal(row.openId, 'o'.repeat(28), 'the full identifier stays available for actions');
  assert.ok(row.label.length < 20, 'the displayed identifier is shortened');

  // Missing optional fields become a dash rather than "undefined" or a guess.
  const sparse = userRow({ openId: 'x', role: 'member', status: 'active', grantedAt: null, grantedVia: null, inviteCode: null });
  assert.equal(sparse.grantedLabel, '—');
  assert.equal(sparse.originLabel, '—');
  assert.equal(shortId('short'), 'short');
  assert.equal(displayCode('ABCDEFGHJK'), 'ABCDE-FGHJK');
  assert.equal(displayCode('odd'), 'odd');
});

test('an invite row states exactly why a code cannot be handed out', () => {
  const base = { code: 'ABCDEFGHJK', maxUses: 3, usedCount: 1,
    expiresAt: new Date(NOW + DAY).toISOString(), active: true, createdAt: new Date(NOW - DAY).toISOString(), note: '给大芙' };
  const usable = inviteRow(base, NOW);
  assert.equal(usable.usable, true);
  assert.equal(usable.stateLabel, '可用');
  assert.equal(usable.usageLabel, '1 / 3');
  assert.equal(usable.display, 'ABCDE-FGHJK');
  assert.equal(usable.note, '给大芙');

  assert.equal(inviteRow({ ...base, active: false }, NOW).stateLabel, '已停用');
  assert.equal(inviteRow({ ...base, expiresAt: new Date(NOW - 1).toISOString() }, NOW).stateLabel, '已过期');
  assert.equal(inviteRow({ ...base, usedCount: 3 }, NOW).stateLabel, '已用完');
  for (const broken of [{ active: false }, { expiresAt: new Date(NOW - 1).toISOString() }, { usedCount: 3 }]) {
    assert.equal(inviteRow({ ...base, ...broken }, NOW).usable, false);
  }
});

test('the page stays closed to anyone the server does not call an administrator', async () => {
  for (const [me, ready] of [[{ role: 'admin', status: 'active' }, true], [{ role: 'member', status: 'active' }, false]]) {
    const page = pageHarness();
    const calls = [];
    page._account = async (action, params) => {
      calls.push(action);
      if (action === 'me') return me;
      if (action === 'admin.listUsers') return { users: [], nextCursor: null };
      if (action === 'admin.listInvites') return { invites: [], nextCursor: null };
      throw new Error(`unexpected ${action}`);
    };
    await page.onLoad();
    assert.equal(page.data.ready, ready);
    assert.equal(calls.includes('admin.listUsers'), ready, 'a non-admin must not even request the user list');
  }
});

test('a refusal from the server is shown and the page claims nothing succeeded', async () => {
  const page = pageHarness();
  page._account = async action => {
    if (action === 'me') return { role: 'admin', status: 'active' };
    if (action === 'admin.listUsers') return { users: [{ openId: 'owner', role: 'admin', status: 'active',
      grantedAt: '2026-09-12T00:00:00.000Z', grantedVia: 'bootstrap', inviteCode: null }], nextCursor: null };
    if (action === 'admin.listInvites') return { invites: [], nextCursor: null };
    const error = /** @type {any} */ (new Error('系统需要保留至少一个管理员，这个操作被拒绝。'));
    error.code = 'LAST_ADMIN';
    throw error;
  };
  await page.onLoad();
  assert.equal(page.data.users.length, 1);

  await page.onToggleStatus({ currentTarget: { dataset: { id: 'owner', suspended: 'false' } } });
  assert.equal(page.data.message, '系统需要保留至少一个管理员，这个操作被拒绝。');
  assert.equal(page.data.busy, '', 'the busy flag is released even when the call fails');
  assert.equal(page.data.users[0].suspended, false, 'the row is unchanged after a refusal');
});

test('one management call at a time, so a double tap cannot act twice', async () => {
  const page = pageHarness();
  const sent = [];
  let release;
  page._account = async (action, params) => {
    if (action === 'me') return { role: 'admin', status: 'active' };
    if (action === 'admin.listUsers') return { users: [], nextCursor: null };
    if (action === 'admin.listInvites') return { invites: [], nextCursor: null };
    sent.push({ action, params });
    return new Promise(resolve => { release = () => resolve({ openId: 'member-1', status: 'suspended' }); });
  };
  await page.onLoad();
  const first = page.onToggleStatus({ currentTarget: { dataset: { id: 'member-1', suspended: 'false' } } });
  await page.onToggleStatus({ currentTarget: { dataset: { id: 'member-1', suspended: 'false' } } });
  assert.equal(sent.length, 1);
  release();
  await first;
  assert.equal(page.data.busy, '');
});

test('creating a code shows it once for copying and reloads the list', async () => {
  const page = pageHarness();
  const actions = [];
  page._account = async (action, params) => {
    actions.push({ action, params });
    if (action === 'me') return { role: 'admin', status: 'active' };
    if (action === 'admin.listUsers') return { users: [], nextCursor: null };
    if (action === 'admin.listInvites') return { invites: [], nextCursor: null };
    if (action === 'admin.createInvite') {
      return { code: 'ABCDEFGHJK', maxUses: params.maxUses, expiresAt: new Date(NOW + 30 * DAY).toISOString() };
    }
    throw new Error(`unexpected ${action}`);
  };
  await page.onLoad();
  page.data.form = { maxUses: '3', expiresInDays: '30', note: '给大芙' };
  await page.onCreateInvite();

  const created = actions.find(a => a.action === 'admin.createInvite');
  assert.deepEqual(created.params, { maxUses: 3, expiresInDays: 30, note: '给大芙' });
  assert.equal(page.data.created.display, 'ABCDE-FGHJK');
  assert.equal(actions.filter(a => a.action === 'admin.listInvites').length, 2, 'the list reloads after creation');
});

test('an invalid form is refused locally without calling the server', async () => {
  const page = pageHarness();
  const actions = [];
  page._account = async action => {
    actions.push(action);
    if (action === 'me') return { role: 'admin', status: 'active' };
    if (action === 'admin.listUsers') return { users: [], nextCursor: null };
    if (action === 'admin.listInvites') return { invites: [], nextCursor: null };
    throw new Error(`unexpected ${action}`);
  };
  await page.onLoad();
  page.data.form = { maxUses: '0', expiresInDays: '30', note: '' };
  await page.onCreateInvite();
  assert.equal(actions.includes('admin.createInvite'), false);
  assert.match(page.data.message, /可用次数/);
});
