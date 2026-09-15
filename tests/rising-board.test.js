'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { MemoryStore, NOW, PRICE } = require('./helpers');
const { runTick } = require('../cloudfunctions/collectTick/lib/runner');
const { Provider } = require('../cloudfunctions/collectTick/lib/provider');
const { claimLease, releaseLease } = require('../cloudfunctions/collectTick/lib/budget');
const { recordFansObservation, historyId, INDEX_ID, risingFromCurves, growthFromCurve } = require("../cloudfunctions/collectTick/lib/authors");
const { readSnapshot } = require('../cloudfunctions/collectTick/lib/publisher');
const id = n => n.toString(16).padStart(24, '0');
const DAY = 86400000, HOUR = 3600000;
const base = { enabled: true, freeAiConfirmed: true, dailyCalls: 250, dailyMicroUsd: 2500000, sweepCalls: 100, budgetTier: 'expanded250',
  validationCalls: 20, validationMicroUsd: 200000, maxAiCallsPerRound: 20, discoveryMode: 'adaptive',
  vision: { enabled: false, dailyMicroCny: 500000, roundCalls: 3, validationCalls: 6, validationMicroCny: 200000 } };
const raw = (n, patch = {}) => ({ id: id(n), user: { userid: id(100 + n), nickname: `作者${n}` }, type: 'normal',
  time: (NOW - 2 * DAY) / 1000, liked_count: 600, collected_count: 900, comments_count: 60, shared_count: 40, title: '蒸蛋', desc: '鸡蛋2个，加水搅匀，蒸十分钟。', ...patch });
const response = data => Response.json({ code: 200, data: { success: true, code: 0, data } });
async function seed(store, entries) {
  for (const e of entries) {
    const lease = await claimLease(store, { owner: 'seed', now: e.at });
    await recordFansObservation(store, lease, e, e.at);
    await releaseLease(store, lease);
  }
}
function setup(store, { fansByAuthor = {}, userFailure = null, square = [], curves = {}, curveStatus = null } = {}) {
  const userCalls = []; const pgyCalls = [];
  // The quote is re-verified whenever it expires, so a later round in the same fixture gets a fresh one.
  const deps = { store, config: base, key: 'fixture-key', clock: () => NOW,
    verify: async (_fetcher, now = NOW) => ({ ...PRICE, verifiedAt: now - 1000, expiresAt: now + 3600000 }),
    generate: async () => JSON.stringify({ verdict: 'cooking', evidence: '加水搅匀', evidenceSource: 'desc' }),
    makeProvider: opts => new Provider({ ...opts, fetcher: async (url, options) => {
      const u = new URL(url); const kind = u.pathname.split('/').at(-1);
      if (kind === 'get_creator_hot_inspiration_feed') return response({ items: [] });
      if (kind === 'get_creator_inspiration_feed') return response({ inspirations: [] });
      if (kind === 'search_notes') return response({ items: [{ note: raw(1) }] });
      if (kind === 'get_image_note_detail') return response([{ note_list: [raw(1)] }]);
      // Sources the first round remembered are answered empty: this file is about the rising board, not discovery.
      if (['get_user_posted_notes', 'get_user_faved_notes', 'get_topic_feed'].includes(kind)) return response({ notes: [] });
      if (kind === 'get_blogger_list') { pgyCalls.push('list'); return response({ kols: square, total: 5000 }); }
      if (kind === 'get_blogger_fans_history') { const id = JSON.parse(options?.body || '{}').user_id; pgyCalls.push(id);
        if (curveStatus) return new Response('', { status: curveStatus });
        return response({ list: curves[id] || [] }); }
      if (kind === 'get_user_info') {
        const user = u.searchParams.get('user_id'); userCalls.push(user);
        if (userFailure && userFailure.user === user) return new Response('', { status: userFailure.status });
        return response({ fans: fansByAuthor[user] ?? 100, share_link: `https://www.xiaohongshu.com/user/profile/${user}?xsec_token=sample&xsec_source=app_share` });
      }
      throw Error('UNEXPECTED_REQUEST');
    } }) };
  return { deps, userCalls, pgyCalls };
}
async function run(deps) { let result; for (let i = 0; i < 8; i++) { result = await runTick(deps); if (result.status !== 'running') break; } return result; }

const kol = (n, fans, patch = {}) => ({ userId: id(n), name: `作者${n}`, redId: `${n}`, location: '上海', fansNum: fans,
  fans30GrowthRate: 300, clickMidNum: 1000, interMidNum: 100, contentTags: [{ taxonomy1Tag: '美食', taxonomy2Tags: ['美食展示'] }], ...patch });
