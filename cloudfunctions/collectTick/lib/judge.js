'use strict';

const { digest } = require('./provider');
const { track, DEFAULT_TRACK } = require('./tracks');
// Verdicts are recorded in words that belong to no niche, so every reader downstream — boards, publishing, the client
// — works the same for a recipe and for a deployment write-up. The model still answers in its own track's words; they
// are translated here, at the only place that talks to it.
const ON_TOPIC = 'on_topic', OFF_TOPIC = 'off_topic', UNCERTAIN = 'uncertain';
const subjectOf = key => track(key || DEFAULT_TRACK).subject;
const caption = text => text.replace(/#[^#\n]*(?:#|$)/gm, ' ').replace(/\s+/g, ' ').trim();
// These cues validate a title-only claim; they never classify a note on their own.
const preparationEvidence = (text, subject) => subject.intent.test(text) || subject.detail.test(text);
function completeText(note) {
  return note?.bodyComplete === true && typeof note.title === 'string' && note.title.length <= 2000
    && typeof note.desc === 'string' && note.desc.length <= 12000;
}
function unsupportedCaption(result, note, subject) {
  if (note.type !== 'video' || !note.title.trim() || (caption(note.desc) && caption(note.desc) !== caption(note.title))) return false;
  if (preparationEvidence(caption(note.title), subject) || subject.detail.test(caption(note.desc))) return false;
  return result.verdict === subject.positive
    || (result.verdict === subject.negative && !subject.exclusion.test(result.evidence));
}
function parseJudgment(raw, note, trackKey) {
  const subject = subjectOf(trackKey);
  const uncertain = { verdict: 'uncertain', evidence: '', reason: 'unverified_output' };
  try {
    if (typeof raw !== 'string' || raw.length > 4000) return uncertain;
    const result = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
    if (!result || Object.keys(result).some(k => !['verdict', 'evidence', 'evidenceSource'].includes(k))
      || ![subject.positive, subject.negative, UNCERTAIN].includes(result.verdict)
      || typeof result.evidence !== 'string' || result.evidence.length > 500) return uncertain;
    const evidenceSource = result.evidenceSource ?? 'desc';
    if (result.verdict === 'uncertain' && !result.evidence.trim() && ['', 'title', 'desc'].includes(evidenceSource)) {
      return { verdict: 'uncertain', evidence: '', evidenceSource: null, reason: null };
    }
    if (!['title', 'desc'].includes(evidenceSource)) return uncertain;
    if (result.verdict !== 'uncertain') {
      if (!completeText(note) || !result.evidence.trim() || !note[evidenceSource].includes(result.evidence)) return uncertain;
      const plainEvidence = caption(result.evidence);
      const plainSource = caption(note[evidenceSource]);
      if (!plainEvidence || !plainSource.includes(plainEvidence)) return uncertain;
      if (result.verdict === subject.positive && evidenceSource === 'title'
        && (note.type !== 'video' || !preparationEvidence(plainSource, subject) || !preparationEvidence(plainEvidence, subject))) return uncertain;
      // Exclusion has to name what the work is instead: 2026-09-14 showed praise quoted from the body ("温润顺滑，
      // 秋天食补的不二之选") rejecting a real recipe. Absent a cue the verdict falls back to uncertain, not rejection.
      if (result.verdict === subject.negative && !subject.exclusion.test(plainEvidence)) return { ...uncertain, reason: 'exclusion_without_cue' };
      if (unsupportedCaption(result, note, subject)) return { ...uncertain, reason: 'caption_without_evidence' };
    }
    const verdict = result.verdict === subject.positive ? ON_TOPIC : result.verdict === subject.negative ? OFF_TOPIC : UNCERTAIN;
    return { verdict, evidence: result.evidence, evidenceSource, reason: null };
  } catch { return uncertain; }
}
function needsTextModel(note) {
  return completeText(note) && !!(note.desc.trim() || (note.type === 'video' && note.title.trim()));
}
// The free channel answers HTTP 429 at random (measured 2026-09-15: about four in ten calls, independent of pacing),
// and each such answer clears within seconds, so a rate-limited call is retried a bounded number of times.
const RATE_LIMIT_RETRY_DELAYS_MS = Object.freeze([1500, 3500]);
function modelErrorCategory(error) {
  const raw = error?.status ?? error?.statusCode ?? (/^\d{3}$/.test(String(error?.code ?? '')) ? Number(error.code) : undefined);
  const status = Number.isInteger(raw) && raw >= 100 && raw <= 599 ? raw : null;
  const category = /timeout|timed out|超时/i.test(String(error?.message || '')) || error?.name === 'AbortError'
    ? 'timeout' : status === 401 || status === 403 ? 'authorization' : status === 429 ? 'rate_limit' : 'service';
  return { category, status };
}
// A retry only happens when its pause plus a full model call (35 s) still fit before the caller's deadline.
async function judgeNote(note, generate, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  retryDelaysMs = RATE_LIMIT_RETRY_DELAYS_MS, clock = Date.now, deadline = Infinity, callTimeoutMs = 35000,
  track: trackKey = DEFAULT_TRACK } = {}) {
  if (!needsTextModel(note)) {
    return { verdict: 'uncertain', evidence: '', reason: 'incomplete_body' };
  }
  const subject = subjectOf(trackKey);
  const messages = [
    // The subject supplies what the three verdicts mean in its niche; the output contract is identical for every track.
    { role: 'system', content: subject.prompt
      + `只返回JSON：{"verdict":"${subject.positive}|${subject.negative}|uncertain","evidence":"对应来源里逐字复制的一个连续短句，最多120字符","evidenceSource":"title|desc"}。${subject.positive}和${subject.negative}都必须引用支持判断的原句；标题证据用title，正文证据用desc。保留空格符号，不拼接、概括或补全；uncertain可给空证据。不要添加其他字段。` },
    { role: 'user', content: JSON.stringify({ type: note.type, title: note.title, desc: note.desc }) }
  ];
  for (let attempt = 1; ; attempt++) {
    try { return { ...parseJudgment(await generate(messages), note, trackKey), inputHash: digest([note.type, note.title, note.desc]), attempts: attempt }; }
    catch (error) {
      const { category, status } = modelErrorCategory(error);
      const delay = retryDelaysMs[attempt - 1];
      if (category === 'rate_limit' && delay !== undefined && clock() + delay + callTimeoutMs < deadline) { await sleep(delay); continue; }
      // Persist categories, HTTP status and attempt counts only; SDK errors can contain credentials or input text.
      return { verdict: 'error', evidence: '', reason: category === 'rate_limit' ? 'model_rate_limited' : 'model_unavailable',
        diagnostics: { category, httpStatus: status, attempts: attempt } };
    }
  }
}
function freeModelGenerator(app) {
  return async messages => {
    const result = await app.ai().createModel('hunyuan-v3').generateText({ model: 'hy3', messages,
      max_tokens: 1024, thinking: { type: 'disabled' }, maxSteps: 1 }, { timeout: 35000 });
    return result.text;
  };
}

module.exports = { parseJudgment, judgeNote, freeModelGenerator, needsTextModel, modelErrorCategory,
  RATE_LIMIT_RETRY_DELAYS_MS, ON_TOPIC, OFF_TOPIC, UNCERTAIN };
