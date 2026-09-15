'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore, NOW } = require('./helpers');
const { claimLease } = require('../cloudfunctions/collectTick/lib/budget');
const { RULES, INDEX_ID, historyId, prunePoints, gainWithin, recordFansObservation, selectRecheck, risingAccounts, publishedRecently } = require('../cloudfunctions/collectTick/lib/authors');
const id = n => n.toString(16).padStart(24, '0');
const HOUR = 3600000, DAY = 86400000;
async function setup() {
  const store = new MemoryStore(); const lease = await claimLease(store, { owner: 'worker', now: NOW });
  return { store, lease };
}

test('observation history is ordered, deduplicated per instant, bounded and limited to fourteen days', () => {
  const points = [{ at: NOW - 15 * DAY, fans: 1 }, { at: NOW - DAY, fans: 300 }, { at: NOW - DAY, fans: 300 }, { at: NOW - 2 * DAY, fans: 200 },
    { at: NOW + 1000, fans: 999 }, { at: NOW - 3 * DAY, fans: null }, { at: 'x', fans: 5 }];
  assert.deepEqual(prunePoints(points, NOW), [{ at: NOW - 2 * DAY, fans: 200 }, { at: NOW - DAY, fans: 300 }]);
  const many = Array.from({ length: 60 }, (_, i) => ({ at: NOW - i * HOUR, fans: i }));
  assert.equal(prunePoints(many, NOW).length, RULES.maxPoints);
});

test('a gain needs two observations inside the window at least twelve hours apart', () => {
  assert.equal(gainWithin([{ at: NOW - DAY, fans: 5000 }], NOW), null);
  assert.equal(gainWithin([{ at: NOW - 11 * HOUR, fans: 5000 }, { at: NOW, fans: 7000 }], NOW), null);
  assert.equal(gainWithin([{ at: NOW - 8 * DAY, fans: 1000 }, { at: NOW, fans: 7000 }], NOW), null);
  const growth = gainWithin([{ at: NOW - 8 * DAY, fans: 100 }, { at: NOW - 3 * DAY, fans: 5000 }, { at: NOW - DAY, fans: 5600 }, { at: NOW, fans: 6300 }], NOW);
  assert.deepEqual(growth, { gain: 1300, spanMs: 3 * DAY, baselineAt: NOW - 3 * DAY, fansBefore: 5000, fans: 6300, observedAt: NOW });
  assert.equal(gainWithin([{ at: NOW - 2 * DAY, fans: 9000 }, { at: NOW, fans: 8000 }], NOW).gain, -1000);
});

test('observations from any entry are recorded once per author with the index kept in step', async () => {
  const { store, lease } = await setup();
  assert.equal(await recordFansObservation(store, lease, { authorId: 'nope', fans: 10, at: NOW }, NOW), false);
  assert.equal(await recordFansObservation(store, lease, { authorId: id(1), fans: -1, at: NOW }, NOW), false);
  assert.equal(await recordFansObservation(store, lease, { authorId: id(1), fans: 10, at: NOW + 1 }, NOW), false);
  await recordFansObservation(store, lease, { authorId: id(1), author: '小厨', fans: 4000, at: NOW - 2 * DAY, note: { noteId: id(50), title: '蒸蛋', likes: 300, collected: 400, publishedAt: '2026-09-10T00:00:00.000Z' } }, NOW - 2 * DAY);
  await recordFansObservation(store, lease, { authorId: id(1), fans: 5200, at: NOW, note: { noteId: id(50), title: '蒸蛋（更新）', likes: 350, collected: 500 } }, NOW);
  await recordFansObservation(store, lease, { authorId: id(1), fans: 5200, at: NOW }, NOW);
  const doc = await store.get('dfp_results', historyId(id(1)));
  assert.equal(doc.author, '小厨');
  assert.deepEqual(doc.points, [{ at: NOW - 2 * DAY, fans: 4000 }, { at: NOW, fans: 5200 }]);
  assert.deepEqual(doc.recentNotes.map(n => [n.noteId, n.title]), [[id(50), '蒸蛋（更新）']]);
  const index = await store.get('dfp_results', INDEX_ID);
  assert.deepEqual(index.authors[id(1)], { author: '小厨', lastObservedAt: NOW, fans: 5200, gain: 1200, spanMs: 2 * DAY });
});

