'use strict';
const { judgmentKey, readCache, writeCache } = require('./reuse');
const { extractFrames, SAMPLER_VERSION } = require('./video');
const { classifyFrames, verifyVisionPrice, VERSION } = require('./vision');
const { validatePrice, MODEL } = require('./vision-budget');
const TEXT_VERSION = 'food-text-20260914-1';
const DAY = 86400000;
function identity(note, mode) {
  const version = mode === 'visual' ? `${VERSION}:${SAMPLER_VERSION}` : TEXT_VERSION;
  return { key: judgmentKey(note, version, mode === 'visual' ? MODEL : 'hy3', mode), version };
}
async function cachedJudgment(store, note, mode, now, warn = () => {}) {
  const { key, version } = identity(note, mode);
  try {
    const cached = await readCache(store, key, { now, maxAgeMs: 7 * DAY, version });
    return cached && ['cooking', 'not_cooking', 'uncertain'].includes(cached.value.verdict) ? cached.value : null;
  } catch (e) { if (e.code === 'LEASE_EXPIRED') throw e; warn('CACHE_UNAVAILABLE'); return null; }
}
async function cacheJudgment(store, lease, note, mode, value, now) {
  if (!['cooking', 'not_cooking', 'uncertain'].includes(value?.verdict)) return;
  const { key, version } = identity(note, mode); if (!key) return;
  try { await writeCache(store, lease, key, { capturedAt: now, ttlMs: value.verdict === 'uncertain' ? DAY : 7 * DAY, version, value }, now); }
  catch (e) { if (e.code === 'LEASE_EXPIRED') throw e; return 'CACHE_UNAVAILABLE'; }
}
async function reviewVideo({ store, lease, round, note, settings, key, clock = Date.now,
  extract = extractFrames, classify = classifyFrames, verify = verifyVisionPrice }) {
  if (!settings?.enabled || !round.visionEnabled) return { verdict: 'uncertain', reason: 'VISION_DISABLED' };
  let cacheWarning;
  const cached = await cachedJudgment(store, note, 'visual', clock(), warning => { cacheWarning = warning; });
  if (cached) return { ...cached, cached: true };
  let price = await store.get('dfp_state', 'vision_price');
  try { validatePrice(price, clock()); } catch {
    price = await verify(undefined, clock());
    // The paid dispatcher revalidates the quote and lease immediately before reserving.
    await store.put('dfp_state', 'vision_price', price);
  }
  const frames = await extract(note.media);
  if (new Set(frames.samples.map(frame => frame.sha256)).size < 2) {
    const result = { verdict: 'uncertain', evidence: [], reason: 'identical_frames', evidenceSource: 'frames' };
    cacheWarning = await cacheJudgment(store, lease, note, 'visual', result, clock()) || cacheWarning;
    return { ...result, ...(cacheWarning ? { cacheWarning } : {}) };
  }
  const result = await classify({ store, lease, roundId: round.id, note, frames, settings, price, key, clock });
  cacheWarning = await cacheJudgment(store, lease, note, 'visual', result, clock()) || cacheWarning;
  return { ...result, ...(cacheWarning ? { cacheWarning } : {}) };
}
module.exports = { TEXT_VERSION, cachedJudgment, cacheJudgment, reviewVideo };
