'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prioritizeCandidates, runTick } = require('../cloudfunctions/collectTick/lib/runner');
const { Provider } = require('../cloudfunctions/collectTick/lib/provider');
const { readSnapshot } = require('../cloudfunctions/collectTick/lib/publisher');
const { MemoryStore, NOW, PRICE } = require('./helpers');
const ID = n => n.toString(16).padStart(24, '0');
const round = { kind: 'regular', scheduledAt: NOW };
const row = (n, extra = {}) => ({ note: { noteId: ID(n), authorId: ID(n + 100), type: 'video',
  title: '家常菜', desc: '', publishedAt: new Date(NOW - 2 * 86400000).toISOString(), likes: 500, fans: null, ...extra } });

test('regular rounds give week, saves and today candidates turns before continuing within each group', () => {
  const rows = [row(1, { desc: '食材：鸡蛋2个，制作步骤齐全', likes: 3000, collected: 3500 }),
    row(2, { likes: 10000 }), row(3, { likes: 1500, publishedAt: new Date(NOW - 3600000).toISOString() }),
    row(4, { likes: 20000 }), row(5, { desc: '配方：用水100毫升', collected: 600 })];
  const ordered = prioritizeCandidates(rows, round).map(x => x.note.noteId);
  assert.deepEqual(ordered.slice(0, 3), [ID(4), ID(1), ID(3)]);
  assert.equal(ordered.length, rows.length);
  assert.equal(new Set(ordered).size, rows.length);
});

test('overlapping week and today candidates appear once, and empty groups do not block others', () => {
  const both = row(1, { likes: 20000, publishedAt: new Date(NOW - 3600000).toISOString() });
  const saves = row(2, { collected: 800 });
  assert.deepEqual(prioritizeCandidates([saves, both], round).map(x => x.note.noteId), [ID(1), ID(2)]);
  assert.deepEqual(prioritizeCandidates([saves], round), [saves]);
});

test('sweep ordering stays unchanged, while a late week candidate survives the 40-candidate cutoff', () => {
  const saves = Array.from({ length: 45 }, (_, i) => row(i + 1, { desc: '食材配方：鸡蛋2个，水100毫升', collected: 900 }));
  const week = row(99, { likes: 11000 });
  assert.equal(prioritizeCandidates([...saves, week], round).slice(0, 40)[0].note.noteId, ID(99));
  assert.deepEqual(prioritizeCandidates([...saves, week], { ...round, kind: 'sweep' }), prioritizeCandidates([...saves, week]));
});

test('the actual request budget leaves room for week inspection before the many saves candidates', async () => {
  const store = new MemoryStore(); const details = [];
  const raw = n => ({ id: ID(n), user: { userid: ID(n + 100) }, type: n === 99 ? 'video' : 'normal',
    time: (NOW - 2 * 86400000) / 1000, liked_count: n === 99 ? 12000 : 600, collected_count: n === 99 ? 100 : 900,
    title: n === 99 ? '教你做蒸蛋' : '食材配方齐全', desc: n === 99 ? '好吃！' : '鸡蛋2个，水100毫升，搅拌蒸熟。' });
  const payload = data => new Response(JSON.stringify({ code: 200, data: { success: true, code: 0, data } }));
  const deps = { store, config: { enabled: true, freeAiConfirmed: true, dailyCalls: 50, dailyMicroUsd: 500000,
    validationCalls: 20, validationMicroUsd: 200000, maxAiCallsPerRound: 20 }, key: 'test-key', clock: () => NOW, verify: async () => PRICE,
    generate: async messages => { const note = JSON.parse(messages[1].content); return JSON.stringify({ verdict: 'cooking',
      evidence: note.type === 'video' ? note.title : note.desc, evidenceSource: note.type === 'video' ? 'title' : 'desc' }); },
    makeProvider: options => new Provider({ ...options, fetcher: async url => {
      if (url.pathname.endsWith('/search_notes')) return payload({ items: [...Array.from({ length: 45 }, (_, i) => ({ note: raw(i + 1) })), { note: raw(99) }] });
      if (url.pathname.includes('note_detail')) { const n = parseInt(url.searchParams.get('note_id'), 16); details.push(n); return payload([{ note_list: [raw(n)] }]); }
      if (url.pathname.endsWith('/get_user_info')) return payload({ fans: 20000 });
      throw Error('unexpected request');
    } }) };
  let result;
  for (let tick = 0; tick < 4; tick++) { result = await runTick(deps); if (result.status !== 'running') break; }
  assert.equal(details[0], 99);
  assert.equal(details.filter(n => n === 99).length, 1, 'resumption does not buy the week detail twice');
  assert.equal((await store.get('dfp_budgets', '2026-09-12')).calls, 17);
  assert.equal(result.status, 'partial');
  const snapshot = await readSnapshot(store, result.snapshotId);
  // Saves candidates no longer fall to a follower cap, so whatever the remaining budget inspected is published with the week pick.
  assert.equal(snapshot.boards.week, 1); assert.ok(snapshot.boards.saves >= 1 && snapshot.boards.saves < 45); assert.equal(snapshot.boards.rising, 0);
});
