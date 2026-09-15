'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore, NOW, PRICE } = require('./helpers');
const { runTick } = require('../cloudfunctions/collectTick/lib/runner');
const { Provider, digest } = require('../cloudfunctions/collectTick/lib/provider');
const { parseJudgment } = require('../cloudfunctions/collectTick/lib/judge');
const { contentTier, publicNote } = require('../cloudfunctions/collectTick/lib/publisher');
const { boards, card, UNCONFIRMED_REASON } = require('../miniprogram/lib/view');
const { claimLease } = require('../cloudfunctions/collectTick/lib/budget');
const { readSnapshot, publish } = require('../cloudfunctions/collectTick/lib/publisher');
const id = n => n.toString(16).padStart(24, '0');
const base = { enabled: true, freeAiConfirmed: true, dailyCalls: 50, dailyMicroUsd: 500000,
  validationCalls: 20, validationMicroUsd: 200000, maxAiCallsPerRound: 20, discoveryMode: 'adaptive',
  vision: { enabled: false, dailyMicroCny: 500000, roundCalls: 3, validationCalls: 6, validationMicroCny: 200000 } };
const raw = (n, patch = {}) => ({ id: id(n), user: { userid: id(100 + n), nickname: `作者${n}` }, type: 'video',
  time: (NOW - 2 * 86400000) / 1000, liked_count: 15000, collected_count: 900, title: '一盘菜', desc: '', ...patch });
const response = data => Response.json({ code: 200, data: { success: true, code: 0, data } });
const note = (patch = {}) => ({ type: 'video', title: '清炖牛腱肉', desc: '一梨润三秋，这碗银耳雪梨羹真是温润顺滑。', bodyComplete: true, ...patch });

test('a rejection must quote an exclusion cue, whichever field it came from', () => {
  const body = note();
  // Praise quoted from the body used to reject a real recipe; it now reads as unproven instead.
  const vague = parseJudgment(JSON.stringify({ verdict: 'not_cooking', evidence: '这碗银耳雪梨羹真是温润顺滑', evidenceSource: 'desc' }), body);
  assert.equal(vague.verdict, 'uncertain'); assert.equal(vague.reason, 'exclusion_without_cue');
  const cued = note({ desc: '今天带你探店这家川菜馆，全程没下厨。' });
  const real = parseJudgment(JSON.stringify({ verdict: 'not_cooking', evidence: '今天带你探店这家川菜馆', evidenceSource: 'desc' }), cued);
  assert.equal(real.verdict, 'not_cooking');
  const petAd = note({ desc: '喵铮铮这款猫条有香香乳鸽莓莓。' });
  assert.equal(parseJudgment(JSON.stringify({ verdict: 'not_cooking', evidence: '喵铮铮这款猫条', evidenceSource: 'desc' }), petAd).verdict, 'not_cooking');
  // A cooking verdict keeps its own evidence rules.
  const recipe = note({ desc: '鸡蛋2个加水搅匀，蒸十分钟。' });
  assert.equal(parseJudgment(JSON.stringify({ verdict: 'cooking', evidence: '鸡蛋2个加水搅匀', evidenceSource: 'desc' }), recipe).verdict, 'cooking');
});

function setup({ items, generate, visionError = false, vision = false }) {
  const store = new MemoryStore(); const calls = [];
  const deps = { store, config: { ...base, vision: { ...base.vision, enabled: vision } }, key: 'fixture-key', clock: () => NOW, verify: async () => PRICE,
    generate, review: async () => visionError ? { verdict: 'error', reason: 'VISION_UNAVAILABLE' }
      : { verdict: 'cooking', evidenceSource: 'frames', evidence: [{ frame: 1, observation: '加水搅拌' }, { frame: 2, observation: '加热煮熟' }] },
    makeProvider: options => new Provider({ ...options, fetcher: async url => {
      const kind = new URL(url).pathname.split('/').at(-1); calls.push(kind);
      if (kind === 'get_creator_hot_inspiration_feed') return response({ items: [] });
      if (kind === 'get_creator_inspiration_feed') return response({ inspirations: [] });
      if (kind === 'search_notes') return response({ items: items.map(note => ({ note })) });
      if (kind === 'get_video_note_detail') return response([{ note_list: items }]);
      if (kind === 'get_user_info') return response({ fans: 4000 });
      throw Error('UNEXPECTED_REQUEST');
    } }) };
  return { store, deps, calls };
}
async function run(deps) { let result; for (let i = 0; i < 8; i++) { result = await runTick(deps); if (result.status !== 'running') break; } return result; }

test('an unproven work is published beside a confirmed one, while an evidenced exclusion is dropped', async () => {
  const items = [raw(1, { desc: '鸡蛋2个加水搅匀，蒸十分钟。' }), raw(2, { title: '清炖牛腱肉', desc: '' }),
    raw(3, { title: '探店日记', desc: '今天带你探店这家川菜馆，全程没下厨。' })];
  const x = setup({ items, generate: async messages => {
    const n = JSON.parse(messages[1].content);
    if (n.desc.includes('搅匀')) return JSON.stringify({ verdict: 'cooking', evidence: '鸡蛋2个加水搅匀', evidenceSource: 'desc' });
    if (n.desc.includes('探店')) return JSON.stringify({ verdict: 'not_cooking', evidence: '今天带你探店这家川菜馆', evidenceSource: 'desc' });
    return JSON.stringify({ verdict: 'uncertain', evidence: '' });
  } });
  const result = await run(x.deps);
  assert.ok(['complete', 'partial'].includes(result.status), result.status);
  const snapshot = await readSnapshot(x.store, result.snapshotId);
  assert.deepEqual(snapshot.notes.map(n => [n.noteId, n.contentStatus]).sort(),
    [[id(1), 'confirmed'], [id(2), 'unconfirmed']]);
  assert.equal(snapshot.notes.find(n => n.noteId === id(2)).contentReason, 'steps_in_video');
  const rejected = await x.store.get('dfp_candidates', `20260912-0900_${id(3)}`);
  assert.equal(rejected.stage, 'skipped'); assert.equal(rejected.outcome, 'rejected_content');
  // Source statistics separate a page entry from a proven one.
  const rows = await x.store.list('dfp_candidates', { filters: { roundId: '20260912-0900' } });
  assert.deepEqual(rows.map(r => r.outcome).sort(), ['accepted', 'rejected_content', 'unconfirmed']);
});

