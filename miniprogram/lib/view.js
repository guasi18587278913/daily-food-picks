'use strict';
const { canOpenOriginal } = require('./source');
/** @param {unknown} value */
function formatMetric(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  return value >= 10000 ? `${(value / 10000).toFixed(1).replace(/\.0$/, '')}万` : String(Math.round(value * 10) / 10);
}
/** @param {string|null|undefined} value @param {boolean} [includeTime] */
function formatTime(value, includeTime = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间待确认';
  const date = new Date(Date.parse(value) + 8 * 3600000);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日${includeTime ? ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}` : ''}`;
}
/** @template {{noteId:string,[key:string]:any}} T @param {T[]} notes @param {string} key @returns {T[]} */
function sortNotes(notes, key) {
  return [...notes].sort((a, b) => {
    const av = typeof a[key] === 'number' && Number.isFinite(a[key]) ? a[key] : -1;
    const bv = typeof b[key] === 'number' && Number.isFinite(b[key]) ? b[key] : -1;
    return bv - av || a.noteId.localeCompare(b.noteId);
  });
}
// The four boards the user defined on 2026-09-15. Rising lists accounts, not notes, so it carries no sort options.
// Why a work is only unconfirmed, in the reader's words. An unknown code falls back to the general wording.
/** @type {Record<string,string>} */
const UNCONFIRMED_REASON = {
  video_unreadable: '视频画面没读到', vision_unavailable: '画面复核没完成', vision_budget: '画面复核额度已用完',
  model_unavailable: '内容判断暂时不可用', frames_inconclusive: '画面里没看出做法',
  steps_in_video: '做法可能在视频里', no_text_evidence: '正文没写做法'
};
const BOARD_INFO = {
  today: { name: '今日热榜', subtitle: '近 24 小时 · 至少 1,000 赞', sort: 'ratio', options: [['ratio', '倍数'], ['likes', '点赞'], ['collected', '收藏'], ['comments', '评论']] },
  week: { name: '本周热门', subtitle: '近 7 天 · 至少 1 万赞', sort: 'likes', options: [['likes', '点赞'], ['collected', '收藏'], ['comments', '评论']] },
  rising: { name: '黑马榜单', subtitle: '近 7 天涨粉 10% 以上 · 至少涨 500 粉', sort: 'likes', options: [] },
  engage: { name: '互动榜单', subtitle: '近 7 天 · 至少 300 赞 · 评论加转发不少于点赞的 15%', sort: 'engageRatio', options: [['engageRatio', '互动比'], ['comments', '评论'], ['shared', '转发'], ['likes', '点赞']] }
};
/** @param {FoodNote} note @param {string} board @param {string} sort @param {boolean} favorite */
function card(note, board, sort, favorite) {
  const big = sort === 'ratio' ? note.ratio : sort === 'fanRatio' ? note.fanRatio : sort === 'collectRatio' ? note.collectRatio
    : sort === 'engageRatio' ? (typeof note.engageRatio === 'number' ? Math.round(note.engageRatio * 100) : null)
    : sort === 'collected' ? note.collected : sort === 'comments' ? note.comments : sort === 'shared' ? note.shared : note.likes;
  const unit = sort === 'ratio' || sort === 'fanRatio' || sort === 'collectRatio' ? '倍' : sort === 'engageRatio' ? '% 互动'
    : sort === 'collected' ? '收藏' : sort === 'comments' ? '评论' : sort === 'shared' ? '转发' : '赞';
  const comparison = board === 'today' ? (note.baseline !== null && note.baseline > 0 ? `作者前 7 篇中位数 ${formatMetric(note.baseline)} 赞` : '作者参照不足，暂不计算倍数')
    : board === 'engage' ? `${formatMetric(note.likes)} 赞 · ${formatMetric(note.comments)} 评论 · ${formatMetric(note.shared)} 转发`
    : `${formatMetric(note.collected)} 收藏 · ${formatMetric(note.comments)} 评论`;
  const canOpenSource = canOpenOriginal(note);
  const unconfirmed = note.contentStatus === 'unconfirmed';
  return { ...note, canOpenSource, sourceActionLabel: '查看内容',
    unconfirmed, statusLabel: unconfirmed ? '未确认做法' : '',
    statusHint: unconfirmed ? UNCONFIRMED_REASON[note.contentReason || ''] || '还没确认是做法内容' : '',
    displayTitle: note.title || '未提供标题 · 点开查看内容', big: formatMetric(big), unit, comparison,
    publishedLabel: formatTime(note.publishedAt), typeLabel: note.type === 'video' ? '视频' : '图文', favorite };
}
/**
 * An account card states what the collector observed about the account. Its recent works are evidence, not entries:
 * they may never have been published, so they are text rather than links into the note detail page.
 * @param {RisingAccount} account
 */
