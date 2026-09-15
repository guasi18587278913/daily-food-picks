'use strict';

const { shanghaiDay, PRICE_MICRO_USD } = require('./budget');
const { timingSafeEqual } = require('node:crypto');
const { TRACKS, TRACK_KEYS, DEFAULT_TRACK, trackForHour } = require('./tracks');

// The food track's own hours, kept as named constants because the supplement and validation rules are written against
// them. Every track's hours live in tracks.js; these are the ones a manually scheduled round has to avoid.
const REGULAR_HOURS = TRACKS[DEFAULT_TRACK].regularHours;
const REGULAR_WINDOW_MINUTES = 20;
const SWEEP_HOUR = TRACKS[DEFAULT_TRACK].sweepHour;
const SWEEP_WINDOW_MINUTES = 30;
// Every collecting hour across all tracks, so a manual round is never scheduled on top of one of them.
const ALL_WINDOWS = Object.freeze(TRACK_KEYS.flatMap(key =>
  [[TRACKS[key].sweepHour, SWEEP_WINDOW_MINUTES], ...TRACKS[key].regularHours.map(hour => [hour, REGULAR_WINDOW_MINUTES])]));
// The 2026-09-13 approval only adds the 06:00 sweep; the regular rounds keep their original 50-call day (17/17/16).
const MAX_REGULAR_DAILY_CALLS = 50;

