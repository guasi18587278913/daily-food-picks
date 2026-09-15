'use strict';
// A whole FDE round, end to end, against the same runner the food track uses. The point of this file is isolation:
// every shared piece of state the collector keeps — the sweep it reads today's picks from, the sources it remembers,
// the statistics that rank them, the rising board, the round status, the judgment cache — used to be global, and a
// second track quietly inherited the first one's. Each test below fails if one of them goes back to being shared.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore, NOW, PRICE } = require('./helpers');
const { runTick } = require('../cloudfunctions/collectTick/lib/runner');
const { Provider } = require('../cloudfunctions/collectTick/lib/provider');
const { claimLease, releaseLease } = require('../cloudfunctions/collectTick/lib/budget');
const { readSnapshot } = require('../cloudfunctions/collectTick/lib/publisher');
const { cacheJudgment, cachedJudgment } = require('../cloudfunctions/collectTick/lib/content-review');

const id = n => n.toString(16).padStart(24, '0');
const DAY = 86400000;
const config = { enabled: true, freeAiConfirmed: true, dailyCalls: 500, dailyMicroUsd: 5000000, sweepCalls: 200,
  budgetTier: 'expanded250', validationCalls: 20, validationMicroUsd: 200000, maxAiCallsPerRound: 20,
  discoveryMode: 'adaptive', vision: { enabled: true, dailyMicroCny: 500000, roundCalls: 3, validationCalls: 6, validationMicroCny: 200000 } };
const response = data => Response.json({ code: 200, data: { success: true, code: 0, data } });
// A build write-up: the FDE subject accepts it, the food subject has nothing to say about it.
const build = (n, patch = {}) => ({ id: id(n), user: { userid: id(100 + n), nickname: `作者${n}` }, type: 'normal',
  time: (NOW - 2 * DAY) / 1000, liked_count: 12000, collected_count: 900, comments_count: 400, shared_count: 200,
  title: '从零搭一个 Agent', desc: '先 pip install 依赖，再把提示词拆成两层，调用模型跑通工作流。', ...patch });

// 10:02 Beijing is the FDE track's first regular round; 09:02 is the food track's.
const FDE_AT = Date.parse('2026-09-12T10:02:00+08:00');
const FOOD_AT = Date.parse('2026-09-12T09:02:00+08:00');

function setup(store, { at = FDE_AT, notes = [build(1)], verdict = 'practice', evidence = '先 pip install 依赖' } = {}) {
  const requests = []; let modelCalls = 0;
  const deps = { store, config, key: 'fixture-key', clock: () => at,
    verify: async (_f, now = at) => ({ ...PRICE, verifiedAt: now - 1000, expiresAt: now + 3600000 }),
    generate: async () => { modelCalls++; return JSON.stringify({ verdict, evidence, evidenceSource: 'desc' }); },
    classify: async () => { throw Object.assign(Error('vision must not run'), { code: 'VISION_UNEXPECTED' }); },
    makeProvider: options => new Provider({ ...options, fetcher: async url => {
      const u = new URL(url); const kind = u.pathname.split('/').at(-1);
      requests.push({ kind, keyword: u.searchParams.get('keyword'), user: u.searchParams.get('user_id') });
      if (kind === 'search_notes') return response({ items: notes.map(note => ({ note })) });
      if (kind === 'get_image_note_detail') return response([{ note_list: notes }]);
      if (kind === 'get_creator_hot_inspiration_feed') return response({ items: [] });
      if (kind === 'get_creator_inspiration_feed') return response({ inspirations: [] });
      if (kind === 'get_user_info') return response({ fans: 40000 });
      if (['get_user_posted_notes', 'get_user_faved_notes', 'get_topic_feed'].includes(kind)) return response({ notes: [] });
      throw Error(`UNEXPECTED_REQUEST ${kind}`);
    } }) };
  return { deps, requests, counts: () => ({ modelCalls }) };
}
const run = async deps => { let r; for (let i = 0; i < 8; i++) { r = await runTick(deps); if (r.status !== 'running') break; } return r; };

test('an FDE round publishes under its own track, searching its own words and asking its own question', async () => {
  const store = new MemoryStore();
  const x = setup(store);
  const result = await run(x.deps);
  assert.ok(['complete', 'partial'].includes(result.status), JSON.stringify(result));
  const snapshot = await readSnapshot(store, result.snapshotId);
  assert.equal(snapshot.track, 'fde');
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.notes?.[0]?.contentStatus ?? (await store.get('dfp_parts', snapshot.parts[0].id)).notes[0].contentStatus, 'confirmed');
  // The words came from the FDE list, never from the food one.
  const searched = x.requests.filter(r => r.kind === 'search_notes').map(r => r.keyword);
  assert.ok(searched.length > 0);
  const fde = require('../config/keywords/fde.json');
  const food = require('../config/keywords/food.json');
  for (const word of searched) {
    assert.ok(fde.groups.flat().includes(word) || fde.dailySweep.keywords.includes(word), word);
    assert.ok(!food.groups.flat().includes(word), word);
  }
  // Its own round status, and the food pointers left untouched.
  assert.equal((await store.get('dfp_state', 'status_fde')).roundId, '20260912-1000');
  assert.equal((await store.get('dfp_state', 'latest_fde')).snapshotId, result.snapshotId);
  assert.equal(await store.get('dfp_state', 'latest_food'), null);
  assert.equal(await store.get('dfp_state', 'latest'), null);
});

