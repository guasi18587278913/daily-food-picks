'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore, NOW } = require('./helpers');
const { claimLease } = require('../cloudfunctions/collectTick/lib/budget');
const { publish, previouslyPublished, readSnapshot, storeCover } = require('../cloudfunctions/collectTick/lib/publisher');

const ID = '000000000000000000000001';
const note = { noteId: ID, authorId: '000000000000000000000002', title: '蒸蛋', desc: '鸡蛋加水蒸熟',
  author: '作者', type: 'normal', likes: 2000, boards: ['today'], judgment: { verdict: 'cooking', evidence: '加水蒸熟' } };
async function setup() {
  const store = new MemoryStore(); const lease = await claimLease(store, { owner: 'worker', now: NOW });
  const round = { id: '20260912-0900', scheduledAt: NOW - 120000, validation: false };
  await store.put('dfp_rounds', round.id, { status: 'running' });
  return { store, lease, round, now: NOW };
}
test('publishing exposes only a fully verified snapshot and cross-round dedup starts at publication', async () => {
  const ctx = await setup();
  assert.equal(await previouslyPublished(ctx.store, ID), false);
  const snapshot = await publish({ ...ctx, notes: [note], status: 'complete', coverage: {}, successfulSearches: 1 });
  assert.equal(await previouslyPublished(ctx.store, ID), true);
  assert.equal((await readSnapshot(ctx.store, snapshot.id)).notes.length, 1);
  assert.equal((await ctx.store.get('dfp_state', 'latest')).snapshotId, snapshot.id);
  const round2 = { ...ctx.round, id: '20260912-1200' };
  await ctx.store.put('dfp_rounds', round2.id, { status: 'running' });
  const second = await publish({ ...ctx, round: round2, notes: [note], status: 'complete', coverage: {}, successfulSearches: 1 });
  assert.equal((await readSnapshot(ctx.store, second.id)).notes.length, 0);
});
test('a crash before pointer commit does not erase old results or permanently deduplicate a draft', async () => {
  const ctx = await setup();
  const original = ctx.store.transaction.bind(ctx.store);
  ctx.store.transaction = fn => original(async tx => {
    const put = tx.put.bind(tx);
    tx.put = async (collection, id, value) => {
      if (collection === 'dfp_state' && id === 'latest') throw new Error('simulated crash');
      return put(collection, id, value);
    };
    return fn(tx);
  });
  await assert.rejects(publish({ ...ctx, notes: [note], status: 'complete', coverage: {}, successfulSearches: 1 }), /simulated crash/);
  assert.equal(await previouslyPublished(ctx.store, ID), false);
  assert.equal(await ctx.store.get('dfp_state', 'latest'), null);
});
test('failure without valid results retains the old snapshot; partial requires an explanation', async () => {
  const ctx = await setup();
  await ctx.store.put('dfp_state', 'latest', { snapshotId: 'old' });
  await assert.rejects(publish({ ...ctx, notes: [], status: 'complete', successfulSearches: 0, coverage: {} }), /NO_VALID_DATA/);
  await assert.rejects(publish({ ...ctx, notes: [note], status: 'partial', successfulSearches: 1, coverage: {} }), /PARTIAL_REASON_REQUIRED/);
  assert.equal((await ctx.store.get('dfp_state', 'latest')).snapshotId, 'old');
});
test('expired workers cannot publish; corruption in a part is detected on read', async () => {
  const ctx = await setup();
  await assert.rejects(publish({ ...ctx, now: NOW + 220000, notes: [note], status: 'complete', coverage: {}, successfulSearches: 1 }), /LEASE_EXPIRED/);
  const snapshot = await publish({ ...ctx, notes: [note], status: 'complete', coverage: {}, successfulSearches: 1 });
  await ctx.store.put('dfp_parts', snapshot.parts[0].id, { notes: [] });
  await assert.rejects(readSnapshot(ctx.store, snapshot.id), /CORRUPT_SNAPSHOT/);
});
test('a stale publisher cannot overwrite the winning snapshot search and favorite references', async () => {
  const ctx = await setup(); let now = NOW; let paused; let resume;
  const reached = new Promise(resolve => { paused = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const originalPut = ctx.store.put.bind(ctx.store); let intercept = true;
  ctx.store.put = async (collection, id, value) => {
    if (intercept && collection === 'dfp_notes') { intercept = false; paused(); await gate; }
    return originalPut(collection, id, value);
  };
  const old = publish({ ...ctx, now: undefined, clock: () => now, notes: [note], status: 'complete', coverage: {}, successfulSearches: 1 });
  await reached;
  now += 220000;
  const fresh = await claimLease(ctx.store, { owner: 'new-worker', now });
  const winning = await publish({ ...ctx, lease: fresh, now: undefined, clock: () => now,
    notes: [note, { ...note, noteId: '000000000000000000000009' }], status: 'complete', coverage: {}, successfulSearches: 1 });
  resume(); await assert.rejects(old, /LEASE_EXPIRED/);
  assert.equal(await previouslyPublished(ctx.store, ID), true);
  const reference = await ctx.store.get('dfp_candidates', `published_${ID}`);
  assert.equal(reference.snapshotId, winning.id);
  assert.equal((await ctx.store.get('dfp_notes', reference.indexId)).snapshotId, winning.id);
});
test('a verified JPEG with a generic CDN content type is stored as an image', async () => {
  const store = new MemoryStore();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 0xff, 0xd9]);
  const uploads = [];
  const fileId = await storeCover({ store, note: { coverUrl: 'https://sns-i11.rednotecdn.com/cover' },
    fetcher: async () => new Response(jpeg, { headers: { 'content-type': 'application/octet-stream' } }),
    upload: async payload => { uploads.push(payload); return { fileID: 'cloud://trial/cover.jpg' }; } });
  assert.equal(fileId, 'cloud://trial/cover.jpg');
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].cloudPath, /^covers\/[a-f0-9]+\.jpg$/);
  assert.deepEqual(uploads[0].fileContent, jpeg);
});
test('a mislabeled non-image is never stored or cached as a cover', async () => {
  for (const contentType of ['application/octet-stream', 'image/jpeg']) {
    const store = new MemoryStore(); let uploads = 0;
    const fileId = await storeCover({ store, note: { coverUrl: 'https://sns-i11.rednotecdn.com/fake' },
      fetcher: async () => new Response('<html>not an image</html>', { headers: { 'content-type': contentType } }),
      upload: async () => { uploads++; return { fileID: 'cloud://trial/fake.jpg' }; } });
    assert.equal(fileId, null);
    assert.equal(uploads, 0);
  }
});