// The platform publishes complete days only, so a real curve ends yesterday. Seven gains fill the whole window.
const curve = gains => gains.map((num, i) => ({ num, dateKey: new Date(NOW + 8 * HOUR - (gains.length - i) * DAY).toISOString().slice(0, 10) }));
const dayBack = back => new Date(NOW + 8 * HOUR - back * DAY).toISOString().slice(0, 10);

test('the day\'s rising board comes from the blogger square, keeping accounts that grew a tenth in seven days', async () => {
  const store = new MemoryStore();
  const square = [kol(301, 54739), kol(302, 200000), kol(303, 4000)];
  const curves = { [id(301)]: curve([131, 125, 157, 144, 341, 20682, 8460]),
    [id(302)]: curve([100, 90, 120, 80, 110, 95, 105]),  // 700 followers on 200k: below both bars
    [id(303)]: curve([10, 10, 10, 20, 30, 40, 50]) };    // 170 followers: rate is high, the floor is not met
  const { deps, pgyCalls } = setup(store, { square, curves });
  const result = await run(deps);
  assert.ok(['complete', 'partial'].includes(result.status), result.status);
  // One list request, then one curve per candidate the square returned.
  assert.deepEqual(pgyCalls, ['list', id(301), id(302), id(303)]);
  const snapshot = await readSnapshot(store, result.snapshotId);
  assert.equal(snapshot.boards.rising, 1);
  const [account] = snapshot.accounts;
  assert.deepEqual([account.authorId, account.fansDelta, account.fansBefore, account.gainRate, account.source],
    [id(301), 30040, 24699, 1.216, 'pgy']);
  // The spike day is what makes the account worth studying: that is when its content broke out.
  assert.equal(account.spikeGain, 20682);
  assert.match(account.spikeDate, /^\d{4}-\d{2}-\d{2}$/);
  // Seven whole days ending yesterday — the range the board's subtitle promises.
  assert.deepEqual([account.baselineAt.slice(0, 10), account.observedAt.slice(0, 10)], [dayBack(7), dayBack(1)]);
  assert.equal(account.spanHours, 168);
  const round = await store.get('dfp_rounds', '20260912-0900');
  assert.equal(round.coverage.rising.source, 'pgy');
  assert.equal(round.coverage.rising.published, 1);
});

test('the square is bought once a day: a later round republishes the stored board without paying again', async () => {
  const store = new MemoryStore();
  const square = [kol(301, 54739)];
  const curves = { [id(301)]: curve([131, 125, 157, 144, 341, 20682, 8460]) };
  const first = setup(store, { square, curves });
  await run(first.deps);
  assert.deepEqual(first.pgyCalls, ['list', id(301)]);
  const later = setup(store, { square, curves });
  later.deps.clock = () => Date.parse('2026-09-12T12:02:00+08:00');
  let result; for (let i = 0; i < 8; i++) { result = await runTick(later.deps); if (result.status !== 'running') break; }
  assert.ok(['complete', 'partial'].includes(result.status), JSON.stringify(result));
  assert.deepEqual(later.pgyCalls, []);
  const snapshot = await readSnapshot(store, result.snapshotId);
  assert.equal(snapshot.accounts[0].authorId, id(301));
});

test('a square that cannot be read leaves the round publishing, and our own observations still stand in', async () => {
  const store = new MemoryStore();
  await seed(store, [{ authorId: id(201), author: '涨粉号', fans: 4000, at: NOW - 3 * DAY },
    { authorId: id(201), author: '涨粉号', fans: 5000, at: NOW - 2 * HOUR }]);
  const { deps, pgyCalls } = setup(store, { square: [] });
  deps.makeProvider = opts => new Provider({ ...opts, fetcher: async url => {
    const u = new URL(url); const kind = u.pathname.split('/').at(-1);
    if (kind === 'get_blogger_list') { pgyCalls.push('list'); return new Response('', { status: 500 }); }
    if (kind === 'search_notes') return response({ items: [{ note: raw(1) }] });
    if (kind === 'get_image_note_detail') return response([{ note_list: [raw(1)] }]);
    if (kind === 'get_creator_hot_inspiration_feed') return response({ items: [] });
    if (kind === 'get_creator_inspiration_feed') return response({ inspirations: [] });
    if (kind === 'get_user_info') return response({ fans: 100 });
    throw Error('UNEXPECTED_REQUEST');
  } });
  const result = await run(deps);
  assert.equal(result.status, 'partial');
  const round = await store.get('dfp_rounds', '20260912-0900');
  assert.ok(round.coverage.gaps.includes('RISING_UNAVAILABLE'));
  // The observed path fills in: the seeded account gained 1,000 on 4,000 across more than twelve hours.
  const snapshot = await readSnapshot(store, result.snapshotId);
  assert.equal(snapshot.accounts[0].source, 'observed');
  assert.equal(snapshot.accounts[0].fansDelta, 1000);
});

