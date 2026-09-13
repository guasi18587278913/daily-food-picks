'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { newUser, changeUser, isAdmin } = require('../cloudfunctions/account/lib/users');

const NOW = Date.parse('2026-09-13T10:00:00+08:00');
const stamp = new Date(NOW).toISOString();
const active = { role: 'member', status: 'active', grantedAt: stamp, grantedVia: 'invite',
  inviteCode: 'ABCDEFGHJK', updatedAt: stamp, updatedBy: 'member-1' };

function throwsWith(fn, code) {
  assert.throws(fn, error => {
    assert.equal(error.code, code);
    return true;
  });
}

test('a new record carries every field the data model requires', () => {
  const record = newUser({ role: 'member', grantedVia: 'invite', inviteCode: 'ABCDEFGHJK', at: NOW, actor: 'member-1' });
  assert.deepEqual(record, active);
  const migrated = newUser({ role: 'member', grantedVia: 'migration', at: NOW, actor: 'owner' });
  assert.equal(migrated.inviteCode, null);
  assert.equal(migrated.status, 'active');
  assert.equal(migrated.updatedBy, 'owner');
});

test('a new record rejects values outside the data model', () => {
  throwsWith(() => newUser({ role: 'owner', grantedVia: 'invite', inviteCode: 'ABCDEFGHJK', at: NOW, actor: 'x' }), 'INVALID_ARGUMENT');
  throwsWith(() => newUser({ role: 'member', grantedVia: 'handshake', at: NOW, actor: 'x' }), 'INVALID_ARGUMENT');
  // grantedVia 'invite' requires the code that was redeemed, so the origin stays traceable.
  throwsWith(() => newUser({ role: 'member', grantedVia: 'invite', at: NOW, actor: 'x' }), 'INVALID_ARGUMENT');
  throwsWith(() => newUser({ role: 'member', grantedVia: 'invite', inviteCode: 'lower-case', at: NOW, actor: 'x' }), 'INVALID_ARGUMENT');
});

test('status and role changes follow the documented transitions', () => {
  const suspended = changeUser(active, { status: 'suspended', at: NOW + 1000, actor: 'owner' });
  assert.equal(suspended.status, 'suspended');
  assert.equal(suspended.updatedAt, new Date(NOW + 1000).toISOString());
  assert.equal(suspended.updatedBy, 'owner');
  // Fields that describe how access was granted never change on a later edit.
  assert.equal(suspended.grantedAt, active.grantedAt);
  assert.equal(suspended.grantedVia, active.grantedVia);
  assert.equal(suspended.inviteCode, active.inviteCode);

  assert.equal(changeUser(suspended, { status: 'active', at: NOW, actor: 'owner' }).status, 'active');
  assert.equal(changeUser(active, { role: 'admin', at: NOW, actor: 'owner' }).role, 'admin');
  assert.equal(changeUser({ ...active, role: 'admin' }, { role: 'member', at: NOW, actor: 'owner' }).role, 'member');
});

test('a change to an illegal value is refused instead of being written through', () => {
  for (const change of [{ status: 'pending' }, { role: 'owner' }, { status: '' }, { role: null },
    { status: 'ACTIVE' }, { role: 'admin', status: 'deleted' }, {}]) {
    throwsWith(() => changeUser(active, { ...change, at: NOW, actor: 'owner' }), 'INVALID_ARGUMENT');
  }
});

test('a damaged record cannot be repaired by a normal change', () => {
  // Writing through a broken record would silently grant access the audit trail cannot explain.
  for (const broken of [{}, { role: 'member' }, { role: 'owner', status: 'active' }, { role: 'member', status: 'pending' }]) {
    throwsWith(() => changeUser(broken, { status: 'active', at: NOW, actor: 'owner' }), 'INVALID_ARGUMENT');
  }
});

test('isAdmin only accepts an active admin record', () => {
  assert.equal(isAdmin({ role: 'admin', status: 'active' }), true);
  for (const value of [{ role: 'admin', status: 'suspended' }, { role: 'member', status: 'active' },
    { role: 'ADMIN', status: 'active' }, {}, null, undefined, 'admin']) {
    assert.equal(isAdmin(value), false);
  }
});
