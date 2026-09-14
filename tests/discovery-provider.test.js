'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseResponse, normalizeNote, validateParams } = require('../cloudfunctions/collectTick/lib/provider');
const { MemoryStore, NOW, PRICE, LIMITS } = require('./helpers');
const { claimLease, reserveAttempt } = require('../cloudfunctions/collectTick/lib/budget');
const id = n => n.toString(16).padStart(24, '0');
const wrap = data => ({ code: 200, data: { code: 0, success: true, data } });
const raw = patch => ({ id: id(1), type: 'video', title: '教你做蒸蛋', desc: '鸡蛋加水蒸十分钟。',
  user: { user_id: id(2), nickname: '作者' }, create_time: NOW / 1000, ...patch });

test('topic counters and millisecond timestamps normalize without inventing metrics', () => {
  const result = parseResponse('topic', wrap({ items: [raw({ create_time: NOW,
    interaction_info: { like_count: 1234, collect_count: 90, comment_count: 3 } })], has_more: true }), NOW);
  assert.equal(result.notes[0].likes, 1234);
  assert.equal(result.notes[0].collected, 90);
  assert.equal(result.notes[0].shared, null);
  assert.equal(result.notes[0].publishedAt, new Date(NOW).toISOString());
  assert.equal(result.notes[0].source, 'topic');
  assert.equal(result.notes[0].bodyComplete, false);
});
test('hot metadata stays separate from notes and topic page IDs', () => {
  const result = parseResponse('hot', wrap({ items: [{ hot_id: '1234567', id: 12345678,
    title: '家宴布朗尼', score: 22000000, score_text: '2200万人在看' }], end_flag: false, cursor: '1' }), NOW);
  assert.deepEqual(result.notes, []);
  assert.equal(result.signals[0].label, '家宴布朗尼');
  assert.equal(result.signals[0].pageId, null);
  assert.equal(result.signals[0].displayMetric, '2200万人在看');
  assert.equal(result.signals[0].likes, undefined);
  assert.equal(result.hasMore, true);
  assert.equal(result.cursor, '1');
});
test('inspiration extracts only an actual topic attachment, not template IDs', () => {
  const attach = encodeURIComponent(JSON.stringify({ topics: [{ page_id: id(9) }] }));
  const result = parseResponse('inspiration', wrap({ inspirations: [
    { name: '宅家做饭', type: 'Topic', ins_id: 100, post_deeplink: `xhsdiscover://post_new_note?attach=${attach}` },
    { name: '视频模板', type: 'Video', ins_id: 101 }
  ], cursor: 'r_1', end_flag: false }), NOW);
  assert.equal(result.signals[0].pageId, id(9));
  assert.equal(result.signals[1].pageId, null);
});
test('favorite authors remain the post authors and fallback recommendations are rejected', () => {
  const result = parseResponse('faved', wrap({ notes: [raw({})], fallback: false }), NOW, { user_id: id(80) });
  assert.equal(result.notes[0].authorId, id(2));
  assert.equal(result.notes[0].source, 'faved');
  assert.throws(() => parseResponse('faved', wrap({ notes: [raw({ user: {} })] }), NOW, { user_id: id(80) }), /PROVIDER_SCHEMA/);
  assert.throws(() => parseResponse('faved', wrap({ notes: [raw({})], fallback: true }), NOW), /PROVIDER_SCHEMA/);
});
test('public collection status requires explicit visibility evidence', () => {
  assert.equal(parseResponse('user', wrap({ fans: 200, tab_public: { collection: true }, tab_visible: { collect: true } }), NOW).collectionsPublic, true);
  assert.equal(parseResponse('user', wrap({ fans: 200, tab_public: { collection: true }, tab_visible: { collect: false } }), NOW).collectionsPublic, false);
  assert.equal(parseResponse('user', wrap({ fans: 200 }), NOW).collectionsPublic, undefined);
});
test('topic links provide page IDs while tag IDs and unrelated links do not', () => {
  const note = normalizeNote(raw({ hash_tag: [
    { id: id(3), name: '蒸蛋', link: `xhsdiscover://rn/sns-discover/topic/normal?id=${id(4)}` },
    { id: id(5), name: '只给标签编号' },
    { id: id(6), name: '外部链接', link: `https://evil.test/?id=${id(7)}` }
  ] }));
  assert.deepEqual(note.topics, [{ pageId: id(4), label: '蒸蛋' }]);
});
test('media uses a stable identity and bounded public stream, not arbitrary URLs', () => {
  const video = url => ({ media: { video: { duration: 34, md5: 'a'.repeat(32) }, stream: { h264: [
    { master_url: 'https://evil.test/video.mp4', size: 10 }, { master_url: url, size: 3000000 }
  ] } } });
  const first = normalizeNote(raw({ video_info_v2: video('http://sns-video-v1.xhscdn.com/stream/a.mp4?sign=one') }), { source: 'detail' });
  const second = normalizeNote(raw({ video_info_v2: video('https://sns-video-v1.xhscdn.com/stream/a.mp4?sign=two') }), { source: 'detail' });
  assert.equal(first.media.identity, second.media.identity);
  assert.equal(first.media.durationMs, 34000);
  assert.equal(first.media.bytes, 3000000);
  assert.match(first.media.url, /^https:\/\/sns-video-v1\.xhscdn\.com/);
  assert.equal(normalizeNote(raw({ video_info_v2: video('http://127.0.0.1/private') })).media, undefined);
});
test('new endpoint parameters use fixed schemas and original billed-attempt accounting', async () => {
  for (const [kind, params] of [['hot', { cursor: '' }], ['inspiration', { cursor: '', tab: 0, source: 'creator_center' }],
    ['topic', { page_id: id(1), sort: 'trend' }], ['faved', { user_id: id(2), cursor: '' }]]) {
    assert.doesNotThrow(() => validateParams(kind, params));
    assert.throws(() => validateParams(kind, { ...params, url: 'https://evil.test' }), /INVALID_PARAMETERS/);
    const store = new MemoryStore();
    await store.put('dfp_rounds', '20260912-0900', { status: 'running' });
    const lease = await claimLease(store, { owner: 'test', now: NOW });
    await reserveAttempt(store, { roundId: '20260912-0900', requestKey: kind, kind, attempt: 1, now: NOW, price: PRICE, lease, limits: LIMITS });
    assert.equal((await store.get('dfp_budgets', '2026-09-12')).calls, 1);
  }
});
