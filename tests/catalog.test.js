'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./helpers');
const { createCatalog } = require('../cloudfunctions/catalog/lib/queries');
const appId = 'wx8a2388888683b769';
const ctx = { APPID: appId, OPENID: 'owner' };
const id = n => String(n).padStart(24, '0');
async function setup() {
  const store = new MemoryStore(); const signed = [];
  const api = createCatalog({ store, config: { appId, allowedOpenIds: ['owner'] },
    sign: async fileIds => { signed.push(...fileIds); return fileIds.map(fileID => ({ fileID, tempFileURL: 'https://img.test/safe', status: 0 })); } });
  for (let n = 1; n <= 3; n++) {
    const snapshotId = `20260912-${n}000-abcdefabcdef`;
    const indexId = `20260912-${n}000_${id(n)}`;
    await store.put('dfp_snapshots', snapshotId, { id: snapshotId, published: true, parts: [], count: 0, scheduledAt: '2026-09-12T01:00:00Z', status: 'complete' });
    await store.put('dfp_notes', indexId, { snapshotId, searchText: n === 1 ? '蒸蛋 [ 鸡蛋' : '鸡蛋 蒸蛋 教程',
      note: { noteId: id(n), title: '蒸蛋', fileId: `cloud://environment/cover${n}`, boards: ['today'] } });
    await store.put('dfp_candidates', `published_${id(n)}`, { snapshotId, indexId });
  }
  return { api, store, signed };
}
test('every action rejects missing, foreign and forged identities before reading or signing data', async () => {
  const { api, signed } = await setup();
  for (const action of ['status', 'listRounds', 'search', 'getNotes', 'getRound']) {
    assert.equal((await api({ action, OPENID: 'owner', APPID: appId }, {})).error.code, 'UNAUTHENTICATED');
    assert.equal((await api({ action }, { ...ctx, OPENID: 'stranger' })).error.code, 'FORBIDDEN');
  }
  assert.deepEqual(signed, []);
});
test('search uses literal terms, all words must match, and pages are stable', async () => {
  const { api } = await setup();
  const first = await api({ action: 'search', query: '鸡蛋 蒸蛋', limit: 1 }, ctx);
  assert.equal(first.ok, true); assert.equal(first.data.notes[0].noteId, id(3));
  const second = await api({ action: 'search', query: '鸡蛋 蒸蛋', limit: 1, cursor: first.data.nextCursor }, ctx);
  assert.equal(second.data.notes[0].noteId, id(2));
  const special = await api({ action: 'search', query: '[' }, ctx);
  assert.equal(special.data.notes.length, 1); assert.equal(special.data.notes[0].noteId, id(1));
  assert.equal((await api({ action: 'search', query: '不存在' }, ctx)).data.notes.length, 0);
  assert.equal((await api({ action: 'search', query: 'changed', cursor: first.data.nextCursor }, ctx)).error.code, 'INVALID_CURSOR');
});
test('unpublished draft rows and superseded records are hidden from search and favorites', async () => {
  const { api, store } = await setup();
  await store.put('dfp_snapshots', 'draft', { published: false });
  await store.put('dfp_notes', `99999999-9999_${id(9)}`, { snapshotId: 'draft', searchText: '蒸蛋', note: { noteId: id(9) } });
  await store.put('dfp_candidates', `published_${id(9)}`, { snapshotId: 'draft', indexId: `99999999-9999_${id(9)}` });
  const result = await api({ action: 'getNotes', noteIds: [id(1), id(9)], fileId: 'cloud://other/private' }, ctx);
  assert.deepEqual(result.data.missing, [id(9)]);
  assert.deepEqual(result.data.notes.map(x => x.noteId), [id(1)]);
  assert.equal((await api({ action: 'getRound', snapshotId: '20260912-0900-abcdefabcdef' }, ctx)).error.code, 'NOT_FOUND');
});
test('only images belonging to returned notes are signed, and signing failure keeps note text usable', async () => {
  const { api, store, signed } = await setup();
  await api({ action: 'getNotes', noteIds: [id(1)], fileId: 'cloud://other/private' }, ctx);
  assert.deepEqual(signed, ['cloud://environment/cover1']);
  const failing = createCatalog({ store, config: { appId, allowedOpenIds: ['owner'] }, sign: async () => { throw new Error('secret'); } });
  const result = await failing({ action: 'getNotes', noteIds: [id(1)] }, ctx);
  assert.equal(result.ok, true); assert.equal(result.data.notes[0].thumbUrl, null);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('fileId'), false);
});
test('invalid limits and arbitrary IDs are rejected without exposing internal errors', async () => {
  const { api } = await setup();
  for (const event of [{ action: 'listRounds', limit: 21 }, { action: 'getNotes', noteIds: ['../private'] },
    { action: 'search', query: '$where', limit: 0 }, { action: 'getNotes', noteIds: Array(51).fill(id(1)) }]) {
    assert.equal((await api(event, ctx)).ok, false);
  }
});
