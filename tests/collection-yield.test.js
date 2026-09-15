'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore, NOW } = require('./helpers');
const { claimLease } = require('../cloudfunctions/collectTick/lib/budget');
const { Discovery, source, jobFor, rankSources, admitsSource, sweepKeywords } = require('../cloudfunctions/collectTick/lib/discovery');
const { validateParams } = require('../cloudfunctions/collectTick/lib/provider');
const { prioritizeCandidates } = require('../cloudfunctions/collectTick/lib/runner');
const KEYWORDS = require('../config/keywords/food.json');
const id = n => n.toString(16).padStart(24, '0');
const PRIORITY = KEYWORDS.dailySweep.priorityKeywords;
const SWEEP_AT = Date.parse('2026-09-16T06:00:00+08:00');
const REGULAR_AT = Date.parse('2026-09-16T09:00:00+08:00');

async function start(round, remembered = []) {
  const store = new MemoryStore(); const lease = await claimLease(store, { owner: 'worker', now: NOW });
  await store.put('dfp_rounds', round.id, { status: 'running', definition: round });
  for (const seed of remembered) await store.put('dfp_results', seed.key, { ...seed, expiresAt: NOW + 86400000 });
  const progress = { candidateIds: null, candidateIndex: 0, gaps: [] };
  const discovery = new Discovery({ store, lease, round, progress, clock: () => NOW });
  return { store, lease, round, progress, discovery };
}
const sweepRound = { id: '20260916-0600', kind: 'sweep', scheduledAt: SWEEP_AT, closesAt: SWEEP_AT + 1800000,
  discoveryMode: 'adaptive', discoveryAllocation: 'candidate-reserve-v2', budgetTier: 'expanded250' };
const regularRound = { id: '20260916-0900', kind: 'regular', scheduledAt: REGULAR_AT, closesAt: REGULAR_AT + 1200000,
  discoveryMode: 'adaptive', discoveryAllocation: 'candidate-reserve-v2', budgetTier: 'expanded250', candidateTarget: 20 };
const searchJobs = progress => progress.discovery.jobs.filter(j => j.kind === 'search');

test('search accepts the collect-sorted variant and still rejects unlisted sort orders', () => {
  const base = { keyword: '烘焙', page: 1, time_filter: '一周内', note_type: '视频笔记', source: 'explore_feed', ai_mode: 0 };
  assert.doesNotThrow(() => validateParams('search', { ...base, sort_type: 'collect_descending' }));
  assert.throws(() => validateParams('search', { ...base, sort_type: 'general' }), /INVALID_PARAMETERS/);
  assert.throws(() => validateParams('search', { ...base, sort_type: 'comment_descending' }), /INVALID_PARAMETERS/);
});

test('a collect-sorted seed is its own learnable source and keeps the round time window', () => {
  const plain = source('search', { keyword: '烘焙', note_type: '视频笔记' }, '烘焙', 'keyword', NOW);
  const collect = source('search', { keyword: '烘焙', note_type: '视频笔记', sort_type: 'collect_descending' }, '烘焙', 'keyword', NOW);
  assert.notEqual(plain.key, collect.key);
  assert.equal(jobFor(plain, regularRound).params.sort_type, 'popularity_descending');
  assert.equal(jobFor(collect, regularRound).params.sort_type, 'collect_descending');
  assert.equal(jobFor(collect, sweepRound).params.time_filter, '一天内');
  assert.equal(jobFor(source('search', { keyword: '烘焙', note_type: '视频笔记', sort_type: 'time_descending' }, '烘焙'), regularRound).params.sort_type,
    'popularity_descending');
});

test('sweep keywords start with the audited priority words and never repeat a word', () => {
  const words = sweepKeywords(KEYWORDS);
  assert.deepEqual(words.slice(0, PRIORITY.length), PRIORITY);
  assert.equal(new Set(words).size, words.length);
  assert.ok(KEYWORDS.dailySweep.keywords.every(w => words.includes(w)));
});

