'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { MemoryStore, NOW } = require('./helpers');
const { claimLease } = require('../cloudfunctions/collectTick/lib/budget');
const { parseVisualJudgment, requestBody, classifyFrames, verifyVisionPrice, ENDPOINT } = require('../cloudfunctions/collectTick/lib/vision');
const { PRICE_URL, MODEL } = require('../cloudfunctions/collectTick/lib/vision-budget');
const image = Buffer.from([0xff, 0xd8, 0, 1, 0xff, 0xd9]);
const images = Array.from({ length: 6 }, (_, i) => Buffer.from([0xff, 0xd8, 0, i, 0xff, 0xd9]));
const frames = { image, images, imageHash: createHash('sha256').update(image).digest('hex'), frameCount: 6,
  samples: Array.from({ length: 6 }, (_, i) => ({ index: i + 1, requestedAtMs: (i + 1) * 1000,
    sha256: createHash('sha256').update(images[i]).digest('hex') })), mediaIdentity: 'video1', samplerVersion: 'test' };
const cooking = { verdict: 'cooking', evidenceType: 'preparation', evidence: [{ frame: 2, observation: '将面粉倒入碗中搅拌' }, { frame: 4, observation: '面团包入馅料并烘烤' }] };
const settings = { enabled: true, dailyMicroCny: 500000, roundCalls: 3, validationCalls: 6, validationMicroCny: 200000 };
const price = { source: PRICE_URL, model: MODEL, inputMicroCnyPerMillion: 1200000, outputMicroCnyPerMillion: 3500000, verifiedAt: NOW - 1000, expiresAt: NOW + 3600000 };
test('the model request contains actual JPEG data and the direct API token fields', () => {
  const body = requestBody({ title: '教程' }, frames);
  assert.equal(body.max_tokens, 16384); assert.equal(body.max_completion_tokens, 1024);
  assert.match(body.messages[0].content[0].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(body.messages[0].content.filter(x => x.type === 'image_url').length, 6);
  assert.equal(body.tools, undefined); assert.equal(body.stream, false);
});
test('visual decisions require actual frame references and preparation or recipe evidence', () => {
  assert.equal(parseVisualJudgment(JSON.stringify(cooking), frames).verdict, 'cooking');
  for (const patch of [{ evidence: [] }, { evidence: [{ frame: 7, observation: '搅拌食材' }] },
    { evidence: [{ frame: 1, observation: '成品看起来好吃' }, { frame: 2, observation: '拿着成品展示' }] }, { tools: ['publish'] }])
    assert.equal(parseVisualJudgment(JSON.stringify({ ...cooking, ...patch }), frames).verdict, 'error');
  assert.equal(parseVisualJudgment('{"verdict":"uncertain","evidenceType":"none","evidence":[]}', frames).verdict, 'uncertain');
  assert.equal(parseVisualJudgment(JSON.stringify({ verdict: 'cooking', evidenceType: 'recipe', evidence: [{ frame: 2, observation: '配方写着面粉200克' }] }), frames).verdict, 'cooking');
});
test('unsupported or changed price pages cannot enable a paid visual request', async () => {
  const ok = '<p>vita-video-3.0（最新模型） 1.2元/百万 token 3.5元/百万 token</p>';
  assert.equal((await verifyVisionPrice(async () => new Response(ok), NOW)).model, MODEL);
  await assert.rejects(() => verifyVisionPrice(async () => new Response(ok.replace('1.2元', '2.0元')), NOW), /VISION_PRICE_UNVERIFIED/);
});
test('real dispatch is reserved first and a repeated completed request is not sent again', async () => {
  const store = new MemoryStore(), lease = await claimLease(store, { owner: 'test', now: NOW }); let calls = 0;
  const args = { store, lease, scope: 'validation', note: { noteId: '1'.repeat(24), title: '测试视频', desc: '' }, frames, settings, price,
    key: 'fixture-only-vision-key-000', clock: () => NOW, fetcher: async (url, options) => {
      calls++; assert.equal(url, ENDPOINT); assert.equal((await store.get('dfp_budgets', 'vision-initial-validation')).calls, 1);
      assert.match(JSON.parse(options.body).messages[0].content[0].image_url.url, /^data:/);
      return Response.json({ model: MODEL, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(cooking) } }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } });
    } };
  assert.equal((await classifyFrames(args)).verdict, 'cooking'); assert.equal((await classifyFrames(args)).reused, true);
  assert.equal(calls, 1);
  await assert.rejects(() => classifyFrames({ ...args, settings: { ...settings, enabled: false } }), /VISION_DISABLED/);
  assert.equal(calls, 1);
});
test('HTTP failure and malformed frames never become a positive decision or trigger fallback', async () => {
  const store = new MemoryStore(), lease = await claimLease(store, { owner: 'test', now: NOW }); let calls = 0;
  const args = { store, lease, scope: 'validation', note: { noteId: '1'.repeat(24) }, frames, settings, price,
    key: 'fixture-only-vision-key-000', clock: () => NOW, fetcher: async () => { calls++; return new Response('', { status: 400 }); } };
  const first = await classifyFrames(args); assert.equal(first.verdict, 'error');
  await classifyFrames(args); assert.equal(calls, 1);
  await assert.rejects(() => classifyFrames({ ...args, frames: { ...frames, imageHash: 'wrong' } }), /VISION_FRAMES_INVALID/);
  assert.equal(calls, 1);
});
test('wrong model keeps the full reservation and stops vision; abnormal completion cannot admit content', async () => {
  for (const patch of [{ model: 'other' }, { model: undefined }, { reason: 'tool_calls' }, { reason: 'length' }]) {
    const store = new MemoryStore(), lease = await claimLease(store, { owner: 'test', now: NOW });
    const result = await classifyFrames({ store, lease, scope: 'validation', note: { noteId: '1'.repeat(24) }, frames, settings, price,
      key: 'fixture-only-vision-key-000', clock: () => NOW, fetcher: async () => Response.json({ model: 'model' in patch ? patch.model : MODEL,
        choices: [{ finish_reason: patch.reason || 'stop', message: { content: JSON.stringify(cooking) } }],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }) });
    assert.equal(result.verdict, 'error');
    const bucket = await store.get('dfp_budgets', 'vision-initial-validation');
    if ('model' in patch) {
      assert.equal(bucket.allocatedMicroCny, 23245); assert.equal(bucket.knownMicroCny, 0);
      assert.equal((await store.get('dfp_state', 'vision_stop')).reason, 'VISION_MODEL_MISMATCH');
    } else { assert.equal(bucket.knownMicroCny, 1550); assert.equal(await store.get('dfp_state', 'vision_stop'), null); }
  }
});
test('different evidence frame numbers cannot reuse the same image as two preparation observations',()=>{
 const duplicate={...frames,samples:frames.samples.map((f,i)=>({...f,sha256:[1,3].includes(i)?'identical':`other-${i}`}))};
 assert.equal(parseVisualJudgment(JSON.stringify(cooking),duplicate).verdict,'error');
});
