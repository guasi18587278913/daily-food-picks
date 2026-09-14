'use strict';
const { digest, validateParams } = require('./provider');
const { endpoint } = require('./endpoints');
const { eligibleBoards } = require('./ranking');
const { previouslyPublished } = require('./publisher');
const { assertLease } = require('./budget');
const POLICY = require('../config/discovery.json');
const KEYWORDS = require('../config/keywords.json');
// Content jobs return posts for the candidate pool; the rest return leads (signals) or an author profile.
const yieldsNotes = kind => endpoint(kind)?.yields === 'notes';
const sourceKey = (kind, params) => `source_${digest([kind, Object.fromEntries(Object.entries(params).sort())]).slice(0, 48)}`;
const foodHint = text => POLICY.foodHints.some(h => String(text || '').toLowerCase().includes(h.toLowerCase()));
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
  if (seed.kind === 'search') params = { keyword: seed.params.keyword, note_type: seed.params.note_type || '不限',
    page: 1, sort_type: 'popularity_descending', time_filter: round.kind === 'sweep' ? '一天内' : '一周内',
    source: 'explore_feed', ai_mode: 0 };
  validateParams(seed.kind, params);
  return { id: digest([seed.kind, params]).slice(0, 48), kind: seed.kind, params,
    sourceKey: seed.key, label: seed.label, origin: seed.origin, status: 'pending' };
}
function rankSources(rows, statistics, now, explore) {
  const eligible = rows.filter(s => s.expiresAt > now && !(statistics[s.key]?.cooldownUntil > now));
  const quality = s => {
    const x = statistics[s.key] || {};
    return ((x.accepted || 0) + 1) / ((x.resolved || 0) + 2)
      * (((x.candidates || 0) + 1) / ((x.requests || 0) + 1));
  };
  return eligible.sort((a, b) => explore
    ? (statistics[a.key]?.lastUsedAt || 0) - (statistics[b.key]?.lastUsedAt || 0) || a.key.localeCompare(b.key)
    : quality(b) - quality(a) || a.key.localeCompare(b.key));
}
class Discovery {
  constructor({ store, lease, round, progress, clock = Date.now }) {
    Object.assign(this, { store, lease, round, progress, clock });
    this.ids = new Set(); this.sources = new Map();
  }
  async init() {
    const rows = await this.store.list('dfp_candidates', { limit: 100, filters: { roundId: this.round.id } });
    rows.forEach(r => this.ids.add(r.note.noteId));
    // A worker can stop after inserting a related note but before saving the queue. Reconcile on every resume.
    if (Array.isArray(this.progress.candidateIds)) {
      for (const row of rows.sort((a, b) => a.note.noteId.localeCompare(b.note.noteId)))
        if (!this.progress.candidateIds.includes(row.note.noteId)) this.progress.candidateIds.push(row.note.noteId);
    }
    const sources = await this.store.list('dfp_results', { limit: POLICY.maxSources, filters: { recordType: 'discovery_source' } });
    sources.forEach(s => this.sources.set(s.key, s));
    if (this.progress.discovery) return;
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
    const words = this.round.kind === 'sweep' ? KEYWORDS.dailySweep.keywords
      : KEYWORDS.groups[(day * 3 + Math.max(0, slot - 1)) % KEYWORDS.groups.length];
    const rotation = (day * 7 + Math.max(0, slot) * 3) % words.length;
    const fixed = Array.from({ length: this.round.kind === 'sweep' ? 12 : 4 }, (_, i) => source('search',
      { keyword: words[(rotation + Math.floor(i / 2)) % words.length], note_type: i % 2 ? '普通笔记' : '视频笔记' },
      words[(rotation + Math.floor(i / 2)) % words.length], 'keyword', this.clock()));
    const ranked = rankSources([...this.sources.values()], stats, this.clock(), explore).slice(0, 12);
    // A real post query comes before metadata, whose retries could otherwise consume the entire discovery budget.
    // Deliberately narrower than yieldsNotes: faved must pass a publicity check before it can be issued.
    const firstContent = !explore && ranked.find(s => ['search', 'topic', 'author'].includes(s.kind)) || fixed[0];
    const seeds = [firstContent, meta, ...ranked, ...fixed];
    this.progress.discovery = { jobs: [], index: 0, done: false, successfulContent: 0, freshContent: 0,
      successfulMetadata: 0, cacheHits: 0, relatedCandidates: 0, stopReason: null };
    for (const seed of seeds) { await this.remember(seed); this.enqueue(seed); }
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
    for (const note of notes) {
      if (!admitsCandidate(this.round, note) || await previouslyPublished(this.store, note.noteId)) continue;
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
        if (Array.isArray(this.progress.candidateIds) && !this.progress.candidateIds.includes(note.noteId)) this.progress.candidateIds.push(note.noteId);
        if (related) this.progress.discovery.relatedCandidates++;
      }
    }
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
    const target = this.round.candidateTarget || POLICY.candidateTarget[this.round.kind];
    if (state.index >= state.jobs.length || (this.ids.size >= target && state.freshContent > 0)) {
      state.done = true; state.stopReason = state.index >= state.jobs.length ? 'exhausted' : 'candidate_target'; return false;
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
      if (e.code === 'DISCOVERY_BUDGET') { state.done = true; state.stopReason = 'discovery_budget'; return false; }
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
module.exports = { Discovery, admitsCandidate, foodHint, source, sourceKey, jobFor, rankSources, finalizeStatistics, POLICY };
