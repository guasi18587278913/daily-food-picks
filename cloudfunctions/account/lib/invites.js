'use strict';
const { randomInt } = require('node:crypto');
const { newUser, valid, CODE } = require('./users');

// I, L, O, U, 0 and 1 are left out so a code can be read aloud or retyped without confusion.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const LENGTH = 10;
const DAY_MS = 86400000;
const ATTEMPT_WINDOW_MS = 3600000;
const ATTEMPT_LIMIT = 10;

function fail(code, hint) {
  const error = new Error(code);
  error.code = code;
  if (hint) error.hint = hint;
  throw error;
}

function randomCode() {
  let code = '';
  for (let position = 0; position < LENGTH; position++) code += ALPHABET[randomInt(0, ALPHABET.length)];
  return code;
}

/** @param {unknown} input @returns {string|null} null when the input cannot be a code at all */
function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.trim().toUpperCase().replace(/[\s-]/g, '');
  return CODE.test(cleaned) ? cleaned : null;
}

function bounded(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }

/**
 * @param {{create:Function}} store
 * @param {{maxUses:number,expiresInDays:number,note?:string|null,createdBy:string,at:number,generate?:() => string}} input
 */
async function createInvite(store, { maxUses, expiresInDays, note = null, createdBy, at, generate = randomCode }) {
  if (!bounded(maxUses, 1, 100) || !bounded(expiresInDays, 1, 365)) fail('INVALID_ARGUMENT');
  if (note !== null && (typeof note !== 'string' || note.length > 50)) fail('INVALID_ARGUMENT');
  const record = { maxUses, usedCount: 0, expiresAt: new Date(at + expiresInDays * DAY_MS).toISOString(),
    active: true, createdAt: new Date(at).toISOString(), createdBy, note };
  // A collision must never overwrite a code already handed out, so retry instead of writing through.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generate();
    if (!CODE.test(code)) fail('BACKEND_UNAVAILABLE');
    try {
      await store.create('dfp_invites', code, record);
      return { code, maxUses, expiresAt: record.expiresAt };
    } catch (error) {
      // Only a taken code justifies another draw; a real storage failure should not burn five attempts.
      if (!(await store.get('dfp_invites', code))) throw error;
    }
  }
  return fail('BACKEND_UNAVAILABLE');
}

function usable(record, at) {
  if (!record || typeof record !== 'object' || record.active !== true) fail('CODE_NOT_FOUND');
  if (!(at < Date.parse(record.expiresAt))) fail('CODE_EXPIRED');
  // Both sides of the comparison are checked: a missing maxUses would otherwise make the code unlimited,
  // because `0 >= undefined` is false.
  if (!bounded(record.maxUses, 1, 100) || !bounded(record.usedCount, 0, Number.MAX_SAFE_INTEGER)
    || record.usedCount >= record.maxUses) fail('CODE_EXHAUSTED');
}

async function throttle(store, openId, at) {
  const record = await store.get('dfp_redeem_attempts', openId);
  const open = record && Number.isSafeInteger(record.windowStartedAt) && at - record.windowStartedAt < ATTEMPT_WINDOW_MS;
  if (!open || !(record.failures >= ATTEMPT_LIMIT)) return;
  const minutes = Math.max(1, Math.ceil((ATTEMPT_WINDOW_MS - (at - record.windowStartedAt)) / 60000));
  fail('TOO_MANY_ATTEMPTS', `请 ${minutes} 分钟后再试。`);
}

/** Counts inside a transaction so simultaneous wrong guesses each increment instead of overwriting. */
async function countFailure(store, openId, at) {
  await store.transaction(async tx => {
    const record = await tx.get('dfp_redeem_attempts', openId);
    const open = record && Number.isSafeInteger(record.windowStartedAt) && at - record.windowStartedAt < ATTEMPT_WINDOW_MS;
    await tx.put('dfp_redeem_attempts', openId, open
      ? { windowStartedAt: record.windowStartedAt, failures: (Number.isSafeInteger(record.failures) ? record.failures : 0) + 1 }
      : { windowStartedAt: at, failures: 1 });
  });
}

/**
 * Consumes one use of a code and grants membership, atomically.
 * @param {{get:Function,put:Function,remove:Function,transaction:Function}} store
 * @param {{openId:string,code:unknown,at:number}} input
 */
async function redeem(store, { openId, code, at }) {
  const normalized = normalizeCode(code);
  if (!normalized) fail('INVALID_ARGUMENT');
  await throttle(store, openId, at);
  try {
    const granted = await store.transaction(async tx => {
      usable(await tx.get('dfp_invites', normalized), at);
      // An existing record decides the outcome before any use is spent.
      const current = await tx.get('dfp_users', openId);
      if (valid(current)) fail(current.status === 'suspended' ? 'SUSPENDED' : 'ALREADY_REGISTERED');
      const record = newUser({ role: 'member', grantedVia: 'invite', inviteCode: normalized, at, actor: openId });
      await tx.put('dfp_users', openId, record);
      const invite = await tx.get('dfp_invites', normalized);
      await tx.put('dfp_invites', normalized, { ...invite, usedCount: invite.usedCount + 1 });
      // `code` travels back for the audit entry; the action layer keeps it out of the client payload.
      return { role: record.role, status: record.status, code: normalized };
    });
    // The grant has already committed, so a failed cleanup must not turn success into an error.
    // Leaving the counter behind only costs the account one throttle window.
    try { await store.remove('dfp_redeem_attempts', openId); }
    catch (error) { console.error(`clearing redeem attempts failed: ${error && error.message}`); }
    return granted;
  } catch (error) {
    // Only a problem with the code itself counts as a guess; a known account is not a guesser.
    if (['CODE_NOT_FOUND', 'CODE_EXPIRED', 'CODE_EXHAUSTED'].includes(error.code)) await countFailure(store, openId, at);
    throw error;
  }
}

module.exports = { createInvite, normalizeCode, redeem, randomCode, ALPHABET, LENGTH, ATTEMPT_WINDOW_MS, ATTEMPT_LIMIT };