function error(code) { const e = new Error(code); e.code = code; return e; }
// The day's approved calls are split evenly between the tracks. Splitting here, in one place, is what makes the two
// tracks comparable: neither can quietly outspend the other, so a difference in yield is a difference in the niche.
function trackBudget(config) {
  const sweepCalls = Math.floor((config.sweepCalls || 0) / TRACK_KEYS.length);
  return { sweepCalls, regularDailyCalls: Math.floor(config.dailyCalls / TRACK_KEYS.length) - sweepCalls };
}
const pad = n => String(n).padStart(2, '0');
function number(value, maximum) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= maximum ? n : null;
}
function validInstant(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
    && hour < 24 && minute < 60 && second < 60 && (!match[7] || (Number(match[8]) <= 14 && Number(match[9]) < 60));
}
function sweepWindow(now) {
  const day = shanghaiDay(now);
  const scheduledAt = Date.parse(`${day}T${pad(SWEEP_HOUR)}:00:00+08:00`);
  return { id: `${day.replaceAll('-', '')}-${pad(SWEEP_HOUR)}00`, scheduledAt, closesAt: scheduledAt + SWEEP_WINDOW_MINUTES * 60000 };
}
// A validation round sharing a scheduled window would displace that round, which would then never be finalized.
function overlapsScheduledWindow(start, config) {
  const end = start + REGULAR_WINDOW_MINUTES * 60000;
  const windows = config.sweepCalls ? ALL_WINDOWS : ALL_WINDOWS.filter(([hour]) => !TRACK_KEYS.some(key => TRACKS[key].sweepHour === hour));
  return [shanghaiDay(start), shanghaiDay(end)].some(day => windows.some(([hour, minutes]) => {
    const opens = Date.parse(`${day}T${pad(hour)}:00:00+08:00`);
    return start < opens + minutes * 60000 && end > opens;
  }));
}
function validateSupplement(config, env) {
  if (!env.DFP_SUPPLEMENT_AT && !env.DFP_SUPPLEMENT_CALLS) return;
  if (!config.supplementAt || !config.supplementCalls) throw error('INVALID_SUPPLEMENT_CONFIG');
  const start = Date.parse(config.supplementAt);
  const end = start + REGULAR_WINDOW_MINUTES * 60000;
  const validation = config.validationAt ? Date.parse(config.validationAt) : NaN;
  if (!validInstant(config.supplementAt) || start % 60000 !== 0
    || (config.sweepCalls && start < sweepWindow(start).closesAt)
    || shanghaiDay(start) !== shanghaiDay(end) || overlapsScheduledWindow(start, config)
    || (Number.isFinite(validation) && start < validation + REGULAR_WINDOW_MINUTES * 60000 && end > validation)) {
    throw error('INVALID_SUPPLEMENT_TIME');
  }
}
function loadConfig(env = process.env) {
  const budgetTier = env.DFP_BUDGET_TIER || 'legacy150';
  if (!['legacy150', 'expanded250'].includes(budgetTier)) throw error('CONFIGURATION_INCOMPLETE');
  // 'expanded250' is 250 approved calls *per track*: the whole-day caps below are that figure times the track count,
  // so adding a track raises the ceiling rather than quietly halving what each one already had.
  const expanded = budgetTier === 'expanded250';
  const tracks = TRACK_KEYS.length;
  const config = {
    budgetTier,
    enabled: env.DFP_ENABLED === 'true',
    appId: env.DFP_APP_ID || 'wx8a2388888683b769',
    envId: env.DFP_ENV_ID || 'food-picks-trial-d5elis0ecfcb5d2',
    dailyCalls: number(env.DFP_DAILY_CALLS, (expanded ? 250 : 150) * tracks), dailyMicroUsd: number(env.DFP_DAILY_MICRO_USD, (expanded ? 2500000 : 1500000) * tracks),
    sweepCalls: number(env.DFP_SWEEP_CALLS, 100 * tracks),
    validationCalls: number(env.DFP_VALIDATION_CALLS, 20), validationMicroUsd: number(env.DFP_VALIDATION_MICRO_USD, 200000),
    validationAt: env.DFP_VALIDATION_AT || null,
    supplementAt: env.DFP_SUPPLEMENT_AT || null, supplementCalls: number(env.DFP_SUPPLEMENT_CALLS, expanded ? 50 : 20),
    timerSecret: env.DFP_TIMER_SECRET || '',
    freeAiConfirmed: env.DFP_FREE_AI_CONFIRMED === 'true',
    aiProvider: env.DFP_AI_PROVIDER || 'hunyuan-v3', aiModel: env.DFP_AI_MODEL || 'hy3',
    maxAiCallsPerRound: 20, maxAiOutputTokens: 1024, maxAiInputChars: 12000,
    captureCallerForSetup: env.DFP_CAPTURE_CALLER_FOR_SETUP === 'true'
  };
  config.discoveryMode = env.DFP_DISCOVERY_MODE || 'legacy';
  if (!['legacy', 'adaptive'].includes(config.discoveryMode)) throw error('INVALID_DISCOVERY_CONFIG');
  config.vision = { enabled: env.DFP_VISION_ENABLED === 'true',
    dailyMicroCny: number(env.DFP_VISION_DAILY_MICRO_CNY, 500000),
    roundCalls: number(env.DFP_VISION_ROUND_CALLS, 20), validationCalls: 6, validationMicroCny: 200000 };
  if (config.vision.enabled && (config.discoveryMode !== 'adaptive' || !config.vision.dailyMicroCny
    || !config.vision.roundCalls || typeof env.DFP_VISION_KEY !== 'string' || env.DFP_VISION_KEY.length < 20)) throw error('INVALID_VISION_CONFIG');
  if (config.aiProvider !== 'hunyuan-v3' || config.aiModel !== 'hy3') throw error('FREE_AI_ONLY');
  if (!/^wx[0-9a-f]{16}$/.test(config.appId)) throw error('INVALID_APP_ID');
  if (config.enabled && (!config.dailyCalls || !config.dailyMicroUsd || !config.validationCalls || !config.validationMicroUsd || !config.freeAiConfirmed)) throw error('CONFIGURATION_INCOMPLETE');
  // An absent sweep cap disables 06:00. An unreadable one, a daily cap that would enlarge the regular rounds, or a
  // money cap too small for the approved calls stops loading instead of silently reshaping the day.
  // The caps are per track: each one still runs the approved day, and the money cap covers every track together.
  const { regularDailyCalls, sweepCalls } = trackBudget(config);
  if (config.enabled && ((env.DFP_SWEEP_CALLS && !config.sweepCalls) || regularDailyCalls < REGULAR_HOURS.length
    || regularDailyCalls > (expanded ? 150 : MAX_REGULAR_DAILY_CALLS) || config.dailyMicroUsd < config.dailyCalls * PRICE_MICRO_USD)) throw error('CONFIGURATION_INCOMPLETE');
  // The expanded tier is an approved day *per track*. Left as an upper bound only, adding a track would silently halve
  // what every existing track collects, so the shape has to be exact in both directions.
  if (config.enabled && expanded && (regularDailyCalls !== 150 || sweepCalls !== 100)) throw error('CONFIGURATION_INCOMPLETE');
  if (config.enabled && !/^[a-f0-9]{64}$/.test(config.timerSecret)) throw error('CONFIGURATION_INCOMPLETE');
  if (config.validationAt && (!validInstant(config.validationAt)
    || overlapsScheduledWindow(Date.parse(config.validationAt), config))) throw error('INVALID_VALIDATION_TIME');
  validateSupplement(config, env);
  return config;
}

