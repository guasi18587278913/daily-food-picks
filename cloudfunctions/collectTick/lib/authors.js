'use strict';
// Follower observations per author and the rising-account rule: within seven days the account gained at least 10% of
// its starting followers and at least 500 in absolute terms. A flat 1,000 favoured large accounts, whose weekly drift
// alone clears it; the rate makes a 5,000-follower account need 500 and a 200,000-follower account need 20,000.
// Every place that learns an author's follower count records it here; a bounded index keeps the tracked set small.
const { assertLease } = require('./budget');
const { ID } = require('./endpoints');
const HOUR = 3600000, DAY = 86400000;
// The blogger square is read once a day: one request ranks food accounts by growth, and a few follower curves turn
// that ranking into the seven-day numbers this board promises, including the day the account actually took off.
const PGY = Object.freeze({ category: '美食', listSize: 20, maxCurves: 6, maxAccounts: 6 });
const RULES = Object.freeze({ maxPoints: 40, keepDays: 14, maxTracked: 200, windowDays: 7, minimumGain: 500, minimumRate: 0.1,
  minimumSpanMs: 12 * HOUR, maxPerRound: 10, recheckPerRound: 8, recheckAfterMs: 20 * HOUR, recentNotes: 5, notesPerAccount: 3 });
const INDEX_ID = 'fans_history_index_v1';
// A re-check that answers nothing still moves the author to the back of the queue; otherwise a deleted account
// would be picked first in every round and spend one request each time.
async function markRecheckAttempt(store, lease, authorId, now) {
  if (!ID.test(authorId || '') || !Number.isFinite(now)) return false;
  return store.transaction(async tx => {
    await assertLease(tx, lease, now);
    const index = await tx.get('dfp_results', INDEX_ID);
    const current = index?.authors?.[authorId];
    if (!current) return false;
    await tx.put('dfp_results', INDEX_ID, { ...index, authors: { ...index.authors,
      [authorId]: { ...current, lastAttemptAt: now } }, updatedAt: now });
    return true;
  });
}
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
// Both bars must clear: the rate keeps large accounts' ordinary drift out, the floor keeps tiny accounts' noise out.
function qualifies(growth) {
  return !!growth && growth.gain >= RULES.minimumGain && growth.gain >= growth.fansBefore * RULES.minimumRate;
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
    authors[authorId] = { lastAttemptAt: authors[authorId]?.lastAttemptAt ?? null,
      lastObservedAt: doc.lastObservedAt, gain: growth ? growth.gain : null };
    await tx.put('dfp_results', INDEX_ID, { recordType: 'fans_history_index', authors, updatedAt: now });
    return true;
  });
}
// Authors whose follower count is stale, oldest first; the caller charges each re-check to the round's budget.
async function selectRecheck(store, now, limit = RULES.recheckPerRound) {
  const index = await store.get('dfp_results', INDEX_ID);
  return Object.entries(index?.authors || {})
    .filter(([id, x]) => ID.test(id) && Math.max(x.lastObservedAt || 0, x.lastAttemptAt || 0) <= now - RULES.recheckAfterMs)
    .sort((a, b) => Math.max(a[1].lastObservedAt || 0, a[1].lastAttemptAt || 0) - Math.max(b[1].lastObservedAt || 0, b[1].lastAttemptAt || 0)
      || a[0].localeCompare(b[0]))
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
    if (!qualifies(growth) || await publishedRecently(store, authorId, now)) continue;
    accounts.push({ authorId, author: doc.author || null, fans: growth.fans, fansBefore: growth.fansBefore, fansDelta: growth.gain,
      gainRate: growth.fansBefore > 0 ? Math.round(growth.gain / growth.fansBefore * 1000) / 1000 : null,
      observedAt: new Date(growth.observedAt).toISOString(), baselineAt: new Date(growth.baselineAt).toISOString(),
      spanHours: Math.round(growth.spanMs / HOUR), notes: (doc.recentNotes || []).slice(0, RULES.notesPerAccount) });
  }
  return accounts;
}
const dayKey = (now, back = 0) => new Date(now + 8 * 3600000 - back * DAY).toISOString().slice(0, 10);
const dailyId = now => `rising_daily_${dayKey(now)}`;
// A curve of daily gains becomes the seven-day figures: how many followers, at what rate, and which day carried it.
// The platform only publishes complete days, so the newest point is yesterday and the week ends there; counting today
// as well would silently make it a six-day window while the board still promised seven.
function growthFromCurve(blogger, points, now) {
  const from = dayKey(now, RULES.windowDays), to = dayKey(now, 1);
  // One entry per day, oldest first: a repeated date must be counted once, and the caller's order is not trusted.
  const byDate = new Map();
  // A day without a usable number is dropped rather than summed: NaN would clear both bars instead of failing them.
  for (const p of Array.isArray(points) ? points : []) {
    if (p && Number.isSafeInteger(p.gain) && p.date >= from && p.date <= to) byDate.set(p.date, p.gain);
  }
  const window = [...byDate.entries()].map(([date, gain]) => ({ date, gain })).sort((a, b) => a.date.localeCompare(b.date));
  if (!window.length || !Number.isSafeInteger(blogger.fans) || blogger.fans <= 0) return null;
  const gain = window.reduce((sum, p) => sum + p.gain, 0);
  const before = blogger.fans - gain;
  if (before <= 0) return null;
  const spike = window.reduce((best, p) => !best || p.gain > best.gain ? p : best, null);
  const first = window[0].date, last = window[window.length - 1].date;
  return { gain, rate: Math.round(gain / before * 1000) / 1000, fansBefore: before, fans: blogger.fans,
    // The span is the range the curve actually covers, so a curve missing days never claims a full week.
    spanHours: Math.round((Date.parse(`${last}T00:00:00.000Z`) - Date.parse(`${first}T00:00:00.000Z`)) / HOUR) + 24,
    observedAt: last, baselineAt: first,
    spikeDate: spike && spike.gain > 0 ? spike.date : null, spikeGain: spike && spike.gain > 0 ? spike.gain : null };
}
// Entries for the board: the same rule as the observed path, applied to the square's accounts.
function risingFromCurves(bloggers, curves, now, limit = PGY.maxAccounts) {
  const accounts = [];
  for (const blogger of bloggers) {
    const growth = growthFromCurve(blogger, curves.get(blogger.authorId), now);
    if (!growth || growth.gain < RULES.minimumGain || growth.rate < RULES.minimumRate) continue;
    accounts.push({ authorId: blogger.authorId, author: blogger.author || null, fans: growth.fans, fansBefore: growth.fansBefore,
      fansDelta: growth.gain, gainRate: growth.rate, spikeDate: growth.spikeDate, spikeGain: growth.spikeGain,
      observedAt: `${growth.observedAt}T00:00:00.000Z`, baselineAt: `${growth.baselineAt}T00:00:00.000Z`,
      spanHours: growth.spanHours, source: 'pgy', notes: [] });
  }
  // Ranked before the cap, so the accounts that survive it are the fastest growing rather than the first listed.
  return accounts.sort((a, b) => b.gainRate - a.gainRate || b.fansDelta - a.fansDelta || a.authorId.localeCompare(b.authorId))
    .slice(0, limit);
}
// A day's board says whether it is finished. An empty board left behind by a failed square is not the day's answer:
// it must not silence our own observations, and a later round has to be free to try again.
async function readDailyRising(store, now) {
  const record = await store.get('dfp_results', dailyId(now));
  return record && Array.isArray(record.accounts) ? { accounts: record.accounts, complete: record.complete === true } : null;
}
async function saveDailyRising(store, lease, accounts, meta, now) {
  return store.transaction(async tx => {
    await assertLease(tx, lease, now);
    await tx.put('dfp_results', dailyId(now), { recordType: 'rising_daily', day: dayKey(now), accounts, ...meta,
      complete: meta?.complete === true, updatedAt: now });
  });
}
module.exports = { RULES, PGY, INDEX_ID, historyId, publishedId, dailyId, dayKey, prunePoints, gainWithin, qualifies, summarize,
  growthFromCurve, risingFromCurves, readDailyRising, saveDailyRising, recordFansObservation, markRecheckAttempt, selectRecheck, publishedRecently, risingAccounts };