test('the tracked set is bounded: the least recently observed author is evicted with its history', async () => {
  const { store, lease } = await setup();
  for (let i = 1; i <= RULES.maxTracked; i++) await recordFansObservation(store, lease, { authorId: id(i), fans: 100, at: NOW - (RULES.maxTracked - i) * 60000 }, NOW);
  await recordFansObservation(store, lease, { authorId: id(999), fans: 100, at: NOW }, NOW);
  const index = await store.get('dfp_results', INDEX_ID);
  assert.equal(Object.keys(index.authors).length, RULES.maxTracked);
  assert.equal(index.authors[id(1)], undefined); assert.ok(index.authors[id(999)]);
  assert.equal(await store.get('dfp_results', historyId(id(1))), null);
});

test('re-checks pick the stalest tracked authors, skipping anyone observed within twenty hours', async () => {
  const { store, lease } = await setup();
  await recordFansObservation(store, lease, { authorId: id(1), fans: 100, at: NOW - 30 * HOUR }, NOW);
  await recordFansObservation(store, lease, { authorId: id(2), fans: 100, at: NOW - 21 * HOUR }, NOW);
  await recordFansObservation(store, lease, { authorId: id(3), fans: 100, at: NOW - 19 * HOUR }, NOW);
  await recordFansObservation(store, lease, { authorId: id(4), fans: 100, at: NOW - 3 * DAY }, NOW);
  assert.deepEqual(await selectRecheck(store, NOW, 2), [id(4), id(1)]);
  assert.deepEqual(await selectRecheck(store, NOW), [id(4), id(1), id(2)]);
  assert.deepEqual(await selectRecheck(new MemoryStore(), NOW), []);
});

test('rising accounts need a thousand-follower gain, are ranked by gain, capped and not repeated within seven days', async () => {
  const { store, lease } = await setup();
  const grow = async (n, before, after, span = 2 * DAY) => {
    await recordFansObservation(store, lease, { authorId: id(n), author: `作者${n}`, fans: before, at: NOW - span, note: { noteId: id(100 + n), title: `作品${n}`, likes: 500, collected: 900 } }, NOW - span);
    await recordFansObservation(store, lease, { authorId: id(n), fans: after, at: NOW }, NOW);
  };
  await grow(1, 4000, 5000); await grow(2, 10000, 13000); await grow(3, 8000, 8999); await grow(4, 20000, 21500);
  await recordFansObservation(store, lease, { authorId: id(5), fans: 90000, at: NOW }, NOW);
  await store.put('dfp_results', `rising_published_${id(4)}`, { snapshotId: 'earlier', at: NOW - 6 * DAY });
  const accounts = await risingAccounts(store, NOW);
  assert.deepEqual(accounts.map(a => [a.authorId, a.fansDelta, a.spanHours, a.notes.length]), [[id(2), 3000, 48, 1], [id(1), 1000, 48, 1]]);
  assert.equal(accounts[0].author, '作者2'); assert.equal(accounts[0].fansBefore, 10000); assert.equal(accounts[0].fans, 13000);
  assert.equal(await publishedRecently(store, id(4), NOW), true);
  assert.equal(await publishedRecently(store, id(4), NOW + 2 * DAY), false);
  assert.deepEqual((await risingAccounts(store, NOW, 1)).map(a => a.authorId), [id(2)]);
  // A gain recorded in the index can expire out of the window before the round that would publish it.
  assert.deepEqual((await risingAccounts(store, NOW + 6 * DAY)).map(a => a.authorId), []);
});
