'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore, LIMITS, PRICE } = require('./helpers');
const { scheduledRound, loadConfig } = require('../cloudfunctions/collectTick/lib/config');
const { runTick, searches } = require('../cloudfunctions/collectTick/lib/runner');
const { Provider, validateParams } = require('../cloudfunctions/collectTick/lib/provider');
const { claimLease, reserveAttempt } = require('../cloudfunctions/collectTick/lib/budget');
const { publish, readSnapshot } = require('../cloudfunctions/collectTick/lib/publisher');

const at = text => Date.parse(text);
const iso = text => new Date(at(text)).toISOString();
const ID = n => n.toString(16).padStart(24, '0');
const SWEEP = { dailyCalls: 150, dailyMicroUsd: 1500000, sweepCalls: 100, validationCalls: 20, validationMicroUsd: 200000 };
const RUN = { ...SWEEP, enabled: true, freeAiConfirmed: true, maxAiCallsPerRound: 20 };
const ENV = { DFP_ENABLED: 'true', DFP_FREE_AI_CONFIRMED: 'true', DFP_TIMER_SECRET: 'a'.repeat(64), DFP_DAILY_CALLS: '150',
  DFP_DAILY_MICRO_USD: '1500000', DFP_VALIDATION_CALLS: '20', DFP_VALIDATION_MICRO_USD: '200000', DFP_SWEEP_CALLS: '100' };
const priceAt = now => ({ ...PRICE, verifiedAt: now - 1000, expiresAt: now + 3600000 });

const TODAY = { noteId: ID(1), authorId: ID(9), title: '炒酸奶', desc: '酸奶加芒果冷冻二十分钟', author: '作者', type: 'video',
  publishedAt: iso('2026-09-13T04:00:00+08:00'), likes: 1500, collected: 300, comments: 20, fans: null, sticky: false };
const WEEK_ONLY = { ...TODAY, noteId: ID(2), publishedAt: iso('2026-09-10T06:00:00+08:00'), likes: 20000 };
const DARK_ONLY = { ...TODAY, noteId: ID(3), publishedAt: iso('2026-09-12T00:00:00+08:00'), likes: 500 };
const HISTORY = Array.from({ length: 8 }, (_, i) => ({ noteId: ID(100 + i), authorId: ID(9),
  publishedAt: new Date(at('2026-09-12T20:00:00+08:00') - i * 3600000).toISOString(), likes: (i + 1) * 100, sticky: false }));

// A fake platform: past-day searches return the given notes and past-week searches return nothing.
function deps(store, now, log, { notes = [TODAY, WEEK_ONLY, DARK_ONLY], config = RUN, detail = note => note } = {}) {
  return { store, config, clock: () => now, verify: async () => priceAt(now),
    generate: async () => '{"verdict":"cooking","evidence":"酸奶加芒果冷冻二十分钟"}',
    makeProvider: () => ({ sent: 0,
      async request(kind, params) { log.push({ kind, params }); return { kind, params }; },
      async notes(result) {
        if (result.kind === 'search') return result.params.time_filter === '一天内' ? notes : [];
        if (result.kind.startsWith('note_')) return notes.filter(n => n.noteId === result.params.note_id).map(n => ({ ...detail(n), bodyComplete: true }));
        if (result.kind === 'author') return HISTORY;
        return [];
      } }) };
}
const runningRound = (kind, extra = {}) => ({ status: 'running', calls: 0, microUsd: 0, day: '2026-09-13', definition: { kind }, ...extra });
function failSnapshotReads(store, snapshotId, times = Infinity) {
  const read = store.get.bind(store); let remaining = times;
  store.get = async (collection, id) => {
    if (collection === 'dfp_snapshots' && id === snapshotId && remaining-- > 0) throw new Error('network reset');
    return read(collection, id);
  };
}

