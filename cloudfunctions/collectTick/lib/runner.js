'use strict';

const { randomUUID } = require('node:crypto');
const { claimLease, releaseLease, assertLease, validatePrice } = require('./budget');
const { scheduledRound, sweepWindow, error } = require('./config');
const { Provider, verifyPrice } = require('./provider');
const { eligibleBoards, historyBaseline, inWindow } = require('./ranking');
const { judgeNote, needsTextModel } = require('./judge');
const { publish, previouslyPublished, readSnapshot, storeCover } = require('./publisher');
const KEYWORDS = require('../config/keywords.json');
const RULES = require('../config/rules.json');
const { Discovery, finalizeStatistics, sourceKey } = require('./discovery');
const { cachedJudgment, cacheJudgment, reviewVideo } = require('./content-review');

function searches(round) {
  if (round.kind === 'sweep') {
    const sweep = KEYWORDS.dailySweep;
    return sweep.keywords.map(keyword => ({ keyword, note_type: sweep.noteType, page: 1,
      sort_type: 'popularity_descending', time_filter: sweep.timeFilter, source: 'explore_feed', ai_mode: 0 }));
  }
  const day = Math.floor(round.scheduledAt / 86400000);
  const slot = [9, 12, 20].indexOf(new Date(round.scheduledAt + 8 * 3600000).getUTCHours());
  const group = KEYWORDS.groups[(day * 3 + Math.max(0, slot)) % KEYWORDS.groups.length];
  return group.flatMap(keyword => KEYWORDS.noteTypes.map(note_type => ({ keyword, note_type, page: 1,
    sort_type: 'popularity_descending', time_filter: '一周内', source: 'explore_feed', ai_mode: 0 })));
}
// The 06:00 sweep only admits today candidates; week and dark candidates keep coming from the regular rounds.
function admitsCandidate(round, note) {
  const boards = eligibleBoards(note, round.scheduledAt, { allowUnknownFans: true });
  return round.kind === 'sweep' ? boards.includes('today') : boards.length > 0;
}
function prioritizeRecipeClues(rows) {
  const score = row => {
    const body = String(row.note.desc || '').replace(/#[^#]*#/g, ' ');
    return (/食材|用料|配方|步骤|制作方法/.test(body) ? 2 : 0)
      + (/\d+(?:\.\d+)?\s*(?:kg|ml|g|克|毫升|个|勺)/i.test(body) ? 1 : 0)
      + (/教程|做法|自制|怎么做|这样做/.test(row.note.title || '') ? 1 : 0);
  };
  const ordered = [];
  for (let level = 4; level >= 0; level--) {
    const group = rows.filter(row => score(row) === level)
      .sort((a, b) => (b.note.likes ?? -1) - (a.note.likes ?? -1) || a.note.noteId.localeCompare(b.note.noteId));
    while (group.length) { ordered.push(group.shift()); if (group.length) ordered.push(group.pop()); }
  }
  return ordered;
}
function prioritizeCandidates(rows, round) {
  const ordered = prioritizeRecipeClues(rows);
  if (round?.kind !== 'regular' || !Number.isFinite(round.scheduledAt)) return ordered;
  const queues = { week: [], dark: [], today: [], other: [] };
  for (const row of ordered) {
    const boards = eligibleBoards(row.note, round.scheduledAt, { allowUnknownFans: true });
    const group = boards.includes('week') ? 'week' : boards.includes('today') ? 'today' : boards.includes('dark') ? 'dark' : 'other';
    queues[group].push(row);
  }
  const result = [];
  while (queues.week.length || queues.dark.length || queues.today.length) {
    for (const group of ['week', 'dark', 'today']) if (queues[group].length) result.push(queues[group].shift());
  }
  return [...result, ...queues.other];
}
async function saveProgress(store, lease, roundId, progress, clock) {
  await store.transaction(async tx => {
    await assertLease(tx, lease, clock());
    const round = await tx.get('dfp_rounds', roundId);
    if (round?.status !== 'running') throw error('ROUND_NOT_RUNNING');
    await tx.put('dfp_rounds', roundId, { ...round, progress });
  });
}
async function candidateRows(store, roundId) {
  const rows = []; let after = '';
  for (let page = 0; page < 4; page++) {
    const batch = await store.list('dfp_candidates', { limit: 100, after, filters: { roundId } });
    rows.push(...batch.filter(row => row.roundId === roundId));
    if (batch.length < 100) break;
    after = batch.at(-1)._id;
  }
  return rows;
}
function finishStatus(reason) { return /BUDGET/.test(reason || '') ? 'budget_exhausted' : 'failed'; }
const REASONS = {
  COVER_UNAVAILABLE: '部分封面暂未保存，正文仍可查看。',
  ROUND_BUDGET: '本轮数据调用额度已用完，保留已完成的选题。', DAILY_BUDGET: '今日数据调用额度已用完，保留已完成的选题。',
  VALIDATION_BUDGET: '首次验证额度已用完，保留已完成的选题。', WINDOW_ENDED: '本轮更新窗口已结束，部分候选尚未完成。',
  MODEL_UNAVAILABLE: '内容判断服务暂不可用，保留已完成的选题。', PROVIDER_AUTH: '数据服务授权异常，本轮已停止。',
  CANDIDATE_CAP: '本轮候选较多，按限定范围完成了一部分。', REQUEST_FAILED: '部分数据请求失败，保留已完成的选题。',
  AI_CALL_CAP: '本轮内容判断次数已达上限，保留已完成的选题。',
  SUPPLEMENT_BUDGET: '已为后续正式轮次保留额度，临时补跑结束。',
  SWEEP_UNAVAILABLE: '今天 06:00 的今日新锐没有更新成功，本轮只展示新找到的选题。',
  CARRY_UNAVAILABLE: '今天 06:00 的今日新锐读取失败，本轮只展示新找到的选题。',
  CACHE_UNAVAILABLE: '部分复用数据不可用，已保留完成的检查结果。',
  VISION_UNAVAILABLE: '视频画面复核暂不可用，部分视频尚未确认。',
  VISION_BUDGET: '视频画面复核额度已用完，部分视频尚未确认。',
  VIDEO_UNAVAILABLE: '部分视频画面无法读取，尚未确认其制作内容。'
};
function describeGaps(gaps) {
  return gaps.map(x => REASONS[x] || REASONS.REQUEST_FAILED).filter((v, i, a) => a.indexOf(v) === i).join(' ');
}
// Today picks refresh once at 06:00. Later rounds that day show the same notes again, with any week board they also
// earned, without recommending them again. A missing, unpublished or unreadable sweep is reported, never shown as empty.
async function sameDaySweepPicks(store, round) {
  const sweep = sweepWindow(round.scheduledAt);
  if (round.kind === 'sweep' || !round.sweepEnabled || round.scheduledAt < sweep.closesAt) return { notes: [], summary: null };
  let record = null;
  const unavailable = errorCode => ({ notes: [], summary: { snapshotId: record?.snapshotId ?? null, count: 0, errorCode } });
  try {
    record = await store.get('dfp_rounds', sweep.id);
    if (!record) return unavailable('SWEEP_MISSING');
    if (!record.snapshotId) return unavailable('SWEEP_NOT_PUBLISHED');
    const notes = (await readSnapshot(store, record.snapshotId)).notes.filter(note => note.boards?.includes('today'));
    return { notes, summary: { snapshotId: record.snapshotId, count: notes.length } };
  } catch (e) {
    // This round's own picks must still publish; the degraded carry is recorded and marks the round partial.
    return unavailable(['NOT_FOUND', 'CORRUPT_SNAPSHOT'].includes(e.code) ? e.code : 'CARRY_READ_FAILED');
  }
}
async function conclude({ store, lease, round, progress, reason, clock }) {
  const rows = await candidateRows(store, round.id);
  await finalizeStatistics({ store, lease, round, progress, rows, now: clock() });
  const notes = rows.filter(x => x.stage === 'done' && x.note.boards?.length).map(x => x.note);
  // Reaching the window end is not a coverage gap when every search and candidate had already finished.
  const workFinished = Array.isArray(progress.candidateIds) && (progress.candidateIndex || 0) >= progress.candidateIds.length;
  const reasonGaps = !reason || (reason === 'WINDOW_ENDED' && workFinished) ? [] : [reason];
  const gaps = [...new Set([...(progress.gaps || []), ...reasonGaps])];
  const coverage = { keywords: searches(round).map(x => x.keyword).filter((v, i, a) => a.indexOf(v) === i),
    pagesPerQuery: 1, successfulSearches: progress.successfulSearches, candidateCount: progress.candidateIds?.length || rows.length,
    processed: progress.candidateIndex || 0, gaps, notice: round.kind === 'sweep' ? KEYWORDS.dailySweep.coverageNotice : KEYWORDS.coverageNotice,
    ruleVersion: RULES.version, ...(round.supplement ? { supplement: true } : {}) };
  if (round.supplement) coverage.notice = `临时补跑。${coverage.notice}`;
  if (progress.discovery) {
    coverage.discovery = { successfulContent: progress.discovery.successfulContent, freshContent: progress.discovery.freshContent,
      successfulMetadata: progress.discovery.successfulMetadata, cacheHits: progress.discovery.cacheHits,
      relatedCandidates: progress.discovery.relatedCandidates, stopReason: progress.discovery.stopReason,
      completedSources: progress.discovery.jobs.filter(j => j.status === 'complete').map(j => ({ type: j.origin, label: j.label })) };
    coverage.keywords = progress.discovery.jobs.filter(j => j.kind === 'search' && j.status === 'complete').map(j => j.params.keyword);
    coverage.notice = '从平台热点、话题、作者及关键词等入口按额度筛选，并非全站完整榜单。';
    coverage.judgmentCacheHits = progress.judgmentCacheHits || 0;
    coverage.vision = { checked: progress.visionChecked || 0, cacheHits: progress.visionCacheHits || 0 };
  }
  // A rejected query does not erase completed searches. Total provider failure or an unavailable
  // classifier still retains the old snapshot; partial discovery can publish an honest zero result.
  const serviceFailed = ['PROVIDER_AUTH', 'MODEL_UNAVAILABLE', 'VISION_UNAVAILABLE'].includes(reason)
    || gaps.includes('VISION_UNAVAILABLE') || gaps.includes('MODEL_UNAVAILABLE');
  if (!notes.length && (!progress.successfulSearches || serviceFailed)) {
    const status = finishStatus(reason);
    await store.transaction(async tx => {
      await assertLease(tx, lease, clock());
      const current = await tx.get('dfp_rounds', round.id);
      const update = { status, finishedAt: new Date(clock()).toISOString(), partialReason: describeGaps(gaps) || REASONS.REQUEST_FAILED, coverage };
      await tx.put('dfp_rounds', round.id, { ...current, ...update });
      await tx.put('dfp_state', 'status', { ...update, roundId: round.id, scheduledAt: new Date(round.scheduledAt).toISOString() });
    });
    return { roundId: round.id, status, reason: reason || 'REQUEST_FAILED' };
  }
  const carried = await sameDaySweepPicks(store, round);
  const carryError = carried.summary?.errorCode;
  // A failed read of the 06:00 picks is retried by later ticks in this window; only the window end publishes without them.
  if (carryError === 'CARRY_READ_FAILED' && !reason && clock() < round.closesAt - 10000) return { roundId: round.id, status: 'running' };
  const carryGaps = !carryError ? [] : [['SWEEP_MISSING', 'SWEEP_NOT_PUBLISHED'].includes(carryError) ? 'SWEEP_UNAVAILABLE' : 'CARRY_UNAVAILABLE'];
  const publishedGaps = [...gaps, ...carryGaps];
  const result = await publish({ store, lease, round, notes, carriedNotes: carried.notes, status: publishedGaps.length ? 'partial' : 'complete',
    coverage: { ...coverage, gaps: publishedGaps, carriedToday: carried.summary },
    partialReason: (!notes.length && publishedGaps.length ? '本轮已扫描，但未选出新作品。' : '') + describeGaps(publishedGaps),
    successfulSearches: progress.successfulSearches, clock });
  return { roundId: round.id, status: result.status, snapshotId: result.id };
}

async function runTick({ store, config, key, generate, upload, visionKey, review = reviewVideo, clock = Date.now, verify = verifyPrice,
  makeProvider = options => new Provider(options) }) {
  if (!config.enabled) return { status: 'disabled' };
  if (!config.freeAiConfirmed) throw error('FREE_AI_NOT_CONFIRMED');
  const started = clock();
  const deadline = started + 150000;
  const lease = await claimLease(store, { owner: randomUUID(), now: started });
  if (!lease) return { status: 'busy' };
  let round; let progress;
  try {
    // The final minute-20 trigger closes an unfinished window without issuing more requests.
    const active = await store.get('dfp_state', 'active');
    if (active?.roundId) {
      const unfinished = await store.get('dfp_rounds', active.roundId);
      if (unfinished?.status === 'running' && started >= unfinished.closesAt) {
        await conclude({ store, lease, round: unfinished.definition, progress: unfinished.progress, reason: 'WINDOW_ENDED', clock });
      }
    }
    round = scheduledRound(clock(), config);
    if (!round) return { status: 'outside_window' };
    const stored = await store.get('dfp_rounds', round.id);
    if (stored && stored.status !== 'running') return { roundId: round.id, status: stored.status, snapshotId: stored.snapshotId || null };
    // Resume with the accepted round definition; changing configuration must not reshape work already in progress.
    if (stored?.definition) round = stored.definition;
    progress = stored?.progress || { searchIndex: 0, successfulSearches: 0, candidateIds: null, candidateIndex: 0, aiCalls: 0, gaps: [] };
    if (!stored) await store.transaction(async tx => {
      await assertLease(tx, lease, clock());
      await tx.create('dfp_rounds', round.id, { status: 'running', definition: round, closesAt: round.closesAt,
        ruleVersion: RULES.version, startedAt: new Date(clock()).toISOString(), scheduledAt: new Date(round.scheduledAt).toISOString(),
        progress, calls: 0, microUsd: 0, day: round.day });
      await tx.put('dfp_state', 'active', { roundId: round.id });
      await tx.put('dfp_state', 'status', { roundId: round.id, status: 'running', scheduledAt: new Date(round.scheduledAt).toISOString(), finishedAt: null, partialReason: null });
    });
    let price = await store.get('dfp_state', 'price');
    try { validatePrice(price, clock()); } catch { price = await verify(undefined, clock()); await store.put('dfp_state', 'price', price); }
    validatePrice(price, clock());
    const provider = makeProvider({ store, lease, config, round, price, key, clock });
    const queries = searches(round);
    const adaptive = round.discoveryMode === 'adaptive';
    const discovery = adaptive ? new Discovery({ store, lease, round, progress, clock }) : null;
    if (discovery) { await discovery.init(); await saveProgress(store, lease, round.id, progress, clock); }
    while (clock() < deadline - 45000 && clock() < round.closesAt - 10000) {
      if (discovery && !progress.discovery.done) {
        await discovery.step(provider);
        // Metadata can discover directions but cannot establish a successful scan of actual posts.
        progress.successfulSearches = progress.discovery.freshContent;
        await saveProgress(store, lease, round.id, progress, clock);
        continue;
      }
      if (!adaptive && progress.searchIndex < queries.length) {
        try {
          const result = await provider.request('search', queries[progress.searchIndex]);
          for (const note of await provider.notes(result)) {
            if (!admitsCandidate(round, note) || await previouslyPublished(store, note.noteId)) continue;
            const docId = `${round.id}_${note.noteId}`;
            if (!await store.get('dfp_candidates', docId)) await store.put('dfp_candidates', docId, { roundId: round.id, stage: 'detail', note });
          }
          progress.successfulSearches++;
        } catch (e) {
          if (['TICK_LIMIT', 'DAILY_BUDGET', 'ROUND_BUDGET', 'VALIDATION_BUDGET', 'SUPPLEMENT_BUDGET', 'PROVIDER_AUTH', 'LEASE_EXPIRED'].includes(e.code)) throw e;
          progress.gaps.push('REQUEST_FAILED');
        }
        progress.searchIndex++;
        await saveProgress(store, lease, round.id, progress, clock);
        continue;
      }
      if (progress.candidateIds === null) {
        const rows = await candidateRows(store, round.id);
        // Give each board an inspection opportunity; admission still requires validated model evidence.
        const ordered = prioritizeCandidates(rows, round);
        progress.candidateIds = ordered.slice(0, 40).map(x => x.note.noteId);
        if (ordered.length > 40) progress.gaps.push('CANDIDATE_CAP');
        await saveProgress(store, lease, round.id, progress, clock);
      }
      if (progress.candidateIndex >= progress.candidateIds.length) return await conclude({ store, lease, round, progress, clock });
      const noteId = progress.candidateIds[progress.candidateIndex];
      const docId = `${round.id}_${noteId}`;
      const row = await store.get('dfp_candidates', docId);
      if (!row) throw error('MISSING_CANDIDATE');
      const save = (withProgress = false) => store.transaction(async tx => {
        await assertLease(tx, lease, clock());
        const current = withProgress ? await tx.get('dfp_rounds', round.id) : null;
        if (withProgress && current?.status !== 'running') throw error('ROUND_NOT_RUNNING');
        await tx.put('dfp_candidates', docId, row);
        if (withProgress) await tx.put('dfp_rounds', round.id, { ...current, progress });
      });
      try {
        if (row.stage === 'detail') {
          const result = await provider.request(row.note.type === 'video' ? 'note_video' : 'note_image', { note_id: noteId },
            { expectedNote: row.note, purpose: 'inspection', ...(row.origins?.[0]?.key ? { sourceKey: row.origins[0].key } : {}) });
          const returned = await provider.notes(result);
          const full = returned.find(x => x.noteId === noteId);
          if (!full || full.authorId !== row.note.authorId) throw error('DETAIL_MISMATCH');
          if (discovery) {
            await discovery.addNotes(returned.filter(x => x.noteId !== noteId),
              { key: sourceKey('related', { note_id: noteId }), type: 'related', label: '详情附带作品' }, true);
            await saveProgress(store, lease, round.id, progress, clock);
          }
          row.note = { ...row.note, ...full, fans: full.fans ?? row.note.fans };
          // The sweep only publishes today picks: a detail that moves a note out of the today window ends its inspection.
          if (!admitsCandidate(round, row.note)) {
            row.stage = 'skipped'; row.skipReason = 'outside_metrics_after_detail'; row.outcome = 'rejected_metrics';
          } else row.stage = 'judge';
          await save();
        } else if (row.stage === 'judge') {
          const cached = adaptive ? await cachedJudgment(store, row.note, 'text', clock(), warning => progress.gaps.push(warning)) : null;
          if (cached) { row.note.judgment = cached; progress.judgmentCacheHits = (progress.judgmentCacheHits || 0) + 1; }
          else if (adaptive && (progress.textFailureStreak || 0) >= 2) {
            row.note.judgment = { verdict: 'error', evidence: '', reason: 'model_circuit_open' };
          }
          else {
            const callsModel = needsTextModel(row.note);
            if (callsModel && progress.aiCalls >= config.maxAiCallsPerRound) throw error('AI_CALL_CAP');
            row.stage = 'judging'; row.textCallReserved = callsModel;
            if (callsModel) progress.aiCalls++;
            await save(true);
            row.note.judgment = await judgeNote(row.note, generate);
            row.textCallReserved = false;
            if (callsModel) progress.textFailureStreak = row.note.judgment.verdict === 'error' ? (progress.textFailureStreak || 0) + 1 : 0;
            if (adaptive) {
              const warning = await cacheJudgment(store, lease, row.note, 'text', row.note.judgment, clock());
              if (warning) progress.gaps.push(warning);
            }
          }
          if (row.note.judgment.verdict === 'error') {
            if (!adaptive) throw error('MODEL_UNAVAILABLE');
            progress.gaps.push('MODEL_UNAVAILABLE');
            if (row.note.judgment.diagnostics) console.error(JSON.stringify({ event: 'text_model_failed',
              roundId: round.id, noteId, ...row.note.judgment.diagnostics }));
          }
          row.note.textJudgment = row.note.judgment;
          const visual = adaptive && round.visionEnabled && config.vision?.enabled && row.note.type === 'video'
            && ['uncertain', 'error'].includes(row.note.judgment.verdict) && admitsCandidate(round, row.note);
          row.stage = row.note.judgment.verdict === 'cooking' ? 'history' : visual ? 'visual' : 'skipped';
          if (row.stage === 'skipped') row.outcome = row.note.judgment.verdict === 'not_cooking' ? 'rejected_content' : 'incomplete';
          if (discovery && row.stage === 'history') await discovery.rememberCooking(row.note);
          await save(true);
        } else if (row.stage === 'visual') {
          // Download, decode and model each have their own deadlines; start only with room for the full chain.
          if (clock() >= Math.min(deadline, round.closesAt) - 100000) break;
          if (!config.vision?.enabled) { row.stage = 'skipped'; row.outcome = 'incomplete'; await save(); continue; }
          try {
            const result = await review({ store, lease, round, note: row.note, settings: config.vision, key: visionKey, clock });
            if (result.cacheWarning) progress.gaps.push(result.cacheWarning);
            if (result.verdict === 'error') throw error(result.reason || 'VISION_UNAVAILABLE');
            if (result.cached) progress.visionCacheHits = (progress.visionCacheHits || 0) + 1;
            else progress.visionChecked = (progress.visionChecked || 0) + 1;
            row.note.judgment = result;
            row.stage = result.verdict === 'cooking' ? 'history' : 'skipped';
            row.outcome = result.verdict === 'not_cooking' ? 'rejected_content' : 'incomplete';
            if (discovery && row.stage === 'history') await discovery.rememberCooking(row.note);
          } catch (e) {
            if (e.code === 'LEASE_EXPIRED') throw e;
            const gap = /VISION_.*BUDGET/.test(e.code) ? 'VISION_BUDGET' : /^VIDEO_/.test(e.code) ? 'VIDEO_UNAVAILABLE' : 'VISION_UNAVAILABLE';
            progress.gaps.push(gap); row.stage = 'skipped'; row.outcome = 'incomplete'; row.errorCode = gap;
          }
          await save(); await saveProgress(store, lease, round.id, progress, clock);
        } else if (row.stage === 'judging') {
          // A crashed model call is never silently replayed.
          const unknownCall = row.textCallReserved !== false;
          if (adaptive && unknownCall) progress.textFailureStreak = (progress.textFailureStreak || 0) + 1;
          row.textCallReserved = false;
          row.note.judgment = { verdict: 'error', evidence: '', reason: 'interrupted_model' };
          row.note.textJudgment = row.note.judgment;
          row.stage = adaptive && round.visionEnabled && config.vision?.enabled && row.note.type === 'video'
            && admitsCandidate(round, row.note) ? 'visual' : 'skipped';
          row.outcome = 'incomplete';
          progress.gaps.push(adaptive && unknownCall ? 'MODEL_UNAVAILABLE' : 'REQUEST_FAILED'); await save(true);
        } else if (row.stage === 'history') {
          if (eligibleBoards(row.note, round.scheduledAt).includes('today')) {
            const cacheId = `history_${round.id}_${row.note.authorId}`;
            let history = await store.get('dfp_results', cacheId);
            if (!history || (historyBaseline(row.note, history.notes).baselineReason === 'fewer_than_seven' && history.hasMore && history.cursor && history.pages < 2)) {
              const params = { user_id: row.note.authorId, ...(history?.cursor ? { cursor: history.cursor } : {}) };
              const result = await provider.request('author', params, { purpose: 'inspection' });
              const works = (await provider.notes(result)).map(x => ({ noteId: x.noteId, authorId: x.authorId, publishedAt: x.publishedAt, likes: x.likes, sticky: x.sticky }));
              history = { notes: [...(history?.notes || []), ...works], hasMore: result.hasMore, cursor: result.cursor, pages: (history?.pages || 0) + 1 };
              await store.put('dfp_results', cacheId, history);
              if (historyBaseline(row.note, history.notes).baselineReason === 'fewer_than_seven' && history.hasMore && history.cursor && history.pages < 2) continue;
            }
            Object.assign(row.note, historyBaseline(row.note, history.notes));
          }
          row.stage = 'fans'; await save();
        } else if (row.stage === 'fans') {
          const primaryBoard = eligibleBoards(row.note, round.scheduledAt).some(board => board === 'today' || board === 'week');
          if (!primaryBoard && inWindow(row.note, round.scheduledAt, 5) && row.note.fans === null) {
            const result = await provider.request('user', { user_id: row.note.authorId }, { purpose: 'inspection' });
            row.note.fans = result.fans;
          }
          row.note.boards = eligibleBoards(row.note, round.scheduledAt);
          if (row.note.boards.includes('today') || row.note.boards.includes('week')) row.note.boards = row.note.boards.filter(x => x !== 'dark');
          row.note.fanRatio = Number.isSafeInteger(row.note.fans) && row.note.fans > 0 ? Math.round(row.note.likes / row.note.fans * 10) / 10 : null;
          row.stage = 'cover'; await save();
        } else if (row.stage === 'cover') {
          row.note.fileId = upload ? await storeCover({ store, upload, note: row.note,
            report: issue => { row.coverIssue = issue; } }) : null;
          if (!row.note.fileId && row.note.coverUrl) progress.gaps.push('COVER_UNAVAILABLE');
          row.stage = row.note.boards.length ? 'done' : 'skipped';
          row.outcome = row.note.boards.length ? 'accepted' : 'rejected_metrics'; await save(true);
        } else if (['done', 'skipped'].includes(row.stage)) {
          progress.candidateIndex++; await saveProgress(store, lease, round.id, progress, clock);
        } else throw error('INVALID_STAGE');
      } catch (e) {
        if (['TICK_LIMIT', 'DAILY_BUDGET', 'ROUND_BUDGET', 'VALIDATION_BUDGET', 'SUPPLEMENT_BUDGET', 'PROVIDER_AUTH', 'LEASE_EXPIRED', 'MODEL_UNAVAILABLE', 'AI_CALL_CAP'].includes(e.code)) throw e;
        row.stage = 'skipped'; row.errorCode = 'REQUEST_FAILED'; row.outcome = 'incomplete'; await save();
        progress.gaps.push('REQUEST_FAILED');
        progress.candidateIndex++; await saveProgress(store, lease, round.id, progress, clock);
      }
    }
    await saveProgress(store, lease, round.id, progress, clock);
    if (clock() >= round.closesAt - 10000) return await conclude({ store, lease, round, progress, reason: 'WINDOW_ENDED', clock });
    return { roundId: round.id, status: 'running' };
  } catch (e) {
    if (e.code === 'TICK_LIMIT') return { roundId: round?.id, status: 'running' };
    if (round && progress && e.code !== 'LEASE_EXPIRED') {
      return await conclude({ store, lease, round, progress, reason: REASONS[e.code] ? e.code : 'REQUEST_FAILED', clock });
    }
    throw e;
  } finally { await releaseLease(store, lease); }
}

module.exports = { runTick, searches, conclude, prioritizeCandidates };
