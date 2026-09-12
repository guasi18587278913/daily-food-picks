'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApi, createPoller, shouldFollowLatest, copySource } = require('../miniprogram/lib/api');
const { createFavorites } = require('../miniprogram/lib/favorites');
const { formatMetric, sortNotes } = require('../miniprogram/lib/view');
const id = n => String(n).padStart(24, '0');

test('refresh only calls catalog and rejects a business error even when transport succeeds', async () => {
  const called = [];
  const api = createApi(async options => { called.push(options); return { result: { ok: false, error: { code: 'FORBIDDEN', message: '暂未开通' } } }; });
  await assert.rejects(api('status'), e => e.code === 'FORBIDDEN');
  assert.deepEqual(called.map(x => x.name), ['catalog']);
  const successful = createApi(async () => ({ result: { ok: true, data: { revision: 'new' } } }));
  assert.equal((await successful('status')).revision, 'new');
});
test('returning to the page checks immediately and hiding clears the 60 second polling timer', async () => {
  let checks = 0; const timers = new Set();
  const poller = createPoller(async () => { checks++; }, {
    setInterval: (_callback, ms) => { assert.equal(ms, 60000); timers.add(1); return 1; },
    clearInterval: handle => timers.delete(handle)
  });
  await poller.show(); assert.equal(checks, 1); assert.equal(timers.size, 1);
  poller.hide(); assert.equal(timers.size, 0);
  await poller.show(); assert.equal(checks, 2);
  poller.hide();
});
test('historical reading and favorites are not forcibly replaced by a newer round', () => {
  assert.equal(shouldFollowLatest({ mode: 'round', snapshotId: 'old' }, 'old'), true);
  assert.equal(shouldFollowLatest({ mode: 'round', snapshotId: 'older' }, 'old'), false);
  assert.equal(shouldFollowLatest({ mode: 'favorites', snapshotId: 'old' }, 'old'), false);
});
test('favorites survive reopen; failed writes do not claim success; corrupt storage is reported', () => {
  let saved; const storage = { get: () => saved, set: value => { saved = value; } };
  const first = createFavorites(storage); assert.equal(first.toggle(id(1)).ok, true);
  const reopened = createFavorites(storage); assert.equal(reopened.has(id(1)), true);
  assert.equal(reopened.toggle(id(1)).ok, true); assert.equal(reopened.has(id(1)), false);
  const failed = createFavorites({ get: () => ({}), set: () => { throw new Error('full'); } });
  assert.equal(failed.toggle(id(2)).ok, false); assert.equal(failed.has(id(2)), false);
  assert.equal(createFavorites({ get: () => '{broken', set() {} }).corrupt, true);
});
test('null metrics stay unknown and sorting is stable, with unknown values last', () => {
  assert.equal(formatMetric(null), '—'); assert.equal(formatMetric(0), '0');
  const rows = [{ noteId: id(3), likes: null }, { noteId: id(2), likes: 0 }, { noteId: id(1), likes: 0 }];
  assert.deepEqual(sortNotes(rows, 'likes').map(x => x.noteId), [id(1), id(2), id(3)]);
  assert.deepEqual(sortNotes([{ noteId: id(1), ratio: 2 }, { noteId: id(2), ratio: 5 }], 'ratio').map(x => x.noteId), [id(2), id(1)]);
});
test('copy only reports success after the native callback and rejects unsafe or missing links', async () => {
  let requested;
  const result = copySource(`https://www.xiaohongshu.com/explore/${id(1)}`, options => { requested = options; });
  let done = false; result.then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false);
  requested.success(); await result; assert.equal(done, true);
  await assert.rejects(copySource('javascript:alert(1)', () => {}));
  await assert.rejects(copySource(null, () => {}));
  await assert.rejects(copySource(`https://www.xiaohongshu.com/explore/${id(1)}`, options => options.fail()));
});

function pageHarness() {
  let definition;
  global.wx = { cloud: { callFunction: async () => ({}) }, showToast() {} };
  global.Page = value => { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/index/index'); delete require.cache[modulePath]; require(modulePath);
  delete global.Page;
  return { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
}
test('a failed replacement snapshot keeps the current content and identity', async () => {
  const page = pageHarness(); page._currentRoundId = 'old'; page._notes = [{ noteId: id(1) }];
  page._api = async () => { throw new Error('network'); };
  assert.equal(await page.loadRound('new'), false);
  assert.equal(page._currentRoundId, 'old'); assert.equal(page._notes[0].noteId, id(1));
});
test('a pending history selection wins over a concurrently arriving latest-status response', async () => {
  const page = pageHarness(); page._currentRoundId = 'old-latest'; page._latestId = 'old-latest';
  let resolveStatus; let resolveHistory; const requested = [];
  page._api = async (action, params) => {
    if (action === 'status') return new Promise(resolve => { resolveStatus = resolve; });
    if (action === 'getRound') { requested.push(params.snapshotId); return new Promise(resolve => { resolveHistory = resolve; }); }
    return { rounds: [], nextCursor: null };
  };
  const poll = page.checkUpdates();
  const selected = page.loadRound('older-history', 'history');
  resolveStatus({ status: 'complete', snapshotId: 'new-latest' }); await poll;
  resolveHistory({ snapshotId: 'older-history', notes: [], scheduledAt: '2026-09-11T01:00:00Z', finishedAt: '2026-09-11T01:01:00Z', count: 0 });
  await selected;
  assert.deepEqual(requested, ['older-history']); assert.equal(page._currentRoundId, 'older-history');
  assert.equal(page.data.newAvailable, true);
});
test('older status responses cannot roll the latest page back after a newer response is accepted', async () => {
  const page = pageHarness(); page._currentRoundId = 'initial'; page._latestId = 'initial';
  const statuses = []; const loaded = [];
  page._api = async (action, params) => {
    if (action === 'status') return new Promise(resolve => statuses.push(resolve));
    if (action === 'getRound') {
      loaded.push(params.snapshotId);
      return { snapshotId: params.snapshotId, notes: [], scheduledAt: '2026-09-12T01:00:00Z', finishedAt: '2026-09-12T01:01:00Z' };
    }
    return { rounds: [], nextCursor: null };
  };
  const older = page.checkUpdates(); const newer = page.checkUpdates();
  statuses[1]({ status: 'complete', snapshotId: 'B' }); await newer;
  statuses[0]({ status: 'complete', snapshotId: 'A' }); await older;
  assert.equal(page._currentRoundId, 'B'); assert.deepEqual(loaded, ['B']);
});
test('permission denial invalidates older successful data responses', async () => {
  const page = pageHarness(); let resolveRound;
  page._api = async action => {
    if (action === 'getRound') return new Promise(resolve => { resolveRound = resolve; });
    const error = new Error('forbidden'); error.code = 'FORBIDDEN'; throw error;
  };
  const old = page.loadRound('old-success'); await page.checkUpdates();
  assert.equal(page.data.locked, true);
  resolveRound({ snapshotId: 'old-success', notes: [{ noteId: id(1), boards: ['today'] }], scheduledAt: '2026-09-12T01:00:00Z', finishedAt: '2026-09-12T01:01:00Z' });
  await old; assert.equal(page.data.locked, true); assert.equal(page._notes.length, 0);
});
test('clearing an unsubmitted search preserves the current favorites or history view', () => {
  for (const mode of ['favorites', 'history']) {
    const page = pageHarness(); page.data.mode = mode; page.data.query = '鸡蛋';
    page.onClearSearch(); assert.equal(page.data.mode, mode); assert.equal(page.data.query, '');
  }
});