test('an approved 06:00 sweep opens one 30-minute, 100-call round and keeps 17/17/16 for the regular rounds', () => {
  const round = scheduledRound(at('2026-09-13T06:02:00+08:00'), SWEEP);
  assert.deepEqual([round.id, round.kind, round.roundCalls, round.closesAt - round.scheduledAt], ['20260913-0600', 'sweep', 100, 30 * 60000]);
  assert.equal(scheduledRound(at('2026-09-13T06:28:00+08:00'), SWEEP).id, '20260913-0600');
  assert.equal(scheduledRound(at('2026-09-13T06:30:00+08:00'), SWEEP), null);
  assert.deepEqual([9, 12, 20].map(h => scheduledRound(at(`2026-09-13T${String(h).padStart(2, '0')}:02:00+08:00`), SWEEP))
    .map(r => [r.kind, r.roundCalls, r.closesAt - r.scheduledAt]), [['regular', 17, 1200000], ['regular', 17, 1200000], ['regular', 16, 1200000]]);
  assert.equal(scheduledRound(at('2026-09-13T09:20:00+08:00'), SWEEP), null);
});

test('without an approved sweep budget 06:00 opens no paid round', () => {
  assert.equal(scheduledRound(at('2026-09-13T06:02:00+08:00'), { dailyCalls: 50, validationCalls: 20 }), null);
});

test('configuration refuses call or money caps that would silently reshape the day', () => {
  const config = loadConfig(ENV);
  assert.deepEqual([config.dailyCalls, config.dailyMicroUsd, config.sweepCalls], [150, 1500000, 100]);
  assert.equal(loadConfig({ ...ENV, DFP_DAILY_CALLS: '50', DFP_DAILY_MICRO_USD: '500000', DFP_SWEEP_CALLS: '' }).sweepCalls, null);
  for (const patch of [{ DFP_SWEEP_CALLS: '' }, { DFP_SWEEP_CALLS: '101' }, { DFP_SWEEP_CALLS: 'many' }, { DFP_DAILY_CALLS: '151' },
    { DFP_DAILY_MICRO_USD: '1500001' }, { DFP_DAILY_CALLS: '101' }, { DFP_DAILY_MICRO_USD: '500000' }]) {
    assert.throws(() => loadConfig({ ...ENV, ...patch }), /CONFIGURATION_INCOMPLETE/, JSON.stringify(patch));
  }
});

test('a validation time that shares a scheduled window stops configuration loading', () => {
  for (const value of ['2026-09-13T05:50:00+08:00', '2026-09-13T06:10:00+08:00', '2026-09-13T08:45:00+08:00', '2026-09-13T20:19:00+08:00']) {
    assert.throws(() => loadConfig({ ...ENV, DFP_VALIDATION_AT: value }), /INVALID_VALIDATION_TIME/, value);
  }
  assert.doesNotThrow(() => loadConfig({ ...ENV, DFP_VALIDATION_AT: '2026-09-13T16:00:00+08:00' }));
  assert.doesNotThrow(() => loadConfig({ DFP_VALIDATION_AT: '2026-09-13T06:10:00+08:00' }));
});

test('the sweep searches the 55 old-site keywords once each: first page, past day, any note type, by popularity', () => {
  const queries = searches({ id: '20260913-0600', kind: 'sweep', scheduledAt: at('2026-09-13T06:00:00+08:00') });
  assert.equal(queries.length, 55);
  assert.equal(new Set(queries.map(q => q.keyword)).size, 55);
  assert.ok(['甜品烘焙秘方', '教你做道拿手菜', '家常菜', '自制饮品'].every(word => queries.some(q => q.keyword === word)));
  for (const query of queries) {
    assert.deepEqual({ ...query, keyword: undefined }, { keyword: undefined, note_type: '不限', page: 1,
      sort_type: 'popularity_descending', time_filter: '一天内', source: 'explore_feed', ai_mode: 0 });
    assert.doesNotThrow(() => validateParams('search', query));
  }
  const regular = searches({ id: '20260913-0900', kind: 'regular', scheduledAt: at('2026-09-13T09:00:00+08:00') });
  assert.equal(regular.length, 4);
  assert.ok(regular.every(q => q.time_filter === '一周内' && ['视频笔记', '普通笔记'].includes(q.note_type)));
  assert.throws(() => validateParams('search', { ...queries[0], note_type: '全部' }), /INVALID_PARAMETERS/);
});

