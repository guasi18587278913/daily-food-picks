'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { MemoryStore, NOW, PRICE } = require('./helpers');
const { runTick } = require('../cloudfunctions/collectTick/lib/runner');
const { Provider } = require('../cloudfunctions/collectTick/lib/provider');
const { claimLease, releaseLease } = require('../cloudfunctions/collectTick/lib/budget');
const { recordFansObservation, historyId, INDEX_ID } = require('../cloudfunctions/collectTick/lib/authors');
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
const daily = (offsets, gain) => offsets.map(back => ({ num: gain, dateKey: new Date(NOW + 8 * HOUR * 3 - back * DAY).toISOString().slice(0, 10) }));
function setup(store, { fansByAuthor = {}, userFailure = null, square = [], curves = {} } = {}) {
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
const curve = gains => gains.map((num, i) => ({ num, dateKey: new Date(NOW + 8 * HOUR - (gains.length - 1 - i) * DAY).toISOString().slice(0, 10) }));

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
