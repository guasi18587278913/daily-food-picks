'use strict';
const { changeUser, newUser, isAdmin, ROLES, STATUSES, CODE } = require('./users');
const { createInvite, normalizeCode } = require('./invites');

const ID = /^[A-Za-z0-9_-]{1,150}$/;
const MIGRATE_MAX = 200;

function fail(code) { const error = new Error(code); error.code = code; throw error; }

function pageOf(event, max = 50, fallback = 20) {
  const limit = event.limit === undefined ? fallback : event.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) fail('INVALID_ARGUMENT');
  const cursor = event.cursor === undefined || event.cursor === null || event.cursor === '' ? '' : event.cursor;
  if (cursor !== '' && (typeof cursor !== 'string' || !ID.test(cursor))) fail('INVALID_ARGUMENT');
  return { limit, cursor };
}

/** Reads one page plus a probe row, so the caller learns whether more exist without a second query. */
async function page(store, collection, { limit, cursor }, shape) {
  const rows = await store.list(collection, { after: cursor, limit: limit + 1 });
  return { rows: rows.slice(0, limit).map(shape), nextCursor: rows.length > limit ? rows[limit - 1]._id : null };
}

async function listUsers(store, event) {
  const { rows, nextCursor } = await page(store, 'dfp_users', pageOf(event), row => ({
    openId: row._id, role: row.role, status: row.status,
    grantedAt: row.grantedAt || null, grantedVia: row.grantedVia || null, inviteCode: row.inviteCode || null
  }));
  return { users: rows, nextCursor };
}

async function listInvites(store, event) {
  const { rows, nextCursor } = await page(store, 'dfp_invites', pageOf(event), row => ({
    code: row._id, maxUses: row.maxUses, usedCount: row.usedCount, expiresAt: row.expiresAt,
    active: row.active === true, createdAt: row.createdAt, note: row.note === undefined ? null : row.note
  }));
  return { invites: rows, nextCursor };
}

/**
 * Candidate administrators, read outside the transaction because a transaction has no query API.
 * Three rows are enough: if two or more match, at least one of them is not the target.
 */
async function adminCandidates(store) {
  const rows = await store.list('dfp_users', { limit: 3, filters: { role: 'admin', status: 'active' } });
  return rows.map(row => row._id);
}

/**
 * Confirms inside the transaction that some other administrator is still usable.
 * Each candidate is re-read under the transaction, so a concurrent demotion is seen rather than assumed.
 * A candidate list that is already stale can only make this stricter, never more permissive.
 */
async function anotherAdminRemains(tx, candidates, excluding) {
  for (const openId of candidates) {
    if (openId === excluding) continue;
    if (isAdmin(await tx.get('dfp_users', openId))) return true;
  }
  return false;
}

function target(event) {
  if (typeof event.openId !== 'string' || !ID.test(event.openId)) fail('INVALID_ARGUMENT');
  return event.openId;
}

/** @param {{get:Function,put:Function,list:Function,transaction:Function}} store */
async function changeAccess(store, event, { actor, at, field }) {
  const openId = target(event);
  const value = event[field];
  const allowed = field === 'status' ? STATUSES : ROLES;
  if (typeof value !== 'string' || !allowed.includes(value)) fail('INVALID_ARGUMENT');
  const candidates = await adminCandidates(store);

  // Read, check and write happen in one transaction: two administrators acting at the same moment
  // must not overwrite each other's change, and must not both pass the last-administrator check.
  await store.transaction(async tx => {
    const current = await tx.get('dfp_users', openId);
    if (!current) fail('NOT_FOUND');
    const losesAdmin = isAdmin(current) && (field === 'status' ? value === 'suspended' : value === 'member');
    if (losesAdmin && !await anotherAdminRemains(tx, candidates, openId)) fail('LAST_ADMIN');
    await tx.put('dfp_users', openId, changeUser(current, { [field]: value, at, actor }));
  });

  const entry = field === 'status' ? (value === 'suspended' ? 'suspend' : 'restore') : 'setRole';
  return { data: { openId, [field]: value }, audit: { action: entry, target: openId } };
}

async function revokeInvite(store, event, { at }) {
  const code = normalizeCode(event.code);
  if (!code) fail('INVALID_ARGUMENT');
  // In a transaction so that revoking cannot roll back a `usedCount` a concurrent redemption just wrote.
  await store.transaction(async tx => {
    const current = await tx.get('dfp_invites', code);
    if (!current) fail('CODE_NOT_FOUND');
    // Revoking only closes the code; accounts already granted through it keep their access.
    await tx.put('dfp_invites', code, { ...current, active: false, revokedAt: new Date(at).toISOString() });
  });
  return { data: { code, active: false }, audit: { action: 'revokeInvite', target: code } };
}

async function issueInvite(store, event, { actor, at }) {
  const created = await createInvite(store, { maxUses: event.maxUses, expiresInDays: event.expiresInDays,
    note: event.note === undefined ? null : event.note, createdBy: actor, at });
  return { data: created, audit: { action: 'createInvite', target: created.code } };
}

/**
 * Builds a user record for every identity still listed in server configuration.
 * Repeatable by design: an existing record is left exactly as it is.
 */
async function migrateWhitelist(store, { actor, at, openIds }) {
  // Each identity costs a read plus a transaction, so a very long list would hit the function timeout
  // and leave a result that cannot be told apart from a completed run.
  if (openIds.length > MIGRATE_MAX) fail('INVALID_ARGUMENT');
  let created = 0; let skipped = 0;
  for (const openId of openIds) {
    if (!ID.test(openId)) { skipped++; continue; }
    if (await store.get('dfp_users', openId)) { skipped++; continue; }
    try {
      await store.create('dfp_users', openId, newUser({ role: 'member', grantedVia: 'migration', at, actor }));
      created++;
    } catch { skipped++; }
  }
  return { data: { created, skipped, total: openIds.length }, audit: { action: 'migrate', target: null } };
}

module.exports = { listUsers, listInvites, changeAccess, revokeInvite, issueInvite, migrateWhitelist, CODE };
