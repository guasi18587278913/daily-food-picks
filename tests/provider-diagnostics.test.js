'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Provider } = require('../cloudfunctions/collectTick/lib/provider');
const { claimLease } = require('../cloudfunctions/collectTick/lib/budget');
const { prepared, NOW, PRICE, LIMITS } = require('./helpers');

const query = { keyword: '家常菜', page: 1, sort_type: 'popularity_descending', time_filter: '一周内', note_type: '不限' };
async function request(fetcher) {
  const store = await prepared();
  const lease = await claimLease(store, { owner: 'diagnostics-test', now: NOW });
  const provider = new Provider({ store, lease, round: { id: '20260912-0900', roundCalls: 17 }, price: PRICE,
    config: { ...LIMITS, enabled: true, freeAiConfirmed: true }, key: 'private-test-key', fetcher, clock: () => NOW });
  let code;
  try { await provider.request('search', query); } catch (e) { code = e.code; }
  return { code, rows: await store.list('dfp_attempts'), budget: await store.get('dfp_budgets', '2026-09-12') };
}

test('HTTP rejection records its status without persisting response text or adding a retry', async () => {
  const result = await request(async () => new Response('private response text', { status: 402 }));
  assert.equal(result.code, 'HTTP_REJECTED');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].httpStatus, 402);
  assert.equal(result.budget.calls, 1);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('retryable HTTP failures keep the existing two-attempt budget and record each status', async () => {
  const result = await request(async () => new Response('', { status: 503 }));
  assert.equal(result.code, 'HTTP_RETRYABLE');
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every(row => row.httpStatus === 503));
  assert.equal(result.budget.calls, 2);
});

test('HTTP 200 with rejected business status records only numeric provider codes', async () => {
  const result = await request(async () => new Response(JSON.stringify({ code: 200, message: 'private', data: { success: false, code: -1 } })));
  assert.equal(result.code, 'PROVIDER_REJECTED');
  assert.equal(result.rows[0].httpStatus, 200);
  assert.equal(result.rows[0].providerCode, 200);
  assert.equal(result.rows[0].providerDataCode, -1);
  assert.equal(JSON.stringify(result).includes('private'), false);
  const invalid = await request(async () => new Response(JSON.stringify({ code: 'private', data: { code: 'private' } })));
  assert.equal(invalid.rows[0].providerCode, null);
  assert.equal(invalid.rows[0].providerDataCode, null);
});

test('transport failure has unknown HTTP status and keeps its budget reservation', async () => {
  const result = await request(async () => { throw new Error('private network details'); });
  assert.equal(result.code, 'NETWORK_ERROR');
  assert.equal(result.rows[0].status, 'unknown');
  assert.equal(result.rows[0].httpStatus, null);
  assert.equal(result.budget.calls, 1);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
