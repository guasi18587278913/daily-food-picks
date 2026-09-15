'use strict';
// Follower observations per author and the rising-account rule (seven-day gain of at least 1,000 followers).
// Every place that learns an author's follower count records it here; a bounded index keeps the tracked set small.
const { assertLease } = require('./budget');
const { ID } = require('./endpoints');
const HOUR = 3600000, DAY = 86400000;
const RULES = Object.freeze({ maxPoints: 40, keepDays: 14, maxTracked: 200, windowDays: 7, minimumGain: 1000,
  minimumSpanMs: 12 * HOUR, maxPerRound: 10, recheckPerRound: 8, recheckAfterMs: 20 * HOUR, recentNotes: 5, notesPerAccount: 3 });
const INDEX_ID = 'fans_history_index_v1';
const historyId = authorId => `fans_${authorId}`;
const publishedId = authorId => `rising_published_${authorId}`;
const validAt = (at, now) => Number.isFinite(at) && at > 0 && at <= now;

function prunePoints(points, now) {
  const kept = new Map();
  for (const p of points) if (validAt(p?.at, now) && Number.isSafeInteger(p.fans) && p.fans >= 0 && p.at >= now - RULES.keepDays * DAY) kept.set(p.at, p.fans);
  return [...kept.entries()].map(([at, fans]) => ({ at, fans })).sort((a, b) => a.at - b.at).slice(-RULES.maxPoints);
}
// Gain within the window: newest observation against the oldest one still inside the window, at least twelve hours apart.
function gainWithin(points, now) {
  const window = points.filter(p => p.at >= now - RULES.windowDays * DAY && p.at <= now);
  if (window.length < 2) return null;
  const first = window[0], last = window[window.length - 1];
  if (last.at - first.at < RULES.minimumSpanMs) return null;
  return { gain: last.fans - first.fans, spanMs: last.at - first.at, baselineAt: first.at, fansBefore: first.fans, fans: last.fans, observedAt: last.at };
}
function summarize(doc, now) {
  const points = prunePoints(doc?.points || [], now);
  const latest = points[points.length - 1] || null;
  return { points, latest, growth: gainWithin(points, now) };
}
async function recordFansObservation(store, lease, { authorId, author, fans, at, note }, now) {
  if (!ID.test(authorId || '') || !Number.isSafeInteger(fans) || fans < 0 || !validAt(at, now)) return false;
  return store.transaction(async tx => {
    await assertLease(tx, lease, now);
    const index = (await tx.get('dfp_results', INDEX_ID)) || { recordType: 'fans_history_index', authors: {} };
    const authors = { ...index.authors };
    const old = await tx.get('dfp_results', historyId(authorId));
    if (!old && !authors[authorId] && Object.keys(authors).length >= RULES.maxTracked) {
      const victim = Object.entries(authors).sort((a, b) => (a[1].lastObservedAt || 0) - (b[1].lastObservedAt || 0) || a[0].localeCompare(b[0]))[0];
      if (victim) { delete authors[victim[0]]; await tx.remove('dfp_results', historyId(victim[0])); }
    }
    const points = prunePoints([...(old?.points || []), { at, fans }], now);
    const recentNotes = [...(old?.recentNotes || [])].filter(n => n?.noteId && n.noteId !== note?.noteId);
    if (note?.noteId) recentNotes.unshift({ noteId: note.noteId, title: String(note.title || '').slice(0, 120), likes: note.likes ?? null,
      collected: note.collected ?? null, publishedAt: note.publishedAt ?? null });
    const name = typeof author === 'string' && author.trim() ? author.slice(0, 120) : old?.author || null;
    const doc = { recordType: 'fans_history', authorId, author: name, points, recentNotes: recentNotes.slice(0, RULES.recentNotes),
      lastObservedAt: points[points.length - 1].at };
    await tx.put('dfp_results', historyId(authorId), doc);
    const growth = gainWithin(points, now);
    authors[authorId] = { author: name, lastObservedAt: doc.lastObservedAt, fans: doc.points[doc.points.length - 1].fans,
      gain: growth ? growth.gain : null, spanMs: growth ? growth.spanMs : null };
    await tx.put('dfp_results', INDEX_ID, { recordType: 'fans_history_index', authors, updatedAt: now });
    return true;
  });
}
// Authors whose follower count is stale, oldest first; the caller charges each re-check to the round's budget.
async function selectRecheck(store, now, limit = RULES.recheckPerRound) {
  const index = await store.get('dfp_results', INDEX_ID);
  return Object.entries(index?.authors || {})
    .filter(([id, x]) => ID.test(id) && (x.lastObservedAt || 0) <= now - RULES.recheckAfterMs)
    .sort((a, b) => (a[1].lastObservedAt || 0) - (b[1].lastObservedAt || 0) || a[0].localeCompare(b[0]))
    .slice(0, limit).map(([id]) => id);
}
async function publishedRecently(store, authorId, now) {
  const ref = await store.get('dfp_results', publishedId(authorId));
  return !!ref && Number.isFinite(ref.at) && ref.at > now - RULES.windowDays * DAY;
}
// Rising accounts for this round: indexed gains are only leads; the history document decides with the current clock.
async function risingAccounts(store, now, limit = RULES.maxPerRound) {
  const index = await store.get('dfp_results', INDEX_ID);
  const leads = Object.entries(index?.authors || {}).filter(([id, x]) => ID.test(id) && Number.isFinite(x.gain) && x.gain >= RULES.minimumGain)
    .sort((a, b) => b[1].gain - a[1].gain || a[0].localeCompare(b[0]));
  const accounts = [];
  for (const [authorId] of leads) {
    if (accounts.length >= limit) break;
    const doc = await store.get('dfp_results', historyId(authorId));
    const { growth } = summarize(doc, now);
    if (!growth || growth.gain < RULES.minimumGain || await publishedRecently(store, authorId, now)) continue;
    accounts.push({ authorId, author: doc.author || null, fans: growth.fans, fansBefore: growth.fansBefore, fansDelta: growth.gain,
      observedAt: new Date(growth.observedAt).toISOString(), baselineAt: new Date(growth.baselineAt).toISOString(),
      spanHours: Math.round(growth.spanMs / HOUR), notes: (doc.recentNotes || []).slice(0, RULES.notesPerAccount) });
  }
  return accounts;
}
module.exports = { RULES, INDEX_ID, historyId, publishedId, prunePoints, gainWithin, summarize, recordFansObservation, selectRecheck, publishedRecently, risingAccounts };
