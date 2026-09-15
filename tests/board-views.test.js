'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boards, card, accountCard, BOARD_INFO } = require('../miniprogram/lib/view');
const id = n => n.toString(16).padStart(24, '0');
const note = (patch = {}) => ({ noteId: id(1), title: '蒸蛋', author: '作者', type: 'video', publishedAt: '2026-09-14T02:00:00.000Z',
  likes: 800, collected: 1200, comments: 120, shared: 40, fans: 90000, ratio: null, fanRatio: null, collectRatio: 1.5, engageRatio: 0.2, baseline: null, boards: ['engage'], ...patch });
const account = (patch = {}) => ({ authorId: id(201), author: '涨粉号', fans: 5300, fansBefore: 4000, fansDelta: 1300, gainRate: 0.325,
  observedAt: '2026-09-15T04:00:00.000Z', baselineAt: '2026-09-12T04:00:00.000Z', spanHours: 72,
  spikeDate: '2026-09-13', spikeGain: 900, source: 'pgy',
  notes: [{ noteId: id(50), title: '蒸蛋', likes: 800, collected: 1200, publishedAt: '2026-09-14T02:00:00.000Z' }], ...patch });

test('the four boards appear in the order the user defined, with rising showing accounts', () => {
  const views = boards([note()], {}, () => false, [account()]);
  assert.deepEqual(views.map(v => [v.key, v.name]),
    [['today', '今日热榜'], ['week', '本周热门'], ['rising', '黑马榜单'], ['engage', '互动榜单']]);
  assert.deepEqual(views.map(v => v.count), [0, 0, 1, 1]);
  const rising = views[2];
  assert.equal(rising.options.length, 0); assert.equal(rising.cards.length, 0);
  assert.equal(rising.accounts[0].displayName, '涨粉号');
  assert.deepEqual(views[3].accounts, []);
  assert.equal(views[3].cards[0].noteId, id(1));
});

test('board rules on screen match the collector rules', () => {
  assert.equal(BOARD_INFO.today.subtitle, '近 24 小时 · 至少 1,000 赞');
  assert.equal(BOARD_INFO.week.subtitle, '近 7 天 · 至少 1 万赞');
  assert.equal(BOARD_INFO.rising.subtitle, '近 7 天涨粉 10% 以上 · 至少涨 500 粉');
  assert.equal(BOARD_INFO.engage.subtitle, '近 7 天 · 至少 300 赞 · 评论加转发不少于点赞的 15%');
  assert.deepEqual(BOARD_INFO.engage.options.map(o => o[0]), ['engageRatio', 'comments', 'shared', 'likes']);
});

test('accounts are ranked by follower gain and rendered as readable facts', () => {
  const views = boards([], {}, () => false, [account(), account({ authorId: id(202), author: '更快的号', fansDelta: 4000, fans: 14000, fansBefore: 10000, gainRate: 0.4, spanHours: 20 })]);
  const rising = views[2];
  assert.deepEqual(rising.accounts.map(a => [a.displayName, a.deltaLabel, a.spanLabel]),
    [['更快的号', '+4000 (+40%)', '20 小时内'], ['涨粉号', '+1300 (+33%)', '3 天内']]);
  assert.equal(rising.accounts[1].fansLabel, '4000 → 5300 粉丝');
  assert.equal(rising.accounts[1].notes[0].metric, '800 赞 · 1200 收藏');
  assert.equal(accountCard(account({ spanHours: null })).spanLabel, '观测跨度未知');
  // The breakout day is shown when it is known, and simply omitted when it is not.
  assert.equal(rising.accounts[1].spikeLabel, '9月13日 单日涨 900');
  assert.equal(accountCard(account({ spikeDate: null })).spikeLabel, '');
  assert.equal(accountCard(account({ spikeGain: null })).spikeLabel, '');
  assert.equal(accountCard(account({ author: null, notes: [] })).displayName, '作者未提供');
  assert.deepEqual(accountCard(account({ notes: [] })).notes, []);
});

test('an engage card leads with the engagement ratio and lists the interactions behind it', () => {
  const view = card(note(), 'engage', 'engageRatio', false);
  assert.equal(view.big, '20'); assert.equal(view.unit, '% 互动');
  assert.equal(view.comparison, '800 赞 · 120 评论 · 40 转发');
  assert.equal(card(note(), 'engage', 'shared', false).big, '40');
  assert.equal(card(note(), 'engage', 'shared', false).unit, '转发');
  assert.equal(card(note({ engageRatio: null }), 'engage', 'engageRatio', false).big, '—');
});

test('an empty round renders four collapsed boards without inventing accounts', () => {
  const views = boards([], {}, () => false);
  assert.equal(views.length, 4);
  assert.ok(views.every(v => v.count === 0 && v.cards.length === 0 && v.accounts.length === 0));
});