function accountCard(account) {
  const hours = typeof account.spanHours === 'number' && Number.isFinite(account.spanHours) ? account.spanHours : null;
  const span = hours === null ? '观测跨度未知' : hours >= 48 ? `${Math.round(hours / 24)} 天内` : `${hours} 小时内`;
  const rate = typeof account.gainRate === 'number' && Number.isFinite(account.gainRate) ? ` (+${Math.round(account.gainRate * 100)}%)` : '';
  // The day the account took off is the useful part: that is where its breakout content sits.
  const spike = /^\d{4}-\d{2}-\d{2}$/.test(account.spikeDate || '') && Number.isFinite(account.spikeGain)
    ? `${formatTime(`${account.spikeDate}T00:00:00.000Z`)} 单日涨 ${formatMetric(account.spikeGain)}` : '';
  return { authorId: account.authorId, displayName: account.author || '作者未提供', spikeLabel: spike,
    deltaLabel: `+${formatMetric(account.fansDelta)}${rate}`, spanLabel: span,
    fansLabel: `${formatMetric(account.fansBefore)} → ${formatMetric(account.fans)} 粉丝`,
    observedLabel: `采集于 ${formatTime(account.observedAt, true)}`,
    notes: (account.notes || []).map(x => ({ noteId: x.noteId, title: x.title || '未提供标题',
      metric: `${formatMetric(x.likes)} 赞 · ${formatMetric(x.collected)} 收藏` })) };
}
/** @param {FoodNote[]} notes @param {Record<string,string>} sorts @param {(id:string)=>boolean} hasFavorite @param {RisingAccount[]} [accounts] */
function boards(notes, sorts, hasFavorite, accounts = []) {
  return /** @type {BoardKey[]} */ (['today', 'week', 'rising', 'engage']).map(key => {
    const info = BOARD_INFO[key]; const sort = sorts[key] || info.sort;
    if (key === 'rising') {
      const rows = accounts.filter(x => x && typeof x.authorId === 'string');
      return { key, name: info.name, subtitle: info.subtitle, count: rows.length, options: [], cards: [],
        accounts: [...rows].sort((a, b) => b.fansDelta - a.fansDelta || a.authorId.localeCompare(b.authorId)).map(accountCard) };
    }
    const rows = notes.filter(x => x.boards?.includes(key));
    // Confirmed works lead; unconfirmed ones follow in the same order, so a board never hides them but never leads with them.
    const ordered = [...sortNotes(rows, sort)].sort((a, b) =>
      Number(a.contentStatus === 'unconfirmed') - Number(b.contentStatus === 'unconfirmed'));
    return { key, name: info.name, subtitle: info.subtitle, count: rows.length, accounts: [],
      options: info.options.map(([value, label]) => ({ value, label, active: value === sort })),
      cards: ordered.map(x => card(x, key, sort, hasFavorite(x.noteId))) };
  });
}
module.exports = { formatMetric, formatTime, sortNotes, boards, card, accountCard, BOARD_INFO, UNCONFIRMED_REASON };
