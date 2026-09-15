'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeNote, parseResponse, validateParams, verifyPrice, splitResultNotes, imageUrl } = require('../cloudfunctions/collectTick/lib/provider');
const { historyBaseline, eligibleBoards } = require('../cloudfunctions/collectTick/lib/ranking');
const { parseJudgment, judgeNote } = require('../cloudfunctions/collectTick/lib/judge');
const { scheduledRound } = require('../cloudfunctions/collectTick/lib/config');
const { NOW } = require('./helpers');

const ID = n => n.toString(16).padStart(24, '0');
const candidate = (overrides = {}) => ({ noteId: ID(100), authorId: ID(200), type: 'video',
  publishedAt: new Date(NOW - 3600000).toISOString(), likes: 2000, fans: 1000, ...overrides });
const history = () => Array.from({ length: 8 }, (_, i) => candidate({ noteId: ID(i + 1),
  publishedAt: new Date(NOW - (i + 2) * 3600000).toISOString(), likes: (i + 1) * 100, sticky: false }));

test('history uses exactly the previous seven posts and the fourth sorted likes value', () => {
  const result = historyBaseline(candidate(), history());
  assert.equal(result.baseline, 400);
  assert.equal(result.ratio, 5);
  assert.equal(result.history.length, 7);
  assert.equal(result.history.some(x => x.noteId === ID(8)), false);
});
test('missing likes cannot be skipped to backfill with the eighth post', () => {
  const rows = history(); rows[0].likes = null;
  assert.equal(historyBaseline(candidate(), rows).ratio, null);
});
test('unknown pin status, zero median, incomplete chronology cannot produce a ratio', () => {
  const rows = history(); rows[0].sticky = null;
  assert.equal(historyBaseline(candidate(), rows).ratio, null);
  assert.equal(historyBaseline(candidate(), history().map(x => ({ ...x, likes: 0 }))).ratio, null);
  assert.equal(historyBaseline(candidate(), history().map(x => ({ ...x, publishedAt: null }))).ratio, null);
});
test('windows include the lower boundary, exclude the upper boundary, and the saves board needs more saves than likes', () => {
  assert.deepEqual(eligibleBoards(candidate({ publishedAt: new Date(NOW).toISOString() }), NOW), []);
  assert.deepEqual(eligibleBoards(candidate({ publishedAt: new Date(NOW - 7 * 86400000).toISOString(), likes: 300, collected: 400 }), NOW), ['saves']);
  assert.deepEqual(eligibleBoards(candidate({ publishedAt: new Date(NOW - 7 * 86400000 - 1).toISOString(), likes: 300, collected: 400 }), NOW), []);
  assert.deepEqual(eligibleBoards(candidate({ likes: 10000, fans: 5001 }), NOW), ['today', 'week']);
  assert.deepEqual(eligibleBoards(candidate({ likes: 10000, collected: 10001 }), NOW), ['today', 'week', 'saves']);
  assert.deepEqual(eligibleBoards(candidate({ likes: null, fans: null }), NOW), []);
  assert.deepEqual(eligibleBoards(candidate({ likes: 299, collected: 500 }), NOW), []);
  assert.deepEqual(eligibleBoards(candidate({ likes: 300, collected: 300 }), NOW), []);
  assert.deepEqual(eligibleBoards(candidate({ likes: 300, collected: 301 }), NOW), ['saves']);
  assert.deepEqual(eligibleBoards(candidate({ likes: 300, collected: null }), NOW), []);
  // Follower counts no longer gate any board.
  assert.deepEqual(eligibleBoards(candidate({ likes: 300, collected: 301, fans: 900000 }), NOW), ['saves']);
});
test('the recorded Rednote image CDN is supported without accepting arbitrary image hosts', () => {
  assert.equal(imageUrl('https://sns-i11.rednotecdn.com/image.jpg'), 'https://sns-i11.rednotecdn.com/image.jpg');
  assert.equal(imageUrl('https://rednotecdn.com.evil.test/image.jpg'), null);
  assert.equal(imageUrl('http://127.0.0.1/private'), null);
});
test('normalization preserves unknown metrics and unknown pin status, rejects invalid IDs', () => {
  const raw = { id: ID(1), user: { userid: ID(2), nickname: '作者' }, type: 'video',
    timestamp: NOW / 1000, liked_count: -1, desc: '放入鸡蛋，搅拌均匀。' };
  const note = normalizeNote(raw, { source: 'search' });
  assert.equal(note.likes, null); assert.equal(note.sticky, null); assert.equal(note.bodyComplete, false);
  assert.equal(normalizeNote({ ...raw, id: 'https://evil.test' }), null);
  assert.equal(normalizeNote({ ...raw, desc: 'a'.repeat(12001) }, { source: 'detail' }).bodyComplete, false);
});
test('search pagination retains sessions and an empty success differs from provider failure', () => {
  const response = { code: 200, data: { success: true, code: 0, data: { items: [] },
    search_id: 'session-a', search_session_id: 'session-b', next_page: 2 } };
  const parsed = parseResponse('search', response, NOW);
  assert.deepEqual(parsed.notes, []); assert.equal(parsed.nextPage, 2);
  assert.equal(parsed.searchSessionId, 'session-b');
  assert.throws(() => parseResponse('search', { code: 200, data: { success: false } }, NOW), /PROVIDER_REJECTED/);
  assert.throws(() => parseResponse('search', { code: 200, data: { success: true, data: {} } }, NOW), /PROVIDER_SCHEMA/);
  assert.throws(() => validateParams('author', { user_id: ID(1), url: 'https://evil.test' }), /INVALID_PARAMETERS/);
});
test('recorded App V2 detail envelopes unwrap note_list for image and video notes', () => {
  for (const type of ['normal', 'video']) {
    const envelope = { code: 200, data: { success: true, code: 0, data: [{ note_list: [{
      id: ID(1), user: { userid: ID(2) }, type, time: NOW / 1000, title: '蒸蛋', desc: '鸡蛋加水蒸十分钟。', sticky: false
    }], comment_list: [], model_type: 'note' }] } };
    const result = parseResponse(type === 'normal' ? 'note_image' : 'note_video', envelope, NOW);
    assert.equal(result.notes.length, 1); assert.equal(result.notes[0].bodyComplete, true);
    assert.equal(result.notes[0].type, type);
  }
});
test('price verification identifies the current per-request tariff and rejects stale or conflicting prices', async () => {
  const response = html => async () => new Response(html, { status: 200 });
  const valid = '<h1>Rednote Xiaohongshu API</h1><p>Rednote endpoints are billed at $0.01 per request.</p>';
  assert.equal((await verifyPrice(response(valid), NOW)).microUsd, 10000);
  await assert.rejects(verifyPrice(response('<h1>Xiaohongshu API</h1><p>Current price: $0.02 per request</p><p>Previous price: $0.01 per request</p>'), NOW), /UNVERIFIED_PRICE/);
  await assert.rejects(verifyPrice(response(valid + '<p>Rednote endpoints are billed at $0.02 per request.</p>'), NOW), /UNVERIFIED_PRICE/);
});
test('long valid Chinese descriptions are split by bytes rather than an assumed number of notes', () => {
  const notes = Array.from({ length: 5 }, (_, i) => normalizeNote({ id: ID(i + 1), user: { userid: ID(99) },
    type: 'normal', title: '菜'.repeat(2000), desc: '蒸'.repeat(12000), time: NOW / 1000 }, { source: 'detail' }));
  const parts = splitResultNotes(notes);
  assert.ok(parts.length > 1);
  assert.equal(parts.flat().length, 5);
  assert.ok(parts.every(part => Buffer.byteLength(JSON.stringify({ notes: part })) < 184000));
  assert.throws(() => splitResultNotes([{ desc: '蒸'.repeat(70000) }]), /PROVIDER_SCHEMA/);
});
test('cooking evidence must be a nonempty source substring; invented recipes and extra tools are rejected', () => {
  const note = { title: '鸡蛋羹', desc: '鸡蛋加温水打散，蒸十分钟。', bodyComplete: true };
  assert.equal(parseJudgment('{"verdict":"cooking","evidence":"加温水打散"}', note).verdict, 'cooking');
  assert.equal(parseJudgment('{"verdict":"cooking","evidence":"加入黄油"}', note).verdict, 'uncertain');
  assert.equal(parseJudgment('{"verdict":"cooking","evidence":""}', note).verdict, 'uncertain');
  assert.equal(parseJudgment('{"verdict":"cooking","evidence":"鸡蛋","tools":["pay"]}', note).verdict, 'uncertain');
});
test('incomplete text causes no model call, and model errors have no paid fallback', async () => {
  let calls = 0;
  const generate = async () => { calls++; throw new Error('quota with secret'); };
  assert.equal((await judgeNote({ title: '', desc: '', bodyComplete: false }, generate)).verdict, 'uncertain');
  assert.equal(calls, 0);
  const result = await judgeNote({ title: '', desc: '鸡蛋打散，蒸十分钟', bodyComplete: true }, generate);
  assert.equal(calls, 1); assert.equal(result.verdict, 'error');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('schedule allocates 17/17/16 and cannot start after the twenty minute window', () => {
  const config = { dailyCalls: 50, validationCalls: 20 };
  assert.deepEqual([9, 12, 20].map(h => scheduledRound(Date.parse(`2026-09-12T${h.toString().padStart(2, '0')}:02:00+08:00`), config).roundCalls), [17, 17, 16]);
  assert.equal(scheduledRound(Date.parse('2026-09-12T09:20:00+08:00'), config), null);
  assert.equal(scheduledRound(Date.parse('2026-09-13T00:00:00+08:00'), config), null);
});

module.exports = { ID, candidate, history };

test('detail capture preserves bounded validated images and never claims a truncated gallery is complete',()=>{
 const {normalizeNote}=require('../cloudfunctions/collectTick/lib/provider');
 const raw={id:'1'.repeat(24),user:{userid:'2'.repeat(24)},type:'normal',title:'蒸蛋',desc:'加水蒸熟',images_list:[{url:'https://sns-img.xhscdn.com/first.jpg'},{original:'http://sns-i11.rednotecdn.com/second.jpg'}]};
 const n=normalizeNote(raw,{source:'detail'});assert.deepEqual(n.images,['https://sns-img.xhscdn.com/first.jpg','https://sns-i11.rednotecdn.com/second.jpg']);assert.equal(n.imageCount,2);assert.equal(n.imagesComplete,true);
 assert.equal(normalizeNote(raw,{source:'search'}).imagesComplete,false);
 const many=normalizeNote({...raw,images_list:Array.from({length:21},(_,i)=>({url:'https://sns-img.xhscdn.com/'+i+'.jpg'}))},{source:'detail'});assert.equal(many.images.length,20);assert.equal(many.imageCount,21);assert.equal(many.imagesComplete,false);
 const bad=normalizeNote({...raw,images_list:[...raw.images_list,{url:'https://evil.example/track'}]},{source:'detail'});assert.equal(bad.images.length,2);assert.equal(bad.imagesComplete,false);
});