function assertTimer(event, wxContext, config = {}) {
  if (wxContext?.OPENID || wxContext?.APPID || wxContext?.UNIONID
    || event?.Type !== 'Timer' || event?.TriggerName !== 'food-picks-timer') throw error('UNAUTHORIZED_TRIGGER');
  if (wxContext?.SOURCE === 'wx_trigger') return;
  // Native SCF timers do not pass through the WeChat gateway and have no SOURCE.
  // Authenticate that path with a credential stored only in server config + trigger metadata.
  if (![undefined, null, ''].includes(wxContext?.SOURCE)
    || typeof config.timerSecret !== 'string' || !/^[a-f0-9]{64}$/.test(config.timerSecret)
    || typeof event.Message !== 'string' || !/^[a-f0-9]{64}$/.test(event.Message)
    || !timingSafeEqual(Buffer.from(event.Message), Buffer.from(config.timerSecret))) throw error('UNAUTHORIZED_TRIGGER');
}

function scheduledRound(now, config) {
  const shifted = new Date(now + 8 * 3600000);
  const day = shanghaiDay(now);
  const nowHour = shifted.getUTCHours();
  const nowMinute = shifted.getUTCMinutes();
  let start;
  let validation = false;
  let supplement = false;
  let kind = 'regular';
  let windowMinutes = REGULAR_WINDOW_MINUTES;
  const v = config.validationAt ? Date.parse(config.validationAt) : NaN;
  const extra = config.supplementAt ? Date.parse(config.supplementAt) : NaN;
  if (Number.isFinite(extra) && config.supplementCalls && now >= extra && now < extra + REGULAR_WINDOW_MINUTES * 60000) {
    start = extra; supplement = true;
  } else if (Number.isFinite(v) && now >= v && now < v + REGULAR_WINDOW_MINUTES * 60000) { start = v; validation = true; }
  else if (trackForHour(nowHour)?.sweepHour === nowHour && config.sweepCalls) {
    if (nowMinute >= SWEEP_WINDOW_MINUTES) return null;
    start = Date.parse(`${day}T${pad(nowHour)}:00:00+08:00`);
    kind = 'sweep';
    windowMinutes = SWEEP_WINDOW_MINUTES;
  } else {
    if (!trackForHour(nowHour)?.regularHours.includes(nowHour) || nowMinute >= REGULAR_WINDOW_MINUTES) return null;
    start = Date.parse(`${day}T${pad(nowHour)}:00:00+08:00`);
  }
  const d = new Date(start + 8 * 3600000);
  const hour = d.getUTCHours();
  const id = `${d.toISOString().slice(0, 10).replaceAll('-', '')}-${pad(hour)}${pad(d.getUTCMinutes())}`;
  // A supplement or validation round is scheduled by hand and belongs to the default track; every other round is
  // identified by its hour, which only one track ever owns.
  const owner = (supplement || validation ? TRACKS[DEFAULT_TRACK] : trackForHour(hour)) || TRACKS[DEFAULT_TRACK];
  // Each track gets an equal share of the day, so both are measured with the same budget as well as the same rules.
  const { regularDailyCalls, sweepCalls } = trackBudget(config);
  const allocationIn = (hours, h) => {
    const share = Math.ceil(regularDailyCalls / hours.length);
    return h === hours[hours.length - 1] ? regularDailyCalls - (hours.length - 1) * share : share;
  };
  const roundCalls = supplement ? config.supplementCalls : validation ? config.validationCalls
    : kind === 'sweep' ? sweepCalls : allocationIn(owner.regularHours, hour);
  // Every track draws on the same day's ledger, so an extra round has to leave room for the rounds still to come on
  // every track — not just its own, or a food supplement would quietly spend the calls the evening FDE round needs.
  const reservedRegularCalls = supplement ? TRACK_KEYS.reduce((sum, key) => sum
    + TRACKS[key].regularHours.filter(h => h > hour).reduce((inner, h) => inner + allocationIn(TRACKS[key].regularHours, h), 0)
    + (config.sweepCalls && TRACKS[key].sweepHour > hour ? sweepCalls : 0), 0) : 0;
  return { id, track: owner.key, day: shanghaiDay(start), scheduledAt: start, closesAt: start + windowMinutes * 60000, validation, kind,
    sweepEnabled: Boolean(config.sweepCalls), roundCalls, ...(supplement ? { supplement: true, reservedRegularCalls } : {}),
    ...(config.budgetTier === 'expanded250' ? { budgetTier: 'expanded250' } : {}),
    ...(config.discoveryMode === 'adaptive' ? { discoveryMode: 'adaptive',
      ...(config.budgetTier === 'expanded250' ? { discoveryAllocation: 'candidate-reserve-v2', risingSource: 'pgy' }
        : { discoveryLimit: kind === 'sweep' ? 18 : 4 }),
      ...(config.budgetTier === 'expanded250' && kind === 'regular' ? { candidateTarget: 20 } : {}),
      visionEnabled: config.vision?.enabled === true, ...(config.vision?.enabled ? { visionRoundCalls: config.vision.roundCalls } : {}) } : {}) };
}

module.exports = { loadConfig, assertTimer, scheduledRound, sweepWindow, error };
