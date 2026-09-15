'use strict';
const { digest, validateParams } = require('./provider');
const { endpoint } = require('./endpoints');
const { eligibleBoards } = require('./ranking');
const { previouslyPublished } = require('./publisher');
const { assertLease } = require('./budget');
const { cacheKey, readCache, maximumAge } = require('./reuse');
const POLICY = require('../config/discovery.json');
const KEYWORDS = require('../config/keywords.json');
// Content jobs return posts for the candidate pool; the rest return leads (signals) or an author profile.
const yieldsNotes = kind => endpoint(kind)?.yields === 'notes';
const sourceKey = (kind, params) => `source_${digest([kind, Object.fromEntries(Object.entries(params).sort())]).slice(0, 48)}`;
const foodHint = text => POLICY.foodHints.some(h => String(text || '').toLowerCase().includes(h.toLowerCase()));
// Search variants a keyword is tried with. In the audited 2026-09-14/15 rounds image notes never reached the 24-hour
// today threshold (0 of 80 results), so the 06:00 sweep searches videos only. Regular rounds add a collect-sorted
// video variant: saved-to-liked ratio separated cooking videos (median 0.84) from the rest (about 0.25).
const SWEEP_VARIANTS = Object.freeze([{ note_type: '视频笔记' }]);
const REGULAR_VARIANTS = Object.freeze([{ note_type: '视频笔记' }, { note_type: '普通笔记' },
  { note_type: '视频笔记', sort_type: 'collect_descending' }]);
