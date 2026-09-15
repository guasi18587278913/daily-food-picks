'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { judgeNote, modelErrorCategory, RATE_LIMIT_RETRY_DELAYS_MS } = require('../cloudfunctions/collectTick/lib/judge');
const note = { type: 'video', title: '教你做焖饭', desc: '米饭加水焖十分钟。', bodyComplete: true };
const rateLimited = () => Object.assign(new Error('Request failed with status code 429'), { code: '429' });
const good = JSON.stringify({ verdict: 'cooking', evidence: '米饭加水焖十分钟', evidenceSource: 'desc' });

test('a numeric SDK error code is read as the HTTP status and classified', () => {
  assert.deepEqual(modelErrorCategory(rateLimited()), { category: 'rate_limit', status: 429 });
  assert.deepEqual(modelErrorCategory(Object.assign(new Error('x'), { status: 403 })), { category: 'authorization', status: 403 });
  assert.deepEqual(modelErrorCategory(Object.assign(new Error('timeout of 35000ms exceeded'), { code: 'ECONNABORTED' })), { category: 'timeout', status: null });
  assert.deepEqual(modelErrorCategory(Object.assign(new Error('boom'), { code: 'EAI_AGAIN' })), { category: 'service', status: null });
});

test('rate-limited calls are retried with bounded pauses and then succeed without changing the verdict rules', async () => {
  let calls = 0; const pauses = [];
  const generate = async () => { calls++; if (calls < 3) throw rateLimited(); return good; };
  const result = await judgeNote(note, generate, { sleep: async ms => { pauses.push(ms); } });
  assert.equal(result.verdict, 'on_topic'); assert.equal(calls, 3); assert.equal(result.attempts, 3);
  assert.deepEqual(pauses, [...RATE_LIMIT_RETRY_DELAYS_MS]);
});

test('no retry starts when the pause plus a full call would cross the tick deadline', async () => {
  let calls = 0; let slept = false; let time = 1000000;
  const generate = async () => { calls++; throw rateLimited(); };
  const result = await judgeNote(note, generate, { sleep: async () => { slept = true; }, clock: () => time, deadline: time + 36000 });
  assert.equal(result.verdict, 'error'); assert.equal(result.reason, 'model_rate_limited'); assert.equal(calls, 1); assert.equal(slept, false);
  assert.equal(result.diagnostics.attempts, 1);
  // 38 s of room fits the first pause (1.5 s) plus a call, but not the second pause (3.5 s) plus a call.
  const roomy = await judgeNote(note, generate, { sleep: async () => { slept = true; }, clock: () => time, deadline: time + 38000 });
  assert.equal(roomy.diagnostics.attempts, 2); assert.equal(slept, true);
});

test('persistent rate limiting gives up after the retry budget with attempt counts and no text in diagnostics', async () => {
  let calls = 0; const pauses = [];
  const result = await judgeNote(note, async () => { calls++; throw rateLimited(); }, { sleep: async ms => { pauses.push(ms); } });
  assert.equal(result.verdict, 'error'); assert.equal(result.reason, 'model_rate_limited');
  assert.deepEqual(result.diagnostics, { category: 'rate_limit', httpStatus: 429, attempts: 3 });
  assert.equal(calls, 3); assert.equal(pauses.length, 2);
  assert.ok(!JSON.stringify(result).includes('米饭'));
});

test('authorization, timeout and service failures are not retried', async () => {
  for (const error of [Object.assign(new Error('x'), { status: 401 }), Object.assign(new Error('timeout of 35000ms exceeded'), {}), new Error('boom')]) {
    let calls = 0; let slept = false;
    const result = await judgeNote(note, async () => { calls++; throw error; }, { sleep: async () => { slept = true; } });
    assert.equal(result.verdict, 'error'); assert.equal(result.reason, 'model_unavailable');
    assert.equal(calls, 1); assert.equal(slept, false); assert.equal(result.diagnostics.attempts, 1);
  }
});
