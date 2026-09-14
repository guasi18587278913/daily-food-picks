'use strict';
const { createHash } = require('node:crypto');
const { assertLease } = require('./budget');
const { endpoint } = require('./endpoints');
const HOUR = 3600000;
function cacheKey(kind, parts) {
  return `${kind === 'judgment' ? 'judgment' : 'reuse'}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 48)}`;
}
async function readCache(store, key, { now, maxAgeMs, version }) {
  if (!key || !Number.isFinite(now) || !(maxAgeMs > 0)) return null;
  const entry = await store.get('dfp_results', key);
  if (!entry || entry.version !== version || !Number.isFinite(entry.capturedAt) || entry.capturedAt > now
    || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now || entry.expiresAt <= entry.capturedAt
    || now - entry.capturedAt > maxAgeMs || !entry.value || typeof entry.value !== 'object') return null;
  return { value: entry.value, capturedAt: entry.capturedAt, expiresAt: entry.expiresAt };
}
async function writeCache(store, lease, key, { capturedAt, ttlMs, version, value }, now) {
  if (!Number.isFinite(capturedAt) || capturedAt > now || !(ttlMs > 0 && ttlMs <= 7 * 24 * HOUR)
    || capturedAt + ttlMs <= now || typeof version !== 'string' || !value || typeof value !== 'object') throw new Error('INVALID_CACHE');
  return store.transaction(async tx => {
    await assertLease(tx, lease, now);
    const old = await tx.get('dfp_results', key);
    if (old && old.capturedAt > capturedAt) return false;
    await tx.put('dfp_results', key, { recordType: key.startsWith('judgment_') ? 'content_judgment' : 'reusable_result',
      capturedAt, expiresAt: capturedAt + ttlMs, version, value });
    return true;
  });
}
function maximumAge(kind, note, now) {
  const spec = endpoint(kind);
  const profile = spec?.yields === 'profile';
  if (profile && !Number.isSafeInteger(note?.fans)) return HOUR;
  if (profile && Number.isSafeInteger(note?.fans) && note.fans >= 4000 && note.fans <= 6000) return HOUR;
  if (spec?.detail) {
    const at = Date.parse(note?.publishedAt);
    if (Number.isFinite(at) && at >= now - 86400000) return HOUR;
    if ([300, 1000, 10000].some(t => Number.isFinite(note?.likes) && note.likes >= t * 0.8 && note.likes <= t * 1.2)) return HOUR;
  }
  return 6 * HOUR;
}
const compact = s => String(s || '').replace(/(?:\.{3,}|…+)\s*$/, '').replace(/\s+/g, ' ').trim();
function mergeDetail(full, discovered, now) {
  if (!full?.bodyComplete || full.noteId !== discovered?.noteId || full.authorId !== discovered.authorId) return null;
  if (discovered.title && full.title && compact(discovered.title) !== compact(full.title)) return null;
  if (discovered.desc && !compact(full.desc).includes(compact(discovered.desc))) return null;
  if (discovered.publishedAt && full.publishedAt !== discovered.publishedAt) return null;
  if (discovered.media?.identity && full.media?.identity !== discovered.media.identity) return null;
  const observedAt = Date.parse(discovered.metricsFetchedAt || discovered.fetchedAt);
  const cachedAt = Date.parse(full.metricsFetchedAt || full.fetchedAt);
  const result = { ...full };
  if (Number.isFinite(observedAt) && observedAt <= now && (!Number.isFinite(cachedAt) || observedAt > cachedAt)) {
    for (const key of ['likes', 'collected', 'comments', 'shared']) {
      if (Number.isSafeInteger(discovered[key]) && discovered[key] >= 0) result[key] = discovered[key];
    }
    result.metricsFetchedAt = new Date(observedAt).toISOString();
  }
  return result;
}
function judgmentKey(note, version, model, mode = 'text') {
  if (!note?.bodyComplete || (mode === 'visual' && !note.media?.identity)) return null;
  return cacheKey('judgment', [mode, version, model, note.type, note.title, note.desc,
    mode === 'visual' ? note.media.identity : null]);
}
module.exports = { cacheKey, readCache, writeCache, mergeDetail, judgmentKey, maximumAge };
