'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore, NOW, PRICE } = require('./helpers');
const { runTick, prioritizeCandidates } = require('../cloudfunctions/collectTick/lib/runner');
const id = '000000000000000000000001';
const config = { enabled: true, freeAiConfirmed: true, dailyCalls: 50, dailyMicroUsd: 500000,
  validationCalls: 20, validationMicroUsd: 200000, maxAiCallsPerRound: 20 };
test('disabled collectors do no provider or model work', async () => {
  let called = 0;
  const result = await runTick({ config: { ...config, enabled: false }, makeProvider: () => { called++; }, store: new MemoryStore(), clock: () => NOW });
  assert.equal(result.status, 'disabled'); assert.equal(called, 0);
});
test('limited discovery checks posts with recipe clues before high-like eating shows', () => {
  const rows = [
    { note: { noteId: 'a', likes: 50000, title: '沉浸式吃饭', desc: '#吃播' } },
    { note: { noteId: 'b', likes: 3000, title: '蒸蛋', desc: '食材：鸡蛋2个，水100毫升' } },
    { note: { noteId: 'c', likes: 500, title: '家常小炒', desc: '制作步骤：倒入青椒炒熟' } }
  ];
  assert.deepEqual(prioritizeCandidates(rows).map(x => x.note.noteId), ['b', 'c', 'a']);
});
test('repeated ticks resume an empty completed round without buying search pages again', async () => {
  const store = new MemoryStore(); let calls = 0;
  const makeProvider = () => ({ sent: 0, async request() { calls++; this.sent++; return { pages: [] }; }, async notes() { return []; } });
  const deps = { store, config, makeProvider, verify: async () => PRICE, clock: () => NOW };
  const a = await runTick(deps); const b = await runTick(deps);
  assert.equal(a.status, 'complete'); assert.equal(b.status, 'complete'); assert.equal(calls, 4);
  assert.equal((await store.get('dfp_snapshots', a.snapshotId)).count, 0);
});
test('a limited tick resumes detail and judgment later, and publishes real cooking evidence', async () => {
  const store = new MemoryStore(); let detailCalls = 0; let judgments = 0;
  const note = { noteId: id, authorId: '000000000000000000000002', title: '蒸蛋', desc: '加水蒸十分钟',
    author: '作者', type: 'normal', publishedAt: new Date(NOW - 2 * 86400000).toISOString(), likes: 2000, comments: 250, shared: 100,
    fans: null, bodyComplete: false };
  const makeProvider = () => ({ sent: 0, async request(kind) {
    if (this.sent >= 5) { const e = new Error('TICK_LIMIT'); e.code = 'TICK_LIMIT'; throw e; }
    this.sent++;
    if (kind.startsWith('note_')) { detailCalls++; return { kind }; }
    if (kind === 'user') return { fans: 1000 };
    return { kind };
  }, async notes(result) { return [{ ...note, bodyComplete: result.kind.startsWith('note_') }]; } });
  const deps = { store, config, makeProvider, verify: async () => PRICE, clock: () => NOW,
    generate: async () => { judgments++; return '{"verdict":"cooking","evidence":"加水蒸十分钟"}'; } };
  for (let i = 0; i < 4; i++) await runTick(deps);
  const latest = await store.get('dfp_state', 'latest');
  assert.ok(latest); assert.equal(detailCalls, 1); assert.equal(judgments, 1);
  assert.equal((await store.get('dfp_snapshots', latest.snapshotId)).count, 1);
});
test('failed searches do not replace a previous usable snapshot with an empty success', async () => {
  const store = new MemoryStore(); await store.put('dfp_state', 'latest', { snapshotId: 'old' });
  const result = await runTick({ store, config, clock: () => NOW, verify: async () => PRICE,
    makeProvider: () => ({ sent: 0, async request() { this.sent++; const e = new Error('HTTP_REJECTED'); e.code = 'HTTP_REJECTED'; throw e; } }) });
  assert.equal(result.status, 'failed');
  assert.equal((await store.get('dfp_state', 'latest')).snapshotId, 'old');
});
test('a worker finishing after the window closes performs its own finalization', async () => {
  const store = new MemoryStore(); let now = Date.parse('2026-09-12T09:19:40+08:00');
  const deps = { store, config, verify: async () => ({ ...PRICE, verifiedAt: now - 1000, expiresAt: now + 3600000 }), clock: () => now,
    makeProvider: () => ({ sent: 0, async request() {
      this.sent++; now = Date.parse('2026-09-12T09:20:00+08:00');
      assert.equal((await runTick(deps)).status, 'busy');
      now = Date.parse('2026-09-12T09:20:21+08:00'); return {};
    }, async notes() { return []; } }) };
  const result = await runTick(deps);
  assert.notEqual(result.status, 'running');
  assert.notEqual((await store.get('dfp_rounds', '20260912-0900')).status, 'running');
});
