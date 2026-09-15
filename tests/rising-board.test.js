'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { MemoryStore, NOW, PRICE } = require('./helpers');
const { runTick } = require('../cloudfunctions/collectTick/lib/runner');
const { Provider } = require('../cloudfunctions/collectTick/lib/provider');
const { claimLease, releaseLease } = require('../cloudfunctions/collectTick/lib/budget');
const { recordFansObservation, INDEX_ID } = require('../cloudfunctions/collectTick/lib/authors');
const { readSnapshot } = require('../cloudfunctions/collectTick/lib/publisher');
const id = n => n.toString(16).padStart(24, '0');
const DAY = 86400000, HOUR = 3600000;
const base = { enabled: true, freeAiConfirmed: true, dailyCalls: 250, dailyMicroUsd: 2500000, sweepCalls: 100, budgetTier: 'expanded250',
  validationCalls: 20, validationMicroUsd: 200000, maxAiCallsPerRound: 20, discoveryMode: 'adaptive',
  vision: { enabled: false, dailyMicroCny: 500000, roundCalls: 3, validationCalls: 6, validationMicroCny: 200000 } };
const raw = (n, patch = {}) => ({ id: id(n), user: { userid: id(100 + n), nickname: `作者${n}` }, type: 'normal',
  time: (NOW - 2 * DAY) / 1000, liked_count: 600, collected_count: 900, title: '蒸蛋', desc: '鸡蛋2个，加水搅匀，蒸十分钟。', ...patch });
const response = data => Response.json({ code: 200, data: { success: true, code: 0, data } });
async function seed(store, entries) {
  for (const e of entries) {
    const lease = await claimLease(store, { owner: 'seed', now: e.at });
    await recordFansObservation(store, lease, e, e.at);
    await releaseLease(store, lease);
  }
}
function setup(store, { fansByAuthor = {}, userFailure = null } = {}) {
  const userCalls = [];
  const deps = { store, config: base, key: 'fixture-key', clock: () => NOW, verify: async () => PRICE,
    generate: async () => JSON.stringify({ verdict: 'cooking', evidence: '加水搅匀', evidenceSource: 'desc' }),
    makeProvider: options => new Provider({ ...options, fetcher: async url => {
      const u = new URL(url); const kind = u.pathname.split('/').at(-1);
      if (kind === 'get_creator_hot_inspiration_feed') return response({ items: [] });
      if (kind === 'get_creator_inspiration_feed') return response({ inspirations: [] });
      if (kind === 'search_notes') return response({ items: [{ note: raw(1) }] });
      if (kind === 'get_image_note_detail') return response([{ note_list: [raw(1)] }]);
      if (kind === 'get_user_info') {
        const user = u.searchParams.get('user_id'); userCalls.push(user);
        if (userFailure && userFailure.user === user) return new Response('', { status: userFailure.status });
        return response({ fans: fansByAuthor[user] ?? 100, share_link: `https://www.xiaohongshu.com/user/profile/${user}?xsec_token=sample&xsec_source=app_share` });
      }
      throw Error('UNEXPECTED_REQUEST');
    } }) };
  return { deps, userCalls };
}
async function run(deps) { let result; for (let i = 0; i < 8; i++) { result = await runTick(deps); if (result.status !== 'running') break; } return result; }

test('a regular round re-checks stale authors after its candidates and publishes accounts that gained a thousand followers', async () => {
  const store = new MemoryStore();
  await seed(store, [
    { authorId: id(201), author: '涨粉号', fans: 4000, at: NOW - 3 * DAY },
    { authorId: id(202), author: '平稳号', fans: 8000, at: NOW - 2 * DAY },
    { authorId: id(203), author: '刚看过', fans: 500, at: NOW - 2 * HOUR }
  ]);
  const { deps, userCalls } = setup(store, { fansByAuthor: { [id(201)]: 5300, [id(202)]: 8200 } });
  const result = await run(deps);
  assert.ok(['complete', 'partial'].includes(result.status), result.status);
  // The selected work's own author, then the two stale tracked authors; the author seen two hours ago is left alone.
  assert.deepEqual(userCalls, [id(101), id(201), id(202)]);
  const snapshot = await readSnapshot(store, result.snapshotId);
  assert.equal(snapshot.boards.saves, 1); assert.equal(snapshot.boards.rising, 1);
  assert.deepEqual(snapshot.accounts.map(a => [a.authorId, a.author, a.fansBefore, a.fans, a.fansDelta, a.spanHours]), [[id(201), '涨粉号', 4000, 5300, 1300, 72]]);
  const round = await store.get('dfp_rounds', '20260912-0900');
  assert.deepEqual(round.coverage.rising, { rechecked: 2, queued: 2, published: 1 });
  // Re-checks are ordinary inspection requests on the same round ledger and stay inside its cap.
  assert.ok(round.calls <= 50);
  const index = await store.get('dfp_results', INDEX_ID);
  assert.equal(index.authors[id(101)].fans, 100); assert.equal(index.authors[id(201)].gain, 1300);
  assert.equal((await store.get('dfp_results', `rising_published_${id(201)}`)).snapshotId, snapshot.id);
});

test('an account is not recommended twice within seven days and a failed re-check is skipped, not fatal', async () => {
  const store = new MemoryStore();
  await seed(store, [{ authorId: id(201), author: '涨粉号', fans: 4000, at: NOW - 3 * DAY }, { authorId: id(202), author: '出错号', fans: 8000, at: NOW - 2 * DAY }]);
  await store.put('dfp_results', `rising_published_${id(201)}`, { snapshotId: 'earlier', at: NOW - 2 * DAY });
  const { deps, userCalls } = setup(store, { fansByAuthor: { [id(201)]: 9000 }, userFailure: { user: id(202), status: 404 } });
  const result = await run(deps);
  assert.ok(['complete', 'partial'].includes(result.status), result.status);
  assert.deepEqual(userCalls, [id(101), id(201), id(202)]);
  const snapshot = await readSnapshot(store, result.snapshotId);
  assert.equal(snapshot.boards.rising, 0); assert.deepEqual(snapshot.accounts, []);
  assert.deepEqual((await store.get('dfp_rounds', '20260912-0900')).coverage.rising, { rechecked: 1, queued: 2, published: 0 });
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