test('one tick sends at most ten paid requests; the eleventh waits for the next tick without reserving budget', async () => {
  const store = new MemoryStore(); const now = at('2026-09-13T06:02:00+08:00');
  await store.put('dfp_rounds', '20260913-0600', runningRound('sweep'));
  const lease = await claimLease(store, { owner: 'worker', now });
  let sent = 0;
  const fetcher = async () => { sent++; return new Response(JSON.stringify({ code: 200, data: { success: true, code: 0, data: { items: [] } } })); };
  const provider = new Provider({ store, lease, config: RUN, round: { id: '20260913-0600', kind: 'sweep', roundCalls: 100, validation: false },
    price: priceAt(now), key: 'test-key', fetcher, clock: () => now });
  const query = keyword => ({ keyword, note_type: '不限', page: 1, sort_type: 'popularity_descending', time_filter: '一天内', source: 'explore_feed', ai_mode: 0 });
  for (let i = 1; i <= 10; i++) await provider.request('search', query(`词${i}`));
  await assert.rejects(provider.request('search', query('词11')), /TICK_LIMIT/);
  assert.equal(sent, 10);
  assert.equal((await store.get('dfp_budgets', '2026-09-13')).calls, 10);
});

test('the 100-call sweep and the 17/17/16 regular rounds share one 150-call, 1.50-dollar day', async () => {
  const store = new MemoryStore(); const now = at('2026-09-13T06:02:00+08:00');
  const caps = { '20260913-0600': 100, '20260913-0900': 17, '20260913-1200': 17, '20260913-2000': 16 };
  for (const id of Object.keys(caps)) await store.put('dfp_rounds', id, runningRound(id.endsWith('0600') ? 'sweep' : 'regular'));
  const lease = await claimLease(store, { owner: 'worker', now });
  const limits = { ...LIMITS, dailyCalls: 150, dailyMicroUsd: 1500000 };
  const results = await Promise.allSettled(Object.keys(caps).flatMap(roundId => Array.from({ length: 120 }, (_, i) => reserveAttempt(store, {
    roundId, requestKey: `${roundId}-${i}`, kind: 'search', attempt: 1, now, lease, price: priceAt(now), limits: { ...limits, roundCalls: caps[roundId] } }))));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 150);
  assert.deepEqual(await Promise.all(Object.keys(caps).map(async id => (await store.get('dfp_rounds', id)).calls)), [100, 17, 17, 16]);
  const day = await store.get('dfp_budgets', '2026-09-13');
  assert.deepEqual([day.calls, day.microUsd], [150, 1500000]);
});

test('only the 06:00 sweep round may reserve more than twenty calls, whatever limit is passed in', async () => {
  const store = new MemoryStore(); const now = at('2026-09-13T09:02:00+08:00');
  await store.put('dfp_rounds', '20260913-0900', runningRound('regular'));
  const lease = await claimLease(store, { owner: 'worker', now });
  const limits = { ...LIMITS, dailyCalls: 150, dailyMicroUsd: 1500000, roundCalls: 100 };
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => reserveAttempt(store, {
    roundId: '20260913-0900', requestKey: `regular-${i}`, kind: 'search', attempt: 1, now, lease, price: priceAt(now), limits })));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 20);
  assert.ok(results.filter(x => x.status === 'rejected').every(x => x.reason.code === 'ROUND_BUDGET'));
});