const searchVariants = round => round.kind === 'sweep' ? SWEEP_VARIANTS : REGULAR_VARIANTS;
// Keywords that produced today picks in audited sweeps come first; the rest of the list keeps rotating daily.
function sweepKeywords() {
  const priority = KEYWORDS.dailySweep.priorityKeywords || [];
  return [...new Set([...priority, ...KEYWORDS.dailySweep.keywords])];
}
// The sweep only publishes today picks; author collections and image-note searches have not produced any.
function admitsSource(round, seed) {
  if (round.kind !== 'sweep') return true;
  if (['faved', 'user'].includes(seed.kind)) return false;
  return !(seed.kind === 'search' && seed.params?.note_type === '普通笔记');
}
function admitsCandidate(round, note) {
  const boards = eligibleBoards(note, round.scheduledAt, { allowUnknownFans: true });
  return round.kind === 'sweep' ? boards.includes('today') : boards.length > 0;
}
function source(kind, params, label, origin = kind, now = 0) {
  return { key: sourceKey(kind, params), kind, params, label: String(label || kind).slice(0, 120), origin,
    recordType: 'discovery_source', expiresAt: now + POLICY.sourceTtlMs };
}
function jobFor(seed, round) {
  let params = { ...seed.params };
  if (seed.kind === 'topic' && round.kind === 'sweep' && ['candidate-reserve-v1', 'candidate-reserve-v2'].includes(round.discoveryAllocation)) params.sort = 'time';
  if (seed.kind === 'search') params = { keyword: seed.params.keyword, note_type: seed.params.note_type || '不限',
    page: 1, sort_type: seed.params.sort_type === 'collect_descending' ? 'collect_descending' : 'popularity_descending',
    time_filter: round.kind === 'sweep' ? '一天内' : '一周内', source: 'explore_feed', ai_mode: 0 };
  validateParams(seed.kind, params);
  return { id: digest([seed.kind, params]).slice(0, 48), kind: seed.kind, params,
    sourceKey: seed.key, label: seed.label, origin: seed.origin, status: 'pending' };
}
function rankSources(rows, statistics, now, explore) {
  const eligible = rows.filter(s => s.expiresAt > now && !(statistics[s.key]?.cooldownUntil > now));
  // Weak priors: an untried source ranks below any source that has produced candidates and above one that returned
  // nothing, so exploit rounds prefer proven sources; explore rounds still try the least recently used first.
  const quality = s => {
    const x = statistics[s.key] || {};
    return ((x.accepted || 0) + 0.25) / ((x.resolved || 0) + 2)
      * (((x.candidates || 0) + 0.5) / ((x.requests || 0) + 1));
  };
  return eligible.sort((a, b) => explore
    ? (statistics[a.key]?.lastUsedAt || 0) - (statistics[b.key]?.lastUsedAt || 0) || a.key.localeCompare(b.key)
    : quality(b) - quality(a) || a.key.localeCompare(b.key));
}
class Discovery {
  constructor({ store, lease, round, progress, clock = Date.now }) {
    Object.assign(this, { store, lease, round, progress, clock });
    this.ids = new Set(); this.pendingIds = new Set(); this.sources = new Map();
  }
  async init() {
    const rows = await this.store.list('dfp_candidates', { limit: 100, filters: { roundId: this.round.id } });
    rows.forEach(r => this.ids.add(r.note.noteId));
    rows.filter(r => !['done', 'skipped'].includes(r.stage)).forEach(r => this.pendingIds.add(r.note.noteId));
    // A worker can stop after inserting a related note but before saving the queue. Reconcile on every resume.
    if (Array.isArray(this.progress.candidateIds)) {
      for (const row of rows.sort((a, b) => a.note.noteId.localeCompare(b.note.noteId)))
        if (!this.progress.candidateIds.includes(row.note.noteId)) this.progress.candidateIds.push(row.note.noteId);
    }
    const sources = await this.store.list('dfp_results', { limit: POLICY.maxSources, filters: { recordType: 'discovery_source' } });
    sources.forEach(s => this.sources.set(s.key, s));
    if (this.progress.discovery) {
      this.progress.discovery.candidateCount = this.ids.size;
      this.progress.discovery.pendingCandidateCount = this.pendingIds.size; return;
    }
    if (!sources.length) {
      const old = await this.store.list('dfp_notes', { limit: 20, descending: true });
      for (const { note } of old) if (note?.authorId) await this.remember(source('author', { user_id: note.authorId }, note.author, 'author', this.clock()));
    }
    const stats = (await this.store.get('dfp_results', 'source_statistics_v1'))?.sources || {};
    const day = Math.floor(this.round.scheduledAt / 86400000);
    const slot = [6, 9, 12, 20].indexOf(new Date(this.round.scheduledAt + 8 * 3600000).getUTCHours());
    const explore = (day + Math.max(0, slot)) % 4 === 0;
    const meta = source(explore ? 'inspiration' : 'hot', explore ? { cursor: '', tab: 0, source: 'creator_center' } : { cursor: '' },
      explore ? '创作主题' : '创作热点', explore ? 'inspiration' : 'hot', this.clock());
    const fixed = this.fixedSearchSeeds(day, slot);
    const ranked = rankSources([...this.sources.values()].filter(s => admitsSource(this.round, s)), stats, this.clock(), explore).slice(0, 12);
    // A real post query comes before metadata, whose retries could otherwise consume the entire discovery budget.
    // Deliberately narrower than yieldsNotes: faved must pass a publicity check before it can be issued.
    const firstContent = !explore && ranked.find(s => ['search', 'topic', 'author'].includes(s.kind)) || fixed[0];
    const seeds = [firstContent, meta, ...ranked, ...fixed];
    this.progress.discovery = { jobs: [], index: 0, done: false, successfulContent: 0, freshContent: 0,
      successfulMetadata: 0, cacheHits: 0, relatedCandidates: 0, candidateCount: this.ids.size,
      pendingCandidateCount: this.pendingIds.size, stopReason: null };
    for (const seed of seeds) { await this.remember(seed); this.enqueue(seed); }
  }
  fixedSearchSeeds(day, slot) {
    const sweep = this.round.kind === 'sweep';
    const words = sweep ? sweepKeywords() : KEYWORDS.groups[(day * 3 + Math.max(0, slot - 1)) % KEYWORDS.groups.length];
    const rotation = (day * 7 + Math.max(0, slot) * 3) % words.length;
    const priority = sweep ? (KEYWORDS.dailySweep.priorityKeywords || []).slice(0, 12) : [];
    const rotating = words.filter(w => !priority.includes(w));
    const count = sweep ? 12 - priority.length : 2;
    const chosen = [...new Set([...priority, ...Array.from({ length: rotating.length ? count : 0 },
      (_, i) => rotating[(rotation + i) % rotating.length])])];
    return chosen.flatMap(keyword => searchVariants(this.round).map(variant =>
      source('search', { keyword, ...variant }, keyword, 'keyword', this.clock())));
  }
  enqueue(seed, next = false) {
    const state = this.progress.discovery;
    if (state.jobs.length >= POLICY.maxTasks) return;
    let job;
    try { job = jobFor(seed, this.round); } catch { return; }
    const existing = state.jobs.find(j => j.id === job.id);
    if (existing) {
      if (existing.status !== 'publicity_check_required' || !Number.isFinite(seed.publicValidatedAt)) return;
      job.id += '-public';
      if (state.jobs.some(j => j.id === job.id)) return;
    }
    if (next) state.jobs.splice(state.index + 1, 0, job); else state.jobs.push(job);
  }
  async remember(seed) {
    const victim = !this.sources.has(seed.key) && this.sources.size >= POLICY.maxSources
      ? [...this.sources.values()].sort((a, b) => a.expiresAt - b.expiresAt || a.key.localeCompare(b.key))[0] : null;
    await this.store.transaction(async tx => {
      await assertLease(tx, this.lease, this.clock());
      const old = await tx.get('dfp_results', seed.key);
      if (victim) await tx.remove('dfp_results', victim.key);
      await tx.put('dfp_results', seed.key, { ...old, ...seed });
    });
    if (victim) this.sources.delete(victim.key);
    this.sources.set(seed.key, { ...this.sources.get(seed.key), ...seed });
    return true;
  }
  async profile(authorId, value, label) {
    if (value.collectionsPublic !== true) return;
    const seed = { ...source('faved', { user_id: authorId, cursor: '' }, label || '公开收藏', 'faved', this.clock()),
      publicValidatedAt: value.fetchedAt };
    if (await this.remember(seed)) this.enqueue(seed, true);
  }
  async signals(result, job) {
    for (const signal of (result.signals || []).slice().reverse()) {
      if (!foodHint(signal.label)) continue;
      let seed;
      if (signal.pageId) seed = source('topic', { page_id: signal.pageId, sort: this.round.kind === 'sweep' ? 'time' : 'trend' }, signal.label, job.origin, this.clock());
      else if (signal.label.length <= 60) seed = source('search', { keyword: signal.label, note_type: '不限' }, signal.label, job.origin, this.clock());
      if (seed && await this.remember(seed)) this.enqueue(seed, true);
    }
  }
  async addNotes(notes, origin, related = false) {
    for (let note of notes) {
      if (!admitsCandidate(this.round, note) || await previouslyPublished(this.store, note.noteId)) continue;
      if (this.round.discoveryAllocation === 'candidate-reserve-v2' && note.fans === null
        && eligibleBoards(note, this.round.scheduledAt, { allowUnknownFans: true }).every(b => b === 'dark')) {
        try {
          const now = this.clock(), requestKey = `user:${digest({ user_id: note.authorId })}`;
          const cached = await readCache(this.store, cacheKey('result', requestKey),
            { now, maxAgeMs: 21600000, version: 'discovery-provider-1' });
          if (cached && now - cached.capturedAt <= maximumAge('user', cached.value, now)
            && Number.isSafeInteger(cached.value.fans) && cached.value.fans >= 0) {
            note = { ...note, fans: cached.value.fans };
            if (!admitsCandidate(this.round, note)) {
              this.progress.discovery.knownHighFanExcluded = (this.progress.discovery.knownHighFanExcluded || 0) + 1;
              continue;
            }
          }
        } catch { /* A missing author cache is unknown, never a hidden paid lookup. */ }
      }
      const id = `${this.round.id}_${note.noteId}`;
      const old = await this.store.get('dfp_candidates', id);
      if (!old && this.ids.size >= POLICY.maxCandidates) {
        if (!this.progress.gaps.includes('CANDIDATE_CAP')) this.progress.gaps.push('CANDIDATE_CAP');
        continue;
      }
      await this.store.transaction(async tx => {
        await assertLease(tx, this.lease, this.clock());
        const current = await tx.get('dfp_candidates', id);
        if (current?.note.authorId && current.note.authorId !== note.authorId) return;
        const origins = [...(current?.origins || [])];
        if (!origins.some(x => x.key === origin.key) && origins.length < 8) origins.push(origin);
        const updated = current && current.stage === 'detail' && !current.note.bodyComplete
          && Date.parse(note.fetchedAt) > Date.parse(current.note.fetchedAt)
          ? { ...current, note, stage: note.bodyComplete ? 'judge' : 'detail' } : current;
        await tx.put('dfp_candidates', id, current ? { ...updated, origins }
          : { roundId: this.round.id, stage: note.bodyComplete ? 'judge' : 'detail', note, origins });
      });
      if (!old) {
        this.ids.add(note.noteId);
        this.pendingIds.add(note.noteId);
        this.progress.discovery.candidateCount = this.ids.size;
        this.progress.discovery.pendingCandidateCount = this.pendingIds.size;
        if (Array.isArray(this.progress.candidateIds) && !this.progress.candidateIds.includes(note.noteId)) this.progress.candidateIds.push(note.noteId);
        if (related) this.progress.discovery.relatedCandidates++;
      }
    }
  }
  resolved(noteId) {
    this.pendingIds.delete(noteId);
    this.progress.discovery.pendingCandidateCount = this.pendingIds.size;
  }
  reopen() {
    const state = this.progress.discovery;
    if (this.round.discoveryAllocation !== 'candidate-reserve-v2' || !state.done || this.pendingIds.size
      || this.ids.size >= POLICY.maxCandidates || (this.progress.aiCalls || 0) >= 20
      || this.clock() >= this.round.closesAt - 300000
      || !['candidate_target', 'inspection_reserve'].includes(state.stopReason)
      || state.lastRefillProcessed === this.progress.candidateIndex) return false;
    state.lastRefillProcessed = this.progress.candidateIndex;
    state.refillPasses = (state.refillPasses || 0) + 1;
    state.refillNeedsOrdering = true;
    state.done = false; state.stopReason = null;
    return true;
  }
  async rememberCooking(note, origin = 'author') {
    if (note.judgment?.verdict !== 'cooking') return;
    await this.remember(source('author', { user_id: note.authorId }, note.author, 'author', this.clock()));
    await this.remember(source('user', { user_id: note.authorId }, `${note.author}的公开收藏`, 'faved', this.clock()));
    for (const topic of (note.topics || []).filter(x => foodHint(x.label)).slice(0, 2))
      await this.remember(source('topic', { page_id: topic.pageId, sort: 'trend' }, topic.label, origin, this.clock()));
  }
  async step(provider) {
    const state = this.progress.discovery;
    if (state.done) return false;
    const refill = this.round.discoveryAllocation === 'candidate-reserve-v2';
    const originalTarget = this.round.candidateTarget || POLICY.candidateTarget[this.round.kind];
    const target = refill ? Math.max(1, Math.min(originalTarget, 20 - (this.progress.aiCalls || 0),
      POLICY.maxCandidates - this.ids.size + this.pendingIds.size)) : originalTarget;
    const candidateCount = refill ? this.pendingIds.size : this.ids.size;
    const dynamic = ['candidate-reserve-v1', 'candidate-reserve-v2'].includes(this.round.discoveryAllocation);
    if (dynamic && this.clock() >= this.round.closesAt - 300000) {
      state.done = true; state.stopReason = 'inspection_time_reserve'; return false;
    }
    if (dynamic && state.index >= state.jobs.length && candidateCount < target) {
      // Continue unused, type-specific searches only when the first source batch was too sparse.
      const words = this.round.kind === 'sweep' ? sweepKeywords() : [...new Set(KEYWORDS.groups.flat())];
      for (const word of words) for (const variant of searchVariants(this.round)) {
        if (state.jobs.length >= POLICY.maxTasks) break;
        const seed = source('search', { keyword: word, ...variant }, word, 'keyword', this.clock());
        const previousSize = state.jobs.length;
        this.enqueue(seed);
        if (state.jobs.length > previousSize) await this.remember(seed);
      }
    }
    if (state.index >= state.jobs.length || (candidateCount >= target && state.freshContent > 0)) {
      state.done = true; state.stopReason = state.index >= state.jobs.length
        ? state.jobs.length >= POLICY.maxTasks ? 'task_cap' : 'exhausted' : 'candidate_target'; return false;
    }
    const job = state.jobs[state.index];
    if (job.kind === 'faved') {
      const seed = this.sources.get(job.sourceKey);
      if (!Number.isFinite(seed?.publicValidatedAt) || seed.publicValidatedAt > this.clock()
        || this.clock() - seed.publicValidatedAt > 6 * 3600000) {
        job.status = 'publicity_check_required';
        this.enqueue(source('user', { user_id: job.params.user_id }, job.label, 'faved', this.clock()), true);
        state.index++; return true;
      }
    }
    try {
      const result = await provider.request(job.kind, job.params, { purpose: 'discovery', sourceKey: job.sourceKey,
        forceFresh: yieldsNotes(job.kind) && state.freshContent === 0 });
      if (result.cacheWarning && !this.progress.gaps.includes('CACHE_UNAVAILABLE')) this.progress.gaps.push('CACHE_UNAVAILABLE');
      if (result.cached) state.cacheHits++;
      if (yieldsNotes(job.kind)) {
        const notes = await provider.notes(result);
        await this.addNotes(notes, { key: job.sourceKey, type: job.origin, label: job.label });
        state.successfulContent++; if (!result.cached) state.freshContent++;
        if (job.kind === 'faved') for (const note of notes.filter(n => foodHint(n.title + n.desc)).slice(0, 2)) {
          const seed = source('author', { user_id: note.authorId }, note.author, 'faved', this.clock());
          if (await this.remember(seed)) this.enqueue(seed, true);
        }
      } else {
        state.successfulMetadata++;
        if (job.kind === 'user') await this.profile(job.params.user_id, result, job.label);
        else await this.signals(result, job);
      }
      job.status = 'complete';
    } catch (e) {
      if (['DISCOVERY_BUDGET', 'DISCOVERY_INSPECTION_RESERVE'].includes(e.code)) {
        state.done = true; state.stopReason = e.code === 'DISCOVERY_BUDGET' ? 'discovery_budget' : 'inspection_reserve'; return false;
      }
      if (['TICK_LIMIT', 'DAILY_BUDGET', 'ROUND_BUDGET', 'VALIDATION_BUDGET', 'SUPPLEMENT_BUDGET', 'PROVIDER_AUTH', 'LEASE_EXPIRED'].includes(e.code)) throw e;
      job.status = 'failed'; job.errorCode = e.code || 'REQUEST_FAILED';
      if (!this.progress.gaps.includes('REQUEST_FAILED')) this.progress.gaps.push('REQUEST_FAILED');
    }
    state.index++; return true;
  }
}
async function finalizeStatistics({ store, lease, round, progress, rows, now }) {
  if (!progress.discovery) return;
  const attempts = await store.list('dfp_attempts', { limit: 100, filters: { roundId: round.id } });
  const delta = {};
  const item = key => delta[key] ||= { requests: 0, candidates: 0, resolved: 0, accepted: 0, errors: 0 };
  for (const attempt of attempts) if (attempt.sourceKey) {
    const x = item(attempt.sourceKey); x.requests++;
    if (['failed', 'unknown'].includes(attempt.status)) x.errors++;
  }
  for (const row of rows) {
    const key = row.origins?.[0]?.key; if (!key) continue;
    const x = item(key); x.candidates++;
    if (['accepted', 'rejected_content', 'rejected_metrics'].includes(row.outcome)) x.resolved++;
    if (row.outcome === 'accepted') x.accepted++;
  }
  await store.transaction(async tx => {
    await assertLease(tx, lease, now);
    const current = await tx.get('dfp_rounds', round.id);
    if (current?.discoveryStatsApplied) return;
    const aggregate = await tx.get('dfp_results', 'source_statistics_v1') || { sources: {} };
    const sources = { ...aggregate.sources };
    for (const [key, change] of Object.entries(delta)) {
      if (!sources[key] && Object.keys(sources).length >= POLICY.maxSources) {
        const victim = Object.keys(sources).filter(k => !delta[k]).sort((a, b) =>
          (sources[a].lastUsedAt || 0) - (sources[b].lastUsedAt || 0) || a.localeCompare(b))[0];
        if (!victim) continue;
        delete sources[victim];
      }
      const previous = sources[key] || {};
      const next = { ...previous, lastUsedAt: now };
      for (const field of ['requests', 'candidates', 'resolved', 'accepted', 'errors']) next[field] = (previous[field] || 0) + change[field];
      if (change.requests && change.errors === change.requests) next.cooldownUntil = now + POLICY.cooldownMs;
      sources[key] = next;
    }
    await tx.put('dfp_results', 'source_statistics_v1', { recordType: 'discovery_statistics', sources, updatedAt: now });
    await tx.put('dfp_rounds', round.id, { ...current, discoveryStatsApplied: true });
  });
}
module.exports = { Discovery, admitsCandidate, admitsSource, foodHint, source, sourceKey, jobFor, rankSources, searchVariants, sweepKeywords, finalizeStatistics, POLICY };