test('the 06:00 sweep searches priority keywords as videos only and skips collections and image searches', async () => {
  const remembered = [
    source('search', { keyword: '凉拌菜', note_type: '视频笔记' }, '凉拌菜', 'keyword', NOW),
    source('search', { keyword: '早餐饼', note_type: '普通笔记' }, '早餐饼', 'keyword', NOW),
    source('faved', { user_id: id(1), cursor: '' }, '公开收藏', 'faved', NOW),
    source('user', { user_id: id(1) }, '作者资料', 'faved', NOW),
    source('author', { user_id: id(2) }, '作者', 'author', NOW)
  ];
  const ctx = await start(sweepRound, remembered); await ctx.discovery.init();
  const jobs = ctx.progress.discovery.jobs;
  assert.ok(jobs.every(j => !['faved', 'user'].includes(j.kind)));
  assert.ok(searchJobs(ctx.progress).every(j => j.params.note_type === '视频笔记' && j.params.time_filter === '一天内'
    && j.params.sort_type === 'popularity_descending'));
  const keywords = searchJobs(ctx.progress).map(j => j.params.keyword);
  for (const word of PRIORITY) assert.ok(keywords.includes(word), word);
  assert.ok(keywords.includes('凉拌菜') && !keywords.includes('早餐饼'));
  assert.ok(jobs.some(j => j.kind === 'author'));
  assert.equal(new Set(keywords).size, keywords.length);
  assert.equal(admitsSource(regularRound, remembered[1]), true);
});

test('a proven priority keyword runs before untried sources, and every rotating sweep word gets a turn', async () => {
  const proven = source('search', { keyword: PRIORITY[2], note_type: '视频笔记' }, PRIORITY[2], 'keyword', NOW);
  const ctx = await start(sweepRound, [proven]);
  await ctx.store.put('dfp_results', 'source_statistics_v1', { sources: { [proven.key]: { requests: 3, candidates: 6, resolved: 3, accepted: 2, lastUsedAt: NOW } } });
  await ctx.discovery.init();
  const jobs = ctx.progress.discovery.jobs;
  const untriedAuthor = jobs.findIndex(j => j.kind === 'author');
  assert.equal(jobs[0].params.keyword, PRIORITY[2]);
  assert.ok(untriedAuthor === -1 || untriedAuthor > jobs.findIndex(j => j.params.keyword === PRIORITY[0]));
  const rotatingWords = sweepKeywords(KEYWORDS).filter(w => !PRIORITY.includes(w));
  const seen = new Set();
  for (let day = 0; day < rotatingWords.length; day++) {
    const at = SWEEP_AT + day * 86400000;
    const daily = await start({ ...sweepRound, id: `sweep-${day}`, scheduledAt: at, closesAt: at + 1800000 });
    await daily.discovery.init();
    for (const job of searchJobs(daily.progress)) if (rotatingWords.includes(job.params.keyword)) seen.add(job.params.keyword);
  }
  assert.equal(seen.size, rotatingWords.length);
});

test('regular rounds try each rotating keyword as video, image and collect-sorted video', async () => {
  const ctx = await start(regularRound); await ctx.discovery.init();
  const fixed = searchJobs(ctx.progress).filter(j => j.origin === 'keyword');
  const byKeyword = new Map();
  for (const job of fixed) byKeyword.set(job.params.keyword, [...(byKeyword.get(job.params.keyword) || []), `${job.params.note_type}/${job.params.sort_type}`]);
  assert.equal(byKeyword.size, 2);
  for (const variants of byKeyword.values()) {
    assert.deepEqual([...variants].sort(), ['普通笔记/popularity_descending', '视频笔记/collect_descending', '视频笔记/popularity_descending']);
  }
  assert.ok(searchJobs(ctx.progress).every(j => j.params.time_filter === '一周内'));
});

