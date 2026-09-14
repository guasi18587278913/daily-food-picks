'use strict';

const { createHash } = require('node:crypto');

const PRICE_URL = 'https://tikhub.io/xiaohongshu-api';
const PRICE_MICRO_USD = 10000;
const DAY_MS = 86400000;

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function shanghaiDay(now) {
  if (!Number.isFinite(now)) fail('INVALID_TIME');
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
// Hard ceilings from the 2026-09-13 approval: 150 calls / 1.50 USD a day, at most 100 calls in one (06:00 sweep) round.
function validateLimits(limits) {
  if (!limits || !integer(limits.dailyCalls, 1, 150) || !integer(limits.dailyMicroUsd, 1, 1500000)
    || !integer(limits.roundCalls, 1, 100) || !integer(limits.validationCalls, 1, 20)
    || !integer(limits.validationMicroUsd, 1, 200000)) fail('INVALID_BUDGET');
}
function validatePrice(price, now) {
  if (!price || price.source !== PRICE_URL || price.microUsd !== PRICE_MICRO_USD
    || !Number.isFinite(price.verifiedAt) || !Number.isFinite(price.expiresAt)
    || price.verifiedAt > now || price.expiresAt <= now
    || price.expiresAt - price.verifiedAt > DAY_MS || now - price.verifiedAt > DAY_MS) fail('UNVERIFIED_PRICE');
}
async function assertLease(tx, lease, now) {
  const current = await tx.get('dfp_state', 'lease');
  if (!lease || !current || current.owner !== lease.owner || current.epoch !== lease.epoch
    || current.expiresAt <= now) fail('LEASE_EXPIRED');
  return current;
}

async function claimLease(store, { owner, now, ttlMs = 210000 }) {
  if (typeof owner !== 'string' || !owner || owner.length > 100 || !integer(ttlMs, 1, 210000)) fail('INVALID_LEASE');
  shanghaiDay(now);
  return store.transaction(async tx => {
    const old = await tx.get('dfp_state', 'lease');
    if (old && old.expiresAt > now && old.owner !== owner) return null;
    const next = { owner, epoch: (old?.epoch || 0) + 1, expiresAt: now + ttlMs };
    await tx.put('dfp_state', 'lease', next);
    return next;
  });
}

async function releaseLease(store, lease) {
  return store.transaction(async tx => {
    const current = await tx.get('dfp_state', 'lease');
    if (current?.owner === lease?.owner && current?.epoch === lease?.epoch) {
      await tx.put('dfp_state', 'lease', { ...current, owner: '', expiresAt: 0 });
    }
  });
}

function attemptId(roundId, requestKey, attempt) {
  return createHash('sha256').update(`${roundId}\n${requestKey}\n${attempt}`).digest('hex').slice(0, 48);
}

async function reserveAttempt(store, request) {
  const { roundId, requestKey, kind, attempt, now, lease, limits, price, validation = false } = request;
  validateLimits(limits);
  validatePrice(price, now);
  if (!/^\d{8}-\d{4}$/.test(roundId || '') || typeof requestKey !== 'string' || !requestKey
    || requestKey.length > 300 || !['search', 'author', 'user', 'note_image', 'note_video'].includes(kind)
    || !integer(attempt, 1, 2)) fail('INVALID_REQUEST');
  const day = shanghaiDay(now);
  const id = attemptId(roundId, requestKey, attempt);
  return store.transaction(async tx => {
    await assertLease(tx, lease, now);
    const existing = await tx.get('dfp_attempts', id);
    if (existing) {
      if (existing.requestKey !== requestKey || existing.kind !== kind) fail('REQUEST_KEY_COLLISION');
      return { ...existing, id, reused: true };
    }
    const round = await tx.get('dfp_rounds', roundId);
    if (!round || round.status !== 'running') fail('ROUND_NOT_RUNNING');
    const daily = await tx.get('dfp_budgets', day) || { calls: 0, microUsd: 0 };
    const trial = validation ? (await tx.get('dfp_budgets', 'initial-validation') || { calls: 0, microUsd: 0 }) : null;
    if (daily.calls + 1 > limits.dailyCalls || daily.microUsd + price.microUsd > limits.dailyMicroUsd) fail('DAILY_BUDGET');
    // Only the 06:00 sweep may use up to 100 calls; every other round keeps the original 20-call ceiling.
    const roundCeiling = round.definition?.kind === 'sweep' ? 100 : 20;
    if ((round.calls || 0) + 1 > Math.min(limits.roundCalls, roundCeiling)) fail('ROUND_BUDGET');
    if (trial && (trial.calls + 1 > limits.validationCalls || trial.microUsd + price.microUsd > limits.validationMicroUsd)) fail('VALIDATION_BUDGET');
    const record = {
      roundId, requestKey, kind, attempt, day, validation, owner: lease.owner, leaseEpoch: lease.epoch,
      status: 'reserved', microUsd: price.microUsd, reservedAt: now, finishedAt: null
    };
    await tx.put('dfp_budgets', day, { ...daily, calls: daily.calls + 1, microUsd: daily.microUsd + price.microUsd });
    if (trial) await tx.put('dfp_budgets', 'initial-validation', { ...trial, calls: trial.calls + 1, microUsd: trial.microUsd + price.microUsd });
    await tx.put('dfp_rounds', roundId, { ...round, calls: (round.calls || 0) + 1, microUsd: (round.microUsd || 0) + price.microUsd });
    await tx.create('dfp_attempts', id, record);
    return { ...record, id, reused: false };
  });
}

async function markInflight(store, id, lease, now) {
  return store.transaction(async tx => {
    await assertLease(tx, lease, now);
    const record = await tx.get('dfp_attempts', id);
    if (!record || record.owner !== lease.owner || record.leaseEpoch !== lease.epoch || record.status !== 'reserved') fail('ATTEMPT_NOT_DISPATCHABLE');
    if (record.day !== shanghaiDay(now)) fail('REQUEST_DAY_CHANGED');
    await tx.put('dfp_attempts', id, { ...record, status: 'inflight', sentAt: now });
  });
}

async function finishAttempt(store, id, lease, outcome, now) {
  if (!['succeeded', 'failed', 'unknown'].includes(outcome.status)) fail('INVALID_OUTCOME');
  return store.transaction(async tx => {
    await assertLease(tx, lease, now);
    const record = await tx.get('dfp_attempts', id);
    if (!record || record.owner !== lease.owner || record.leaseEpoch !== lease.epoch
      || !['inflight', 'reserved'].includes(record.status)) fail('ATTEMPT_NOT_OWNED');
    await tx.put('dfp_attempts', id, {
      ...record, status: outcome.status, finishedAt: now,
      errorCode: outcome.errorCode || null, resultRef: outcome.resultRef || null
    });
    // Reservations never get silently refunded: transport outcomes can be ambiguous.
  });
}

module.exports = { PRICE_URL, PRICE_MICRO_USD, shanghaiDay, validateLimits, validatePrice,
  assertLease, claimLease, releaseLease, attemptId, reserveAttempt, markInflight, finishAttempt };