test('the 06:00 sweep neither re-checks authors nor publishes accounts', async () => {
  const store = new MemoryStore();
  await seed(store, [{ authorId: id(201), author: '涨粉号', fans: 4000, at: NOW - 3 * DAY }]);
  const sweepAt = Date.parse('2026-09-12T06:02:00+08:00');
  const { deps, userCalls } = setup(store, { fansByAuthor: { [id(201)]: 9000 } });
  deps.clock = () => sweepAt;
  deps.makeProvider = options => new Provider({ ...options, fetcher: async url => {
    const kind = new URL(url).pathname.split('/').at(-1);
    if (kind === 'search_notes') return response({ items: [] });
    if (kind === 'get_creator_hot_inspiration_feed') return response({ items: [] });
    if (kind === 'get_creator_inspiration_feed') return response({ inspirations: [] });
    if (kind === 'get_user_info') { userCalls.push('sweep'); return response({ fans: 9000 }); }
    throw Error('UNEXPECTED_REQUEST');
  } });
  let result; for (let i = 0; i < 8; i++) { result = await runTick(deps); if (result.status !== 'running') break; }
  assert.deepEqual(userCalls, []);
  const round = await store.get('dfp_rounds', '20260912-0600');
  assert.equal(round.coverage.rising, undefined);
});

test('a board left empty by failed curves is not the day\'s answer: observations stand in and a later round retries', async () => {
  const store = new MemoryStore();
  await seed(store, [{ authorId: id(201), author: '涨粉号', fans: 4000, at: NOW - 3 * DAY },
    { authorId: id(201), author: '涨粉号', fans: 5000, at: NOW - 2 * HOUR }]);
  const square = [kol(301, 54739)];
  const first = setup(store, { square, curveStatus: 500 });
  const result = await run(first.deps);
  // A 5xx is retried once, so a failing curve costs two requests rather than one.
  assert.deepEqual(first.pgyCalls, ['list', id(301), id(301)]);
  const record = await store.get('dfp_results', `rising_daily_food_${dayBack(0)}`);
  assert.deepEqual([record.accounts, record.complete], [[], false]);
  // An empty array is not a board: the round publishes what our own observations know instead of nothing.
  const snapshot = await readSnapshot(store, result.snapshotId);
  assert.deepEqual([snapshot.accounts[0].source, snapshot.accounts[0].fansDelta], ['observed', 1000]);
  assert.ok((await store.get('dfp_rounds', '20260912-0900')).coverage.gaps.includes('RISING_INCOMPLETE'));
  // The same day's noon round tries again rather than inheriting the failure until tomorrow. The square itself comes
  // back from the six-hour reuse cache without being fetched or charged, so the retry costs one curve.
  const later = setup(store, { square, curves: { [id(301)]: curve([131, 125, 157, 144, 341, 20682, 8460]) } });
  later.deps.clock = () => Date.parse('2026-09-12T12:02:00+08:00');
  let second; for (let i = 0; i < 8; i++) { second = await runTick(later.deps); if (second.status !== 'running') break; }
  assert.deepEqual(later.pgyCalls, [id(301)]);
  assert.deepEqual((await readSnapshot(store, second.snapshotId)).accounts.map(a => [a.authorId, a.source]), [[id(301), 'pgy']]);
});

test('an account this board showed in the last seven days is skipped before its curve is paid for', async () => {
  const store = new MemoryStore();
  await store.put('dfp_results', `rising_published_${id(301)}`, { snapshotId: 'earlier', at: NOW - 2 * DAY });
  const square = [kol(301, 54739), kol(302, 40000)];
  const curves = { [id(301)]: curve([131, 125, 157, 144, 341, 20682, 8460]), [id(302)]: curve([800, 800, 800, 800, 800, 800, 800]) };
  const { deps, pgyCalls } = setup(store, { square, curves });
  const result = await run(deps);
  // No request is spent on the account we already recommended; the money goes to the next one in the square.
  assert.deepEqual(pgyCalls, ['list', id(302)]);
  assert.deepEqual((await readSnapshot(store, result.snapshotId)).accounts.map(a => a.authorId), [id(302)]);
});