test('with the real provider the sweep resumes across ticks, sends at most ten requests per tick and stops at 100 calls', async () => {
  const store = new MemoryStore(); const now = at('2026-09-13T06:02:00+08:00');
  const raw = i => ({ id: ID(1000 + i), type: 'video', user: { userid: ID(5000 + i), nickname: `作者${i}` }, title: `蒸蛋${i}`,
    desc: `鸡蛋${i}个加温水蒸十分钟`, liked_count: 2000 + i, collected_count: 10, comments_count: 1, timestamp: Math.floor((now - 3600000) / 1000) });
  const reply = data => new Response(JSON.stringify({ code: 200, data: { success: true, code: 0, data } }));
  let sentThisTick = 0; let mostInOneTick = 0; let sent = 0;
  const fetcher = async url => {
    sentThisTick++; sent++; mostInOneTick = Math.max(mostInOneTick, sentThisTick);
    if (url.pathname.endsWith('/search_notes')) {
      return reply({ items: url.searchParams.get('keyword') === '美食教程' ? Array.from({ length: 50 }, (_, i) => ({ note: raw(i) })) : [] });
    }
    if (url.pathname.endsWith('/get_video_note_detail')) return reply([{ note_list: [raw(Number.parseInt(url.searchParams.get('note_id'), 16) - 1000)] }]);
    return reply({ notes: [], has_more: false });
  };
  const tick = { store, config: { ...RUN, maxAiCallsPerRound: 40 }, key: 'test-key', clock: () => now, verify: async () => priceAt(now),
    generate: async messages => JSON.stringify({ verdict: 'cooking', evidence: JSON.parse(messages[1].content).desc }),
    makeProvider: options => new Provider({ ...options, fetcher }) };
  let result; let ticks = 0;
  do { sentThisTick = 0; result = await runTick(tick); ticks++; } while (result.status === 'running' && ticks < 30);
  assert.equal(result.status, 'partial');
  assert.ok(ticks > 6);
  assert.equal(mostInOneTick, 10);
  assert.equal(sent, 100);
  assert.equal((await store.get('dfp_rounds', '20260913-0600')).calls, 100);
  assert.deepEqual([(await store.get('dfp_budgets', '2026-09-13')).calls, (await store.list('dfp_attempts')).length], [100, 100]);
  const snapshot = await readSnapshot(store, result.snapshotId);
  assert.equal(snapshot.count, 22);
  assert.ok(['CANDIDATE_CAP', 'ROUND_BUDGET'].every(gap => snapshot.coverage.gaps.includes(gap)));
});

test('the 06:00 sweep admits only today candidates and publishes them', async () => {
  const store = new MemoryStore(); const log = [];
  const result = await runTick(deps(store, at('2026-09-13T06:02:00+08:00'), log));
  const sent = log.filter(x => x.kind === 'search');
  assert.equal(sent.length, 55);
  assert.ok(sent.every(x => x.params.time_filter === '一天内' && x.params.note_type === '不限'));
  const candidates = await store.list('dfp_candidates', { filters: { roundId: '20260913-0600' } });
  assert.deepEqual(candidates.map(x => x.note.noteId), [TODAY.noteId]);
  assert.equal(result.status, 'complete');
  const snapshot = await readSnapshot(store, result.snapshotId);
  assert.deepEqual(snapshot.boards, { today: 1, week: 0, dark: 0 });
  assert.equal(snapshot.coverage.keywords.length, 55);
});

test('a sweep candidate whose detail shows it is older than a day is skipped before judgment or fan lookups', async () => {
  const store = new MemoryStore(); const log = []; let judged = 0;
  const tick = deps(store, at('2026-09-13T06:02:00+08:00'), log, { notes: [TODAY], detail: note => ({ ...note, publishedAt: iso('2026-09-12T00:00:00+08:00') }) });
  const result = await runTick({ ...tick, generate: async () => { judged++; return '{"verdict":"cooking","evidence":"酸奶加芒果冷冻二十分钟"}'; } });
  assert.equal(result.status, 'complete');
  assert.equal(judged, 0);
  assert.equal(log.filter(x => x.kind === 'user').length, 0);
  assert.equal((await store.get('dfp_candidates', `20260913-0600_${TODAY.noteId}`)).stage, 'skipped');
  assert.equal((await readSnapshot(store, result.snapshotId)).count, 0);
});

