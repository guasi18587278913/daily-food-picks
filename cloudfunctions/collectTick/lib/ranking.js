'use strict';

const metric = value => Number.isSafeInteger(value) && value >= 0;
function inWindow(note, end, days) {
  const at = Date.parse(note.publishedAt);
  return Number.isFinite(at) && at >= end - days * 86400000 && at < end;
}
function eligibleBoards(note, end, { allowUnknownFans = false } = {}) {
  if (!['video', 'normal'].includes(note.type) || !metric(note.likes)) return [];
  const boards = [];
  if (inWindow(note, end, 1) && note.likes >= 1000) boards.push('today');
  if (inWindow(note, end, 7) && note.likes >= 10000) boards.push('week');
  if (inWindow(note, end, 5) && ((metric(note.fans) && note.fans <= 5000) || (allowUnknownFans && note.fans === null))) boards.push('dark');
  return boards;
}
function historyBaseline(candidate, rawRows) {
  const fail = reason => ({ baseline: null, ratio: null, history: [], baselineReason: reason });
  const before = Date.parse(candidate.publishedAt);
  if (!Number.isFinite(before)) return fail('unknown_candidate_time');
  const unique = [...new Map(rawRows.filter(x => x.noteId !== candidate.noteId && x.authorId === candidate.authorId).map(x => [x.noteId, x])).values()];
  if (unique.some(x => x.sticky !== true && !Number.isFinite(Date.parse(x.publishedAt)))) return fail('unknown_history_time');
  const prior = unique.filter(x => Date.parse(x.publishedAt) < before && x.sticky !== true)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || b.noteId.localeCompare(a.noteId)).slice(0, 7);
  if (prior.length !== 7) return fail('fewer_than_seven');
  if (prior.some(x => x.sticky !== false)) return fail('unknown_pin_status');
  if (prior.some(x => !metric(x.likes))) return fail('missing_likes');
  const baseline = prior.map(x => x.likes).sort((a, b) => a - b)[3];
  const ratio = baseline > 0 && metric(candidate.likes) ? candidate.likes / baseline : null;
  return { baseline, ratio: Number.isFinite(ratio) ? Math.round(ratio * 10) / 10 : null,
    history: prior.map(x => ({ noteId: x.noteId, likes: x.likes })), baselineReason: baseline ? null : 'zero_baseline' };
}

module.exports = { inWindow, eligibleBoards, historyBaseline };
