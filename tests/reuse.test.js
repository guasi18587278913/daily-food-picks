'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore, NOW } = require('./helpers');
const { claimLease } = require('../cloudfunctions/collectTick/lib/budget');
const { cacheKey, readCache, writeCache, mergeDetail, judgmentKey, maximumAge } = require('../cloudfunctions/collectTick/lib/reuse');
async function setup() { const store = new MemoryStore(); const lease = await claimLease(store, { owner: 'worker', now: NOW }); return { store, lease }; }
const note = patch => ({ noteId: '1'.repeat(24), authorId: '2'.repeat(24), type: 'video', title: '教你做蒸蛋',
  desc: '鸡蛋加水，蒸十分钟。', bodyComplete: true, likes: 900, publishedAt: new Date(NOW - 3600000).toISOString(),
  fetchedAt: new Date(NOW - 600000).toISOString(), media: { identity: 'same-video' }, ...patch });
test('fresh cache retains its actual sample time and does not overwrite newer data', async () => {
  const { store, lease } = await setup(); const key = cacheKey('result', 'one');
  await writeCache(store, lease, key, { capturedAt: NOW - 1000, ttlMs: 3600000, version: 'v1', value: { fans: 500 } }, NOW);
  assert.equal((await readCache(store, key, { now: NOW, maxAgeMs: 3600000, version: 'v1' })).capturedAt, NOW - 1000);
  await writeCache(store, lease, key, { capturedAt: NOW - 2000, ttlMs: 3600000, version: 'v1', value: { fans: 400 } }, NOW);
  assert.equal((await readCache(store, key, { now: NOW, maxAgeMs: 3600000, version: 'v1' })).value.fans, 500);
});
test('expired, changed-version, and future-dated cache cannot be reused', async () => {
  const { store, lease } = await setup(); const key = cacheKey('result', 'one');
  await writeCache(store, lease, key, { capturedAt: NOW - 1000, ttlMs: 3600000, version: 'v1', value: {} }, NOW);
  assert.equal(await readCache(store, key, { now: NOW, maxAgeMs: 500, version: 'v1' }), null);
  assert.equal(await readCache(store, key, { now: NOW, maxAgeMs: 3600000, version: 'v2' }), null);
  const raw = await store.get('dfp_results', key); raw.capturedAt = NOW + 1; await store.put('dfp_results', key, raw);
  assert.equal(await readCache(store, key, { now: NOW, maxAgeMs: 3600000, version: 'v1' }), null);
});
test('expired worker cannot update shared cache', async () => {
  const { store, lease } = await setup(); const later = NOW + 220000;
  await claimLease(store, { owner: 'next', now: later });
  await assert.rejects(() => writeCache(store, lease, cacheKey('result', 'one'),
    { capturedAt: NOW, ttlMs: 3600000, version: 'v1', value: {} }, later), /LEASE_EXPIRED/);
});
test('newer search likes are retained when full old text is reused', () => {
  const full = note({ likes: 900 });
  const fresh = note({ likes: 1100, desc: '鸡蛋加水，', bodyComplete: false, fetchedAt: new Date(NOW).toISOString() });
  const result = mergeDetail(full, fresh, NOW);
  assert.equal(result.likes, 1100); assert.equal(result.desc, full.desc); assert.equal(result.bodyComplete, true);
  assert.equal(result.fetchedAt, full.fetchedAt); assert.equal(result.metricsFetchedAt, fresh.fetchedAt);
});
test('changed text, publication time or video identity invalidates reusable detail', () => {
  for (const patch of [{ title: '换了内容' }, { desc: '今天探店' }, { publishedAt: new Date(NOW - 7200000).toISOString() }, { media: { identity: 'new-video' } }]) {
    assert.equal(mergeDetail(note(), note({ bodyComplete: false, ...patch }), NOW), null);
  }
});
test('judgment identity binds content, rule, model, and real video identity', () => {
  const a = judgmentKey(note(), 'rule1', 'model1', 'visual');
  assert.notEqual(a, judgmentKey(note(), 'rule2', 'model1', 'visual'));
  assert.notEqual(a, judgmentKey(note(), 'rule1', 'model2', 'visual'));
  assert.notEqual(a, judgmentKey(note({ media: { identity: 'different' } }), 'rule1', 'model1', 'visual'));
  assert.equal(judgmentKey(note({ media: undefined }), 'rule1', 'model1', 'visual'), null);
  assert.notEqual(judgmentKey(note(), 'rule1', 'model1', 'text'), judgmentKey(note({ desc: '其他正文' }), 'rule1', 'model1', 'text'));
});
test('today and threshold-adjacent data use a tighter freshness window', () => {
  assert.equal(maximumAge('note_video', note(), NOW), 3600000);
  assert.equal(maximumAge('note_video', note({ publishedAt: new Date(NOW - 3 * 86400000).toISOString(), likes: 9900 }), NOW), 3600000);
  assert.equal(maximumAge('user', { fans: 4900 }, NOW), 3600000);
  assert.equal(maximumAge('user', { fans: 100000 }, NOW), 21600000);
});