test('later rounds that day keep showing the 06:00 today picks without recommending them again', async () => {
  const store = new MemoryStore(); const log = [];
  const sweep = await runTick(deps(store, at('2026-09-13T06:02:00+08:00'), log));
  const morning = await runTick(deps(store, at('2026-09-13T09:02:00+08:00'), log));
  assert.equal(morning.status, 'complete');
  const snapshot = await readSnapshot(store, morning.snapshotId);
  assert.deepEqual(snapshot.notes.map(n => [n.noteId, n.boards, n.firstRoundId]), [[TODAY.noteId, ['today'], '20260913-0600']]);
  assert.deepEqual(snapshot.coverage.carriedToday, { snapshotId: sweep.snapshotId, count: 1 });
  assert.equal((await store.get('dfp_candidates', `published_${TODAY.noteId}`)).snapshotId, sweep.snapshotId);
  assert.equal((await store.list('dfp_notes')).filter(row => row.snapshotId === morning.snapshotId).length, 0);
  assert.equal((await store.get('dfp_state', 'latest')).snapshotId, morning.snapshotId);
});

test('a 06:00 pick that also crosses the week threshold keeps both boards for the rest of the day', async () => {
  const store = new MemoryStore(); const log = []; const hot = { ...TODAY, likes: 12000 };
  const sweep = await runTick(deps(store, at('2026-09-13T06:02:00+08:00'), log, { notes: [hot] }));
  assert.deepEqual((await readSnapshot(store, sweep.snapshotId)).boards, { today: 1, week: 1, dark: 0 });
  const morning = await runTick(deps(store, at('2026-09-13T09:02:00+08:00'), log, { notes: [hot] }));
  const snapshot = await readSnapshot(store, morning.snapshotId);
  assert.deepEqual(snapshot.notes.map(n => n.boards), [['today', 'week']]);
  assert.deepEqual(snapshot.boards, { today: 1, week: 1, dark: 0 });
});

test('the next day does not carry yesterday’s picks and reports that its own 06:00 sweep is missing', async () => {
  const store = new MemoryStore(); const log = [];
  await runTick(deps(store, at('2026-09-13T06:02:00+08:00'), log));
  const next = await runTick(deps(store, at('2026-09-14T09:02:00+08:00'), log));
  assert.equal(next.status, 'partial');
  const snapshot = await readSnapshot(store, next.snapshotId);
  assert.equal(snapshot.notes.length, 0);
  assert.deepEqual(snapshot.coverage.carriedToday, { snapshotId: null, count: 0, errorCode: 'SWEEP_MISSING' });
});

test('an unpublished 06:00 sweep is reported by later rounds, while a day without a sweep budget expects none', async () => {
  const store = new MemoryStore(); const log = [];
  await store.put('dfp_rounds', '20260913-0600', { status: 'failed', definition: { id: '20260913-0600', kind: 'sweep' } });
  const morning = await runTick(deps(store, at('2026-09-13T09:02:00+08:00'), log));
  assert.equal(morning.status, 'partial');
  const reported = await readSnapshot(store, morning.snapshotId);
  assert.match(reported.partialReason, /06:00/);
  assert.deepEqual(reported.coverage.carriedToday, { snapshotId: null, count: 0, errorCode: 'SWEEP_NOT_PUBLISHED' });
  const plain = new MemoryStore();
  const disabled = await runTick(deps(plain, at('2026-09-13T12:02:00+08:00'), log, { config: { ...RUN, dailyCalls: 50, dailyMicroUsd: 500000, sweepCalls: null } }));
  assert.equal(disabled.status, 'complete');
  assert.equal((await readSnapshot(plain, disabled.snapshotId)).coverage.carriedToday, null);
});

