'use strict';

// This module owns the shape of a user record. access.js consumes it; nothing here depends on access.js.
const ROLES = Object.freeze(['admin', 'member']);
const STATUSES = Object.freeze(['active', 'suspended']);
const ORIGINS = Object.freeze(['invite', 'bootstrap', 'migration']);
const CODE = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{10}$/;

function fail(code) { const error = new Error(code); error.code = code; throw error; }

/** A record is only usable when both access fields hold a known value. */
function valid(record) {
  return !!record && typeof record === 'object' && ROLES.includes(record.role) && STATUSES.includes(record.status);
}

/** @param {{role:string,grantedVia:string,inviteCode?:string|null,at:number,actor:string}} input */
function newUser({ role, grantedVia, inviteCode = null, at, actor }) {
  if (!ROLES.includes(role) || !ORIGINS.includes(grantedVia)) fail('INVALID_ARGUMENT');
  // An invite-granted record must name the code it consumed so the origin stays traceable.
  if (grantedVia === 'invite' ? !CODE.test(inviteCode || '') : inviteCode !== null) fail('INVALID_ARGUMENT');
  const stamp = new Date(at).toISOString();
  return { role, status: 'active', grantedAt: stamp, grantedVia, inviteCode, updatedAt: stamp, updatedBy: actor };
}

/**
 * Applies a role or status change, keeping how access was granted untouched.
 * @param {unknown} current @param {{role?:string,status?:string,at:number,actor:string}} change
 */
function changeUser(current, { role, status, at, actor }) {
  if (!valid(current)) fail('INVALID_ARGUMENT');
  if (role === undefined && status === undefined) fail('INVALID_ARGUMENT');
  if (role !== undefined && !ROLES.includes(role)) fail('INVALID_ARGUMENT');
  if (status !== undefined && !STATUSES.includes(status)) fail('INVALID_ARGUMENT');
  return {
    ...current,
    role: role === undefined ? current.role : role,
    status: status === undefined ? current.status : status,
    updatedAt: new Date(at).toISOString(),
    updatedBy: actor
  };
}

function isAdmin(record) { return valid(record) && record.role === 'admin' && record.status === 'active'; }

module.exports = { newUser, changeUser, isAdmin, valid, ROLES, STATUSES, ORIGINS, CODE };