test('an unreadable video is published as unconfirmed with the reason the reader sees', async () => {
  const items = [raw(1, { desc: '鸡蛋2个加水搅匀，蒸十分钟。' }), raw(2, { title: '牛腱肉', desc: '' })];
  const x = setup({ items, vision: true, visionError: true,
    generate: async messages => JSON.parse(messages[1].content).desc.includes('搅匀')
      ? JSON.stringify({ verdict: 'cooking', evidence: '鸡蛋2个加水搅匀', evidenceSource: 'desc' })
      : JSON.stringify({ verdict: 'uncertain', evidence: '' }) });
  const result = await run(x.deps);
  const snapshot = await readSnapshot(x.store, result.snapshotId);
  const unproven = snapshot.notes.find(n => n.noteId === id(2));
  assert.equal(unproven.contentStatus, 'unconfirmed');
  assert.equal(unproven.contentReason, 'vision_unavailable');
  assert.ok(Object.hasOwn(UNCONFIRMED_REASON, unproven.contentReason));
});

test('a round that confirmed nothing because the judgment service failed keeps the previous snapshot', async () => {
  const items = [raw(1, { title: '牛腱肉', desc: '' }), raw(2, { title: '排骨', desc: '' })];
  const x = setup({ items, generate: async () => { throw Error('service unavailable'); } });
  await x.store.put('dfp_state', 'latest', { snapshotId: 'old' });
  const result = await run(x.deps);
  assert.equal(result.status, 'failed');
  assert.equal((await x.store.get('dfp_state', 'latest')).snapshotId, 'old');
  const rows = await x.store.list('dfp_candidates', { filters: { roundId: '20260912-0900' } });
  assert.ok(rows.every(r => r.outcome !== 'rejected_content'));
});

test('works inspected before the tiers existed still publish on their verdict alone', async () => {
  const store = new MemoryStore(); const lease = await claimLease(store, { owner: 'worker', now: NOW });
  const round = { id: '20260912-0900', scheduledAt: NOW - 120000, validation: false };
  await store.put('dfp_rounds', round.id, { status: 'running' });
  const legacy = { noteId: id(9), authorId: id(19), title: '蒸蛋', type: 'normal', likes: 2000, boards: ['today'],
    judgment: { verdict: 'cooking', evidence: '加水蒸熟' } };
  assert.equal(contentTier(legacy), 'confirmed');
  assert.equal(contentTier({ ...legacy, judgment: { verdict: 'uncertain' } }), null);
  assert.equal(contentTier({ ...legacy, contentStatus: 'unconfirmed', judgment: { verdict: 'uncertain' } }), 'unconfirmed');
  const snapshot = await publish({ store, lease, round, now: NOW, notes: [legacy], status: 'complete', coverage: {}, successfulSearches: 1 });
  assert.deepEqual((await readSnapshot(store, snapshot.id)).notes.map(n => [n.noteId, n.contentStatus]), [[id(9), 'confirmed']]);
  assert.equal(publicNote({ ...legacy, contentStatus: 'unconfirmed', contentReason: 'steps_in_video' }).contentReason, 'steps_in_video');
});

test('a board leads with confirmed works and labels the unconfirmed ones', () => {
  const entry = (n, patch) => ({ noteId: id(n), title: `作品${n}`, author: '作者', type: 'video', publishedAt: '2026-09-14T02:00:00.000Z',
    likes: 1000 * n, collected: 100, comments: 10, fans: null, ratio: null, fanRatio: null, collectRatio: 0.1,
    baseline: null, boards: ['week'], contentStatus: 'confirmed', contentReason: null, ...patch });
  const views = boards([entry(1, { contentStatus: 'unconfirmed', contentReason: 'steps_in_video' }), entry(2), entry(3, { contentStatus: 'unconfirmed', contentReason: 'video_unreadable' })],
    {}, () => false, []);
  const week = views.find(v => v.key === 'week');
  assert.deepEqual(week.cards.map(c => c.noteId), [id(2), id(3), id(1)]);
  assert.deepEqual(week.cards.map(c => c.statusLabel), ['', '未确认做法', '未确认做法']);
  assert.equal(week.cards[1].statusHint, '视频画面没读到');
  assert.equal(week.count, 3);
  // An unknown or missing reason still reads as a sentence rather than a code.
  assert.equal(card(entry(4, { contentStatus: 'unconfirmed', contentReason: 'something_new' }), 'week', 'likes', false).statusHint, '还没确认是做法内容');
  assert.equal(card(entry(5), 'week', 'likes', false).unconfirmed, false);
});
