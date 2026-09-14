'use strict';
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
const BOARD_INFO = {
  today: { name: '今日新锐', subtitle: '每日 06:00 筛选近 24 小时 · 至少 1,000 赞', sort: 'ratio', options: [['ratio', '倍数'], ['likes', '点赞'], ['collected', '收藏'], ['comments', '评论']] },
  week: { name: '本周热门', subtitle: '近 7 天 · 至少 1 万赞', sort: 'likes', options: [['likes', '点赞'], ['collected', '收藏'], ['comments', '评论']] },
  dark: { name: '低粉黑马', subtitle: '近 5 天 · 至少 300 赞 · 粉丝不超过 5,000', sort: 'likes', options: [['likes', '点赞'], ['fanRatio', '赞粉比'], ['collected', '收藏'], ['comments', '评论']] }
};
/** @param {FoodNote} note @param {string} board @param {string} sort @param {boolean} favorite */
function card(note, board, sort, favorite) {
  const big = sort === 'ratio' ? note.ratio : sort === 'fanRatio' ? note.fanRatio : sort === 'collected' ? note.collected : sort === 'comments' ? note.comments : note.likes;
  const unit = sort === 'ratio' || sort === 'fanRatio' ? '倍' : sort === 'collected' ? '收藏' : sort === 'comments' ? '评论' : '赞';
  const comparison = board === 'today' ? (note.baseline !== null && note.baseline > 0 ? `作者前 7 篇中位数 ${formatMetric(note.baseline)} 赞` : '作者参照不足，暂不计算倍数')
    : board === 'dark' ? `采集时 ${formatMetric(note.fans)} 粉丝` : `${formatMetric(note.collected)} 收藏 · ${formatMetric(note.comments)} 评论`;
  return { ...note, displayTitle: note.title || '打开原文看做法', big: formatMetric(big), unit, comparison,
    publishedLabel: formatTime(note.publishedAt), typeLabel: note.type === 'video' ? '视频' : '图文', favorite };
}
/** @param {FoodNote[]} notes @param {Record<string,string>} sorts @param {(id:string)=>boolean} hasFavorite */
function boards(notes, sorts, hasFavorite) {
  return /** @type {BoardKey[]} */ (['today', 'week', 'dark']).map(key => {
    const info = BOARD_INFO[key]; const sort = sorts[key] || info.sort;
    const rows = notes.filter(x => x.boards?.includes(key));
    return { key, name: info.name, subtitle: info.subtitle, count: rows.length,
      options: info.options.map(([value, label]) => ({ value, label, active: value === sort })),
      cards: sortNotes(rows, sort).map(x => card(x, key, sort, hasFavorite(x.noteId))) };
  });
}
module.exports = { formatMetric, formatTime, sortNotes, boards, card };