test('exploit rounds prefer proven sources over untried ones, and empty sources rank last', () => {
  const proven = source('search', { keyword: '面食', note_type: '视频笔记' }, '面食', 'keyword', NOW);
  const untried = source('author', { user_id: id(5) }, '新作者', 'author', NOW);
  const empty = source('faved', { user_id: id(6), cursor: '' }, '空收藏', 'faved', NOW);
  const stats = { [proven.key]: { requests: 18, candidates: 18, resolved: 10, accepted: 2, lastUsedAt: NOW },
    [empty.key]: { requests: 2, candidates: 0, resolved: 0, accepted: 0, lastUsedAt: NOW - 1 } };
  assert.deepEqual(rankSources([empty, untried, proven], stats, NOW, false).map(s => s.label), ['面食', '新作者', '空收藏']);
  assert.deepEqual(rankSources([empty, untried, proven], stats, NOW, true).map(s => s.label), ['新作者', '空收藏', '面食']);
});

test('saved-to-liked ratio moves likely recipes ahead of high-like notes without text clues', () => {
  const row = (n, patch) => ({ note: { noteId: id(n), authorId: id(n + 50), type: 'video', title: '晚餐', desc: '今天吃这个',
    publishedAt: new Date(NOW - 2 * 86400000).toISOString(), likes: 500, collected: null, fans: null, ...patch } });
  const loud = row(1, { likes: 50000, collected: 2000 });
  const recipeLike = row(2, { likes: 3000, collected: 2400 });
  const middling = row(3, { likes: 800, collected: 300 });
  const unknown = row(4, { likes: 900, collected: null });
  const zeroLikes = row(5, { likes: 0, collected: 10 });
  // Within one level the inherited ordering alternates the most and least liked notes, hence 1, 5, 4 at the tail.
  assert.deepEqual(prioritizeCandidates([loud, unknown, middling, recipeLike, zeroLikes]).map(x => x.note.noteId),
    [id(2), id(3), id(1), id(5), id(4)]);
  // Written ingredients with a quantity (three clue points) still outrank a ratio alone (two points).
  const textClue = row(6, { likes: 100, collected: 5, desc: '食材：鸡蛋2个' });
  assert.deepEqual(prioritizeCandidates([textClue, recipeLike]).map(x => x.note.noteId), [id(6), id(2)]);
  const bareClue = row(7, { likes: 100, collected: 5, title: '教程' });
  assert.deepEqual(prioritizeCandidates([bareClue, recipeLike]).map(x => x.note.noteId), [id(2), id(7)]);
});

test('sparse refills follow the same variants: video-only priority words for the sweep, three variants for regular rounds', async () => {
  const note = { noteId: id(9), authorId: id(10), author: '作者', title: '教你做面包', desc: '面粉加水搅拌。', type: 'video', likes: 20000,
    collected: 100, fans: null, publishedAt: new Date(SWEEP_AT - 3600000).toISOString(), fetchedAt: new Date(NOW).toISOString(), bodyComplete: false };
  const provider = { request: async () => ({ notes: [note] }), notes: async r => r.notes };
  const sweep = await start(sweepRound); await sweep.discovery.init(); sweep.progress.discovery.jobs = [];
  await sweep.discovery.step(provider);
  const appended = searchJobs(sweep.progress);
  assert.ok(appended.length >= 12 && appended.every(j => j.params.note_type === '视频笔记'));
  assert.equal(appended[0].params.keyword, PRIORITY[0]);
  const regular = await start(regularRound); await regular.discovery.init(); regular.progress.discovery.jobs = [];
  await regular.discovery.step(provider);
  assert.deepEqual(searchJobs(regular.progress).slice(0, 3).map(j => `${j.params.note_type}/${j.params.sort_type}`),
    ['视频笔记/popularity_descending', '普通笔记/popularity_descending', '视频笔记/collect_descending']);
});