test('an unreadable 06:00 snapshot is reported as partial and does not block the regular round', async () => {
  const store = new MemoryStore(); const log = [];
  const sweep = await runTick(deps(store, at('2026-09-13T06:02:00+08:00'), log));
  const manifest = await store.get('dfp_snapshots', sweep.snapshotId);
  await store.put('dfp_parts', manifest.parts[0].id, { notes: [] });
  const noon = await runTick(deps(store, at('2026-09-13T12:02:00+08:00'), log));
  assert.equal(noon.status, 'partial');
  const snapshot = await readSnapshot(store, noon.snapshotId);
  assert.equal(snapshot.notes.length, 0);
  assert.match(snapshot.partialReason, /06:00/);
  assert.ok(snapshot.coverage.gaps.includes('CARRY_UNAVAILABLE'));
  assert.deepEqual(snapshot.coverage.carriedToday, { snapshotId: sweep.snapshotId, count: 0, errorCode: 'CORRUPT_SNAPSHOT' });
});

test('a single failed read of the 06:00 picks is retried on the next tick instead of publishing without them', async () => {
  const store = new MemoryStore(); const log = [];
  const sweep = await runTick(deps(store, at('2026-09-13T06:02:00+08:00'), log));
  failSnapshotReads(store, sweep.snapshotId, 1);
  assert.equal((await runTick(deps(store, at('2026-09-13T09:02:00+08:00'), log))).status, 'running');
  assert.equal((await store.get('dfp_state', 'latest')).snapshotId, sweep.snapshotId);
  const retried = await runTick(deps(store, at('2026-09-13T09:04:00+08:00'), log));
  assert.equal(retried.status, 'complete');
  assert.deepEqual((await readSnapshot(store, retried.snapshotId)).coverage.carriedToday, { snapshotId: sweep.snapshotId, count: 1 });
});

test('a malformed manifest is reported at once, and a read that keeps failing publishes only when the window ends', async () => {
  const store = new MemoryStore(); const log = [];
  const sweep = await runTick(deps(store, at('2026-09-13T06:02:00+08:00'), log));
  const manifest = await store.get('dfp_snapshots', sweep.snapshotId);
  await store.put('dfp_snapshots', sweep.snapshotId, { ...manifest, parts: 'broken' });
  const morning = await runTick(deps(store, at('2026-09-13T09:02:00+08:00'), log));
  assert.equal(morning.status, 'partial');
  assert.equal((await readSnapshot(store, morning.snapshotId)).coverage.carriedToday.errorCode, 'CORRUPT_SNAPSHOT');
  await store.put('dfp_snapshots', sweep.snapshotId, manifest);
  failSnapshotReads(store, sweep.snapshotId);
  assert.equal((await runTick(deps(store, at('2026-09-13T12:02:00+08:00'), log))).status, 'running');
  await runTick(deps(store, at('2026-09-13T12:20:00+08:00'), log));
  const noon = await store.get('dfp_rounds', '20260913-1200');
  assert.equal(noon.status, 'partial');
  const snapshot = await readSnapshot(store, noon.snapshotId);
  assert.equal(snapshot.coverage.carriedToday.errorCode, 'CARRY_READ_FAILED');
  assert.ok(snapshot.coverage.gaps.includes('CARRY_UNAVAILABLE'));
  assert.ok(!snapshot.coverage.gaps.includes('WINDOW_ENDED'));
});

