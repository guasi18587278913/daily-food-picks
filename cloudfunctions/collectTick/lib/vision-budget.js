'use strict';
const { createHash } = require('node:crypto');
const { assertLease, shanghaiDay } = require('./budget');
const PRICE_URL = 'https://cloud.tencent.com/document/product/865/17627';
const MODEL = 'vita-video-3.0';
const TOTAL_TOKENS = 16384, OUTPUT_TOKENS = 1024;
const RESERVATION_MICRO_CNY = 23245;
const DAY_MS = 86400000;
function fail(code) { const e = new Error(code); e.code = code; throw e; }
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
function validateSettings(settings) {
  if (!settings?.enabled) fail('VISION_DISABLED');
  if (!integer(settings.dailyMicroCny, 1, 500000) || !integer(settings.roundCalls, 1, 3)
    || !integer(settings.validationCalls, 1, 6) || !integer(settings.validationMicroCny, 1, 200000)) fail('VISION_INVALID_BUDGET');
}
function validatePrice(price, now) {
  if (!price || price.source !== PRICE_URL || price.model !== MODEL || price.inputMicroCnyPerMillion !== 1200000
    || price.outputMicroCnyPerMillion !== 3500000 || !Number.isFinite(price.verifiedAt) || price.verifiedAt > now
    || !Number.isFinite(price.expiresAt) || price.expiresAt <= now || price.expiresAt - price.verifiedAt > DAY_MS
    || now - price.verifiedAt > DAY_MS) fail('VISION_PRICE_UNVERIFIED');
}
function costOf(usage) {
  if (!usage || !integer(usage.prompt_tokens, 0, Number.MAX_SAFE_INTEGER)
    || !integer(usage.completion_tokens, 0, Number.MAX_SAFE_INTEGER)
    || !integer(usage.total_tokens, 0, Number.MAX_SAFE_INTEGER)
    || BigInt(usage.total_tokens) !== BigInt(usage.prompt_tokens) + BigInt(usage.completion_tokens)) return null;
  const cost = (BigInt(usage.prompt_tokens) * 12n + BigInt(usage.completion_tokens) * 35n + 9n) / 10n;
  return cost <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cost) : null;
}
function usageWithinContract(usage) {
  return costOf(usage) !== null && usage.total_tokens <= TOTAL_TOKENS && usage.completion_tokens <= OUTPUT_TOKENS;
}
function attemptKey(scope, roundId, key) {
  return `vision_${createHash('sha256').update(JSON.stringify([scope, scope === 'validation' ? 'initial' : roundId, key])).digest('hex').slice(0, 48)}`;
}
async function reserveVision(store, { lease, scope = 'round', roundId, key, now, settings, price }) {
  validateSettings(settings); validatePrice(price, now);
  if (!['round', 'validation'].includes(scope) || !/^[a-f0-9]{64}$/.test(key || '')
    || (scope === 'round' && !/^\d{8}-\d{4}$/.test(roundId || ''))) fail('VISION_INVALID_REQUEST');
  const day = shanghaiDay(now), id = attemptKey(scope, roundId, key);
  return store.transaction(async tx => {
    await assertLease(tx, lease, now);
    const existing = await tx.get('dfp_results', id);
    if (existing) return { ...existing, id, reused: true };
    if ((await tx.get('dfp_state', 'vision_stop'))?.blocked) fail('VISION_STOPPED');
    const dayKey = `vision-day-${day}`;
    const daily = await tx.get('dfp_budgets', dayKey) || { calls: 0, allocatedMicroCny: 0, knownMicroCny: 0 };
    const trial = scope === 'validation' ? await tx.get('dfp_budgets', 'vision-initial-validation')
      || { calls: 0, allocatedMicroCny: 0, knownMicroCny: 0 } : null;
    const round = scope === 'round' ? await tx.get('dfp_rounds', roundId) : null;
    for (const bucket of [daily, trial].filter(Boolean)) if (!integer(bucket.calls, 0, 1000000)
      || !integer(bucket.allocatedMicroCny, 0, Number.MAX_SAFE_INTEGER)
      || !integer(bucket.knownMicroCny, 0, Number.MAX_SAFE_INTEGER)) fail('VISION_INVALID_BUDGET');
    if (scope === 'round' && (!round || round.status !== 'running')) fail('ROUND_NOT_RUNNING');
    const roundCalls = round?.visionCalls === undefined ? 0 : round.visionCalls;
    const roundLimit = round?.definition?.visionRoundCalls === undefined ? settings.roundCalls : round.definition.visionRoundCalls;
    if (round && (!integer(roundCalls, 0, 3) || !integer(roundLimit, 1, 3))) fail('VISION_INVALID_BUDGET');
    if (round && roundCalls >= Math.min(settings.roundCalls, roundLimit)) fail('VISION_ROUND_BUDGET');
    if (daily.allocatedMicroCny + RESERVATION_MICRO_CNY > settings.dailyMicroCny) fail('VISION_DAILY_BUDGET');
    if (trial && (trial.calls >= settings.validationCalls || trial.allocatedMicroCny + RESERVATION_MICRO_CNY > settings.validationMicroCny)) fail('VISION_VALIDATION_BUDGET');
    const record = { recordType: 'vision_attempt', key, scope, roundId: roundId || null, day, dayKey,
      owner: lease.owner, leaseEpoch: lease.epoch, model: MODEL, status: 'reserved',
      reservedMicroCny: RESERVATION_MICRO_CNY, reservedAt: now, totalTokens: TOTAL_TOKENS, outputTokens: OUTPUT_TOKENS };
    await tx.put('dfp_budgets', dayKey, { ...daily, calls: daily.calls + 1, allocatedMicroCny: daily.allocatedMicroCny + RESERVATION_MICRO_CNY });
    if (trial) await tx.put('dfp_budgets', 'vision-initial-validation', { ...trial, calls: trial.calls + 1, allocatedMicroCny: trial.allocatedMicroCny + RESERVATION_MICRO_CNY });
    if (round) await tx.put('dfp_rounds', roundId, { ...round, visionCalls: roundCalls + 1 });
    await tx.create('dfp_results', id, record);
    return { ...record, id, reused: false };
  });
}
async function markVisionInflight(store, id, lease, now) {
  return store.transaction(async tx => {
    await assertLease(tx, lease, now);
    if ((await tx.get('dfp_state', 'vision_stop'))?.blocked) fail('VISION_STOPPED');
    const record = await tx.get('dfp_results', id);
    if (!record || record.status !== 'reserved' || record.owner !== lease.owner || record.leaseEpoch !== lease.epoch) fail('VISION_NOT_DISPATCHABLE');
    if (record.day !== shanghaiDay(now)) fail('REQUEST_DAY_CHANGED');
    await tx.put('dfp_results', id, { ...record, status: 'inflight', sentAt: now });
  });
}
async function finishVision(store, id, lease, outcome, now) {
  if (!['received', 'failed', 'unknown'].includes(outcome.status)) fail('VISION_INVALID_OUTCOME');
  return store.transaction(async tx => {
    await assertLease(tx, lease, now);
    const record = await tx.get('dfp_results', id);
    if (!record || record.owner !== lease.owner || record.leaseEpoch !== lease.epoch || record.status !== 'inflight') fail('VISION_NOT_OWNED');
    const computed = outcome.status === 'received' && !outcome.contractError ? costOf(outcome.usage) : null;
    const valid = outcome.status === 'received' && computed !== null && usageWithinContract(outcome.usage) && computed <= record.reservedMicroCny;
    const violation = outcome.status === 'received' && !valid;
    const charged = valid ? computed : Math.max(computed || 0, record.reservedMicroCny);
    for (const bucketId of [record.dayKey, ...(record.scope === 'validation' ? ['vision-initial-validation'] : [])]) {
      const bucket = await tx.get('dfp_budgets', bucketId);
      if (!bucket || bucket.allocatedMicroCny < record.reservedMicroCny) fail('VISION_LEDGER_MISMATCH');
      await tx.put('dfp_budgets', bucketId, { ...bucket,
        allocatedMicroCny: bucket.allocatedMicroCny - record.reservedMicroCny + charged,
        knownMicroCny: bucket.knownMicroCny + (computed ?? 0) });
    }
    if (violation) await tx.put('dfp_state', 'vision_stop', { blocked: true,
      reason: outcome.contractError || (computed === null ? 'VISION_USAGE_INVALID' : 'VISION_USAGE_EXCEEDED'), attemptId: id, at: now });
    const result = { ...record, status: valid ? 'received' : outcome.status === 'received' ? 'unknown' : outcome.status,
      finishedAt: now, actualMicroCny: computed, allocatedMicroCny: charged,
      usage: outcome.usage || null, usageValid: valid,
      errorCode: violation ? outcome.contractError || (computed === null ? 'VISION_USAGE_INVALID' : 'VISION_USAGE_EXCEEDED') : outcome.errorCode || (!valid ? 'VISION_USAGE_UNKNOWN' : null),
      result: valid ? outcome.result || null : null, httpStatus: integer(outcome.httpStatus, 100, 599) ? outcome.httpStatus : null };
    await tx.put('dfp_results', id, result);
    return result;
  });
}
module.exports = { PRICE_URL, MODEL, TOTAL_TOKENS, OUTPUT_TOKENS, RESERVATION_MICRO_CNY,
  validateSettings, validatePrice, costOf, usageWithinContract, attemptKey, reserveVision, markVisionInflight, finishVision };