test('a square that refuses our key costs the rising board, never the round', async () => {
  const store = new MemoryStore();
  const { deps, pgyCalls } = setup(store, { square: [kol(301, 54739)], curveStatus: 403 });
  const result = await run(deps);
  assert.ok(['complete', 'partial'].includes(result.status), JSON.stringify(result));
  assert.deepEqual(pgyCalls, ['list', id(301)]);
  const round = await store.get('dfp_rounds', '20260912-0900');
  assert.ok(round.coverage.gaps.includes('RISING_UNAVAILABLE'));
  // The round still published its works: an unauthorized sub-feature must not end collection.
  assert.ok((await readSnapshot(store, result.snapshotId)).count >= 1);
});

test('the curve is read as whole days: a repeated day counts once and the newest day is still open', async () => {
  const store = new MemoryStore();
  const repeated = [...curve([100, 100, 100, 100, 100, 100, 5000]), { num: 5000, dateKey: dayBack(1) },
    { num: 99999, dateKey: dayBack(0) }];
  const { deps } = setup(store, { square: [kol(301, 10000)], curves: { [id(301)]: repeated } });
  const result = await run(deps);
  const [account] = (await readSnapshot(store, result.snapshotId)).accounts;
  // 600 across six days plus one 5,000 day — not 10,000, and today's 99,999 is not counted at all.
  assert.deepEqual([account.fansDelta, account.fansBefore, account.spikeGain], [5600, 4400, 5000]);
});

test('on the observed path an account is not recommended twice within seven days, and a failed re-check is skipped, not fatal', async () => {
  const store = new MemoryStore();
  await seed(store, [{ authorId: id(201), author: '涨粉号', fans: 4000, at: NOW - 3 * DAY }, { authorId: id(202), author: '出错号', fans: 8000, at: NOW - 2 * DAY }]);
  await store.put('dfp_results', `rising_published_${id(201)}`, { snapshotId: 'earlier', at: NOW - 2 * DAY });
  // An empty square is a finished board with nothing in it, so the round falls back to re-checking our own authors.
  const { deps, userCalls, pgyCalls } = setup(store, { square: [], fansByAuthor: { [id(201)]: 9000 }, userFailure: { user: id(202), status: 404 } });
  const result = await run(deps);
  assert.ok(['complete', 'partial'].includes(result.status), result.status);
  assert.deepEqual(pgyCalls, ['list']);
  assert.deepEqual(userCalls, [id(101), id(201), id(202)]);
  const snapshot = await readSnapshot(store, result.snapshotId);
  // 201 grew past the bar but was shown two days ago; 202 answered nothing. Neither is published, and the round lives.
  assert.equal(snapshot.boards.rising, 0); assert.deepEqual(snapshot.accounts, []);
  assert.deepEqual((await store.get('dfp_rounds', '20260912-0900')).coverage.rising, { rechecked: 1, queued: 2, published: 0, source: 'observed' });
});

// The points a curve request yields once parsed, as risingFromCurves receives them.
const points = gains => curve(gains).map(p => ({ date: p.dateKey, gain: p.num }));

test('the square is ranked before it is capped, so the fastest accounts are the ones that survive the cap', () => {
  const bloggers = Array.from({ length: 8 }, (_, i) => ({ authorId: id(400 + i), author: `作者${i}`, fans: 10000 }));
  // Listed slowest first: without ranking before the cap the two fastest would be the ones dropped.
  const curves = new Map(bloggers.map((b, i) => [b.authorId, points(Array.from({ length: 7 }, () => 200 + i * 50))]));
  const accounts = risingFromCurves(bloggers, curves, NOW);
  assert.equal(accounts.length, 6);
  assert.deepEqual(accounts.map(a => a.authorId), [id(407), id(406), id(405), id(404), id(403), id(402)]);
  assert.ok(accounts.every((a, i, all) => i === 0 || all[i - 1].gainRate >= a.gainRate));
});

test('a day the platform reports without a number is dropped, never summed into a figure that clears both bars', () => {
  const blogger = { authorId: id(410), author: '缺数据', fans: 10000 };
  const broken = points([200, 200, 200, 200, 200, 200, 200]).map((p, i) => i < 5 ? { ...p, gain: null } : p);
  // Only the two readable days count: 400 on 9,600 is below the floor, so the account is left off the board.
  assert.equal(risingFromCurves([blogger], new Map([[blogger.authorId, broken]]), NOW).length, 0);
  const whole = growthFromCurve(blogger, broken, NOW);
  assert.deepEqual([whole.gain, whole.fansBefore, whole.spanHours], [400, 9600, 48]);
});