test('a failed read is not retried when the round ends for another reason or within its last ten seconds', async () => {
  const { conclude } = require('../cloudfunctions/collectTick/lib/runner');
  for (const [reason, time] of [['ROUND_BUDGET', '2026-09-13T09:05:00+08:00'], [undefined, '2026-09-13T09:19:55+08:00']]) {
    const store = new MemoryStore(); const now = at(time);
    const sweep = await runTick(deps(store, at('2026-09-13T06:02:00+08:00'), []));
    failSnapshotReads(store, sweep.snapshotId);
    const round = scheduledRound(at('2026-09-13T09:02:00+08:00'), SWEEP);
    const note = { ...WEEK_ONLY, noteId: ID(7), boards: ['week'], judgment: { verdict: 'cooking', evidence: '酸奶加芒果冷冻二十分钟' } };
    await store.put('dfp_rounds', round.id, { status: 'running', definition: round, closesAt: round.closesAt, calls: 0, microUsd: 0, day: round.day });
    await store.put('dfp_candidates', `${round.id}_${note.noteId}`, { roundId: round.id, stage: 'done', note });
    const lease = await claimLease(store, { owner: 'worker', now });
    const progress = { searchIndex: 4, successfulSearches: 4, candidateIds: [note.noteId], candidateIndex: 1, aiCalls: 1, gaps: [] };
    const result = await conclude({ store, lease, round, progress, reason, clock: () => now });
    assert.equal(result.status, 'partial', time);
    const snapshot = await readSnapshot(store, result.snapshotId);
    assert.deepEqual([snapshot.count, snapshot.coverage.carriedToday.errorCode], [1, 'CARRY_READ_FAILED'], time);
    assert.ok(snapshot.coverage.gaps.includes('CARRY_UNAVAILABLE'), time);
  }
});

test('reaching the per-round judgment cap is reported as its own reason, not as a model outage', async () => {
  const store = new MemoryStore(); const log = [];
  const second = { ...TODAY, noteId: ID(4), authorId: ID(8), likes: 1400 };
  const result = await runTick(deps(store, at('2026-09-13T06:02:00+08:00'), log, { notes: [TODAY, second], config: { ...RUN, maxAiCallsPerRound: 1 } }));
  assert.equal(result.status, 'partial');
  const snapshot = await readSnapshot(store, result.snapshotId);
  assert.equal(snapshot.count, 1);
  assert.ok(snapshot.coverage.gaps.includes('AI_CALL_CAP'));
  assert.doesNotMatch(snapshot.partialReason, /不可用/);
});

test('carried notes are shown once without new search rows or recommendation references', async () => {
  const store = new MemoryStore(); const now = at('2026-09-13T09:02:00+08:00');
  const lease = await claimLease(store, { owner: 'worker', now });
  const note = { ...TODAY, boards: ['today'], judgment: { verdict: 'cooking', evidence: '酸奶加芒果冷冻二十分钟' } };
  const sweepRound = { id: '20260913-0600', scheduledAt: at('2026-09-13T06:00:00+08:00') };
  await store.put('dfp_rounds', sweepRound.id, { status: 'running' });
  const first = await publish({ store, lease, round: sweepRound, notes: [note], status: 'complete', coverage: {}, successfulSearches: 1, now });
  const carried = (await readSnapshot(store, first.id)).notes;
  const morningRound = { id: '20260913-0900', scheduledAt: at('2026-09-13T09:00:00+08:00') };
  await store.put('dfp_rounds', morningRound.id, { status: 'running' });
  const fresh = { ...note, noteId: ID(2), boards: ['week'] };
  const second = await publish({ store, lease, round: morningRound, notes: [fresh], carriedNotes: [...carried, ...carried],
    status: 'complete', coverage: {}, successfulSearches: 1, now });
  assert.deepEqual((await readSnapshot(store, second.id)).notes.map(n => [n.noteId, n.firstRoundId]), [[ID(1), '20260913-0600'], [ID(2), '20260913-0900']]);
  assert.equal((await store.get('dfp_candidates', `published_${ID(1)}`)).snapshotId, first.id);
  assert.deepEqual((await store.list('dfp_notes')).filter(row => row.snapshotId === second.id).map(row => row.note.noteId), [ID(2)]);
});