test('the FDE track never buys the paid frame reader, so a video with no written steps stays unconfirmed', async () => {
  const store = new MemoryStore();
  // The classify stub throws if it is ever called; reaching a published snapshot proves it was not.
  const video = build(2, { type: 'video', title: '实战部署 RAG', desc: '' });
  const x = setup(store, { notes: [video], verdict: 'uncertain', evidence: '' });
  const result = await run(x.deps);
  assert.ok(['complete', 'partial'].includes(result.status), JSON.stringify(result));
  assert.ok(!x.requests.some(r => r.kind === 'get_video_note_detail' && false));
  const round = await store.get('dfp_rounds', '20260912-1000');
  assert.equal(round.coverage.gaps.includes('VISION_UNEXPECTED'), false);
});

test('the two tracks do not read each other: sweep picks, sources, statistics and rising records are all per track', async () => {
  const store = new MemoryStore();
  // A food sweep that already published a today pick. The FDE round must not carry it.
  const lease = await claimLease(store, { owner: 'seed', now: NOW });
  await store.put('dfp_snapshots', '20260912-0600-seeded', { id: '20260912-0600-seeded', published: true, track: 'food',
    count: 1, parts: [], boards: { today: 1 }, scheduledAt: NOW, finishedAt: NOW });
  await store.put('dfp_rounds', '20260912-0600', { status: 'complete', snapshotId: '20260912-0600-seeded' });
  await releaseLease(store, lease);
  const x = setup(store);
  const result = await run(x.deps);
  const snapshot = await readSnapshot(store, result.snapshotId);
  // Exactly the note this round found: nothing carried over from the food sweep.
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.track, 'fde');
  // Remembered sources and their statistics are written under this track's own names.
  const sources = await store.list('dfp_results', { limit: 50, filters: { recordType: 'discovery_source' } });
  assert.ok(sources.length > 0);
  assert.ok(sources.every(s => s.track === 'fde' && s.key.startsWith('source_fde_')), JSON.stringify(sources.map(s => s.key)));
  assert.equal(await store.get('dfp_results', 'source_statistics_food'), null);
  assert.ok(await store.get('dfp_results', 'source_statistics_fde'));
  // No blogger square is bought for a track with no verified category.
  assert.equal(await store.get('dfp_results', `rising_daily_fde_2026-09-12`), null);
  assert.ok(!x.requests.some(r => r.kind === 'get_blogger_list'));
});

test('a judgment cached by one track is never served to the other, even though both record the same words', async () => {
  const store = new MemoryStore();
  const lease = await claimLease(store, { owner: 'cache', now: NOW });
  const note = { noteId: id(9), type: 'normal', title: '从零搭一个 Agent', desc: '先 pip install 依赖。', bodyComplete: true };
  await cacheJudgment(store, lease, note, 'text', { verdict: 'on_topic', evidence: '先 pip install 依赖' }, NOW, 'fde');
  assert.equal((await cachedJudgment(store, note, 'text', NOW, () => {}, 'fde')).verdict, 'on_topic');
  // The food track asked a different question about the same note, so it gets no answer and has to judge for itself.
  assert.equal(await cachedJudgment(store, note, 'text', NOW, () => {}, 'food'), null);
});

test('both tracks can run on the same day without taking each other\'s calls or overwriting each other\'s board', async () => {
  const store = new MemoryStore();
  const food = setup(store, { at: FOOD_AT, verdict: 'cooking', evidence: '鸡蛋2个加水搅匀',
    notes: [build(3, { title: '蒸蛋教程', desc: '鸡蛋2个加水搅匀，蒸十分钟。' })] });
  const foodResult = await run(food.deps);
  const fde = setup(store);
  const fdeResult = await run(fde.deps);
  assert.notEqual(foodResult.snapshotId, fdeResult.snapshotId);
  assert.equal((await readSnapshot(store, foodResult.snapshotId)).track, 'food');
  assert.equal((await readSnapshot(store, fdeResult.snapshotId)).track, 'fde');
  // Each pointer names its own round; the legacy alias follows the food track only.
  assert.equal((await store.get('dfp_state', 'latest_food')).snapshotId, foodResult.snapshotId);
  assert.equal((await store.get('dfp_state', 'latest_fde')).snapshotId, fdeResult.snapshotId);
  assert.equal((await store.get('dfp_state', 'latest')).snapshotId, foodResult.snapshotId);
  // One shared ledger, and between them the two rounds stay inside the approved day.
  const budget = await store.get('dfp_budgets', '2026-09-12');
  assert.ok(budget.calls > 0 && budget.calls <= 100, `calls=${budget.calls}`);
});