test('cover failures retain safe diagnostics and a cache outage cannot discard an uploaded image',async()=>{
 const note={coverUrl:'https://sns-i11.rednotecdn.com/image?sign=private-value'};const issues=[];const bytes=Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3]);
 const store=new MemoryStore();
 const failed=await storeCover({store,note,upload:async()=>{throw Error('must not upload');},fetcher:async()=>new Response('denied',{status:403}),report:x=>issues.push(x)});
 assert.equal(failed,null);assert.deepEqual(issues,[{code:'COVER_HTTP_ERROR',httpStatus:403}]);assert.equal(JSON.stringify(issues).includes('private-value'),false);
 const broken={get:async()=>{throw Error('db read failed');},put:async()=>{throw Error('db write failed');}};
 const saved=await storeCover({store:broken,note,fetcher:async()=>new Response(bytes,{headers:{'content-type':'image/jpeg'}}),upload:async()=>({fileID:'cloud://saved-cover'}),report:x=>issues.push(x)});
 assert.equal(saved,'cloud://saved-cover');assert.ok(issues.some(x=>x.code==='COVER_CACHE_READ_FAILED'));assert.ok(issues.some(x=>x.code==='COVER_CACHE_WRITE_FAILED'));
});

test('rising accounts are published as facts, deduplicated, and marked so seven days pass before a repeat', async () => {
  const { publicAccount } = require('../cloudfunctions/collectTick/lib/publisher');
  const { store, lease, round } = await setup();
  const account = { authorId: '7'.repeat(24), author: '涨粉号', fans: 5300, fansBefore: 4000, fansDelta: 1300,
    observedAt: '2026-09-15T04:00:00.000Z', baselineAt: '2026-09-12T04:00:00.000Z', spanHours: 72,
    notes: [{ noteId: '8'.repeat(24), title: '蒸蛋', likes: 800, collected: 1200, publishedAt: '2026-09-14T02:00:00.000Z' }] };
  const snapshot = await publish({ store, lease, round, now: NOW, notes: [note], accounts: [account, { ...account, author: '重复' }, { authorId: 'bad', fansDelta: 5 }],
    status: 'complete', coverage: {}, successfulSearches: 1 });
  assert.equal(snapshot.boards.rising, 1);
  assert.deepEqual(snapshot.accounts.map(a => [a.authorId, a.author, a.fansDelta]), [[account.authorId, '涨粉号', 1300]]);
  assert.equal(snapshot.accounts[0].notes.length, 1);
  assert.equal((await store.get('dfp_results', `rising_published_${account.authorId}`)).snapshotId, snapshot.id);
  // Only the listed facts travel to the page: no follower history, judgments or internal keys.
  assert.deepEqual(Object.keys(snapshot.accounts[0]).sort(),
    ['author', 'authorId', 'baselineAt', 'fans', 'fansBefore', 'fansDelta', 'notes', 'observedAt', 'spanHours']);
  assert.equal(publicAccount({ authorId: '7'.repeat(24) }), null);
  assert.equal(publicAccount({ authorId: 'short', fansDelta: 1 }), null);
});
