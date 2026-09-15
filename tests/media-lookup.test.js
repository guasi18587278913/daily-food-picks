'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { MemoryStore, NOW, PRICE } = require('./helpers');
const { runTick } = require('../cloudfunctions/collectTick/lib/runner');
const { Provider } = require('../cloudfunctions/collectTick/lib/provider');
const id = n => n.toString(16).padStart(24, '0');
const base = { enabled: true, freeAiConfirmed: true, dailyCalls: 50, dailyMicroUsd: 500000,
  validationCalls: 20, validationMicroUsd: 200000, maxAiCallsPerRound: 20, discoveryMode: 'adaptive',
  vision: { enabled: true, dailyMicroCny: 500000, roundCalls: 3, validationCalls: 6, validationMicroCny: 200000 } };
const stream = { media: { video: { duration: 30 }, stream: { h264: [{ master_url: 'http://sns-video-v28.xhscdn.com/stream/1/a', size: 1000 }] } } };
function raw(n, patch = {}) { return { id: id(n), user: { userid: id(100 + n), nickname: '作者' }, type: 'video',
  time: (NOW - 2 * 86400000) / 1000, liked_count: 15000, title: '一盘菜', desc: '', ...patch }; }
const response = data => Response.json({ code: 200, data: { success: true, code: 0, data } });
function setup({ detailHasStream }) {
  const store = new MemoryStore(); const calls = []; const reviewed = [];
  const target = raw(1, { video_info_v2: stream }), related = raw(2);
  const deps = { store, config: base, key: 'fixture-key', clock: () => NOW, verify: async () => PRICE,
    generate: async () => JSON.stringify({ verdict: 'uncertain', evidence: '' }),
    review: async ({ note }) => { reviewed.push(note.noteId); return { verdict: 'cooking', evidenceSource: 'frames', evidence: [{ frame: 1, observation: '加水搅拌' }, { frame: 2, observation: '加热煮熟' }] }; },
    makeProvider: options => new Provider({ ...options, fetcher: async url => {
      const u = new URL(url); const kind = u.pathname.split('/').at(-1); calls.push(`${kind}:${u.searchParams.get('note_id') || ''}`);
      if (kind === 'get_creator_hot_inspiration_feed') return response({ items: [] });
      if (kind === 'get_creator_inspiration_feed') return response({ inspirations: [] });
      if (kind === 'search_notes') return response({ items: [{ note: target }] });
      if (kind === 'get_video_note_detail') {
        const wanted = u.searchParams.get('note_id') === id(1) ? target : (detailHasStream ? { ...related, video_info_v2: stream } : related);
        return response([{ note_list: u.searchParams.get('note_id') === id(1) ? [target, related] : [wanted] }]);
      }
      throw Error('UNEXPECTED_REQUEST');
    } }) };
  return { store, calls, deps, reviewed };
}
async function run(x) { let result; for (let i = 0; i < 6; i++) { result = await runTick(x.deps); if (result.status !== 'running') break; } return result; }

test('a related video without a stream address gets one detail request before its visual review', async () => {
  const x = setup({ detailHasStream: true });
  const result = await run(x);
  assert.ok(['complete', 'partial'].includes(result.status));
  assert.deepEqual(x.calls.filter(c => c.startsWith('get_video_note_detail')), [`get_video_note_detail:${id(1)}`, `get_video_note_detail:${id(2)}`]);
  assert.deepEqual(x.reviewed.sort(), [id(1), id(2)]);
  const row = await x.store.get('dfp_candidates', `20260912-0900_${id(2)}`);
  assert.equal(row.mediaLookup, true); assert.equal(row.stage, 'done'); assert.equal(row.note.media.url, 'https://sns-video-v28.xhscdn.com/stream/1/a');
  const snapshot = await x.store.get('dfp_snapshots', result.snapshotId);
  assert.equal(snapshot.boards.week, 2);
});

test('when the detail still has no stream the video is left unconfirmed without a download or a second detail', async () => {
  const x = setup({ detailHasStream: false });
  const result = await run(x);
  assert.equal(result.status, 'partial');
  assert.equal(x.calls.filter(c => c === `get_video_note_detail:${id(2)}`).length, 1);
  assert.deepEqual(x.reviewed, [id(1)]);
  // Since the three tiers it reaches the page as unconfirmed, with the unreadable video named as the reason.
  const row = await x.store.get('dfp_candidates', `20260912-0900_${id(2)}`);
  assert.equal(row.stage, 'done'); assert.equal(row.outcome, 'unconfirmed'); assert.equal(row.errorCode, 'VIDEO_UNAVAILABLE');
  assert.equal(row.note.contentStatus, 'unconfirmed'); assert.equal(row.note.contentReason, 'video_unreadable');
  const round = await x.store.get('dfp_rounds', '20260912-0900');
  assert.ok(round.coverage.gaps.includes('VIDEO_UNAVAILABLE'));
});
