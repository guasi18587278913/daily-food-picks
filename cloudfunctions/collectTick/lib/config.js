'use strict';

const { shanghaiDay, PRICE_MICRO_USD } = require('./budget');
const { timingSafeEqual } = require('node:crypto');

const REGULAR_HOURS = [9, 12, 20];
const REGULAR_WINDOW_MINUTES = 20;
const SWEEP_HOUR = 6;
const SWEEP_WINDOW_MINUTES = 30;
// The 2026-09-13 approval only adds the 06:00 sweep; the regular rounds keep their original 50-call day (17/17/16).
const MAX_REGULAR_DAILY_CALLS = 50;

function error(code) { const e = new Error(code); e.code = code; return e; }
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
  const windows = [...(config.sweepCalls ? [[SWEEP_HOUR, SWEEP_WINDOW_MINUTES]] : []), ...REGULAR_HOURS.map(hour => [hour, REGULAR_WINDOW_MINUTES])];
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
  const config = {
    enabled: env.DFP_ENABLED === 'true',
    appId: env.DFP_APP_ID || 'wx8a2388888683b769',
    envId: env.DFP_ENV_ID || 'food-picks-trial-d5elis0ecfcb5d2',
    dailyCalls: number(env.DFP_DAILY_CALLS, 150), dailyMicroUsd: number(env.DFP_DAILY_MICRO_USD, 1500000),
    sweepCalls: number(env.DFP_SWEEP_CALLS, 100),
    validationCalls: number(env.DFP_VALIDATION_CALLS, 20), validationMicroUsd: number(env.DFP_VALIDATION_MICRO_USD, 200000),
    validationAt: env.DFP_VALIDATION_AT || null,
    supplementAt: env.DFP_SUPPLEMENT_AT || null, supplementCalls: number(env.DFP_SUPPLEMENT_CALLS, 20),
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
    roundCalls: number(env.DFP_VISION_ROUND_CALLS, 3), validationCalls: 6, validationMicroCny: 200000 };
  if (config.vision.enabled && (config.discoveryMode !== 'adaptive' || !config.vision.dailyMicroCny
    || !config.vision.roundCalls || typeof env.DFP_VISION_KEY !== 'string' || env.DFP_VISION_KEY.length < 20)) throw error('INVALID_VISION_CONFIG');
  if (config.aiProvider !== 'hunyuan-v3' || config.aiModel !== 'hy3') throw error('FREE_AI_ONLY');
  if (!/^wx[0-9a-f]{16}$/.test(config.appId)) throw error('INVALID_APP_ID');
  if (config.enabled && (!config.dailyCalls || !config.dailyMicroUsd || !config.validationCalls || !config.validationMicroUsd || !config.freeAiConfirmed)) throw error('CONFIGURATION_INCOMPLETE');
  // An absent sweep cap disables 06:00. An unreadable one, a daily cap that would enlarge the regular rounds, or a
  // money cap too small for the approved calls stops loading instead of silently reshaping the day.
  const regularDailyCalls = config.dailyCalls - (config.sweepCalls || 0);
  if (config.enabled && ((env.DFP_SWEEP_CALLS && !config.sweepCalls) || regularDailyCalls < REGULAR_HOURS.length
    || regularDailyCalls > MAX_REGULAR_DAILY_CALLS || config.dailyMicroUsd < config.dailyCalls * PRICE_MICRO_USD)) throw error('CONFIGURATION_INCOMPLETE');
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
  else if (nowHour === SWEEP_HOUR && config.sweepCalls) {
    if (nowMinute >= SWEEP_WINDOW_MINUTES) return null;
    start = sweepWindow(now).scheduledAt;
    kind = 'sweep';
    windowMinutes = SWEEP_WINDOW_MINUTES;
  } else {
    if (!REGULAR_HOURS.includes(nowHour) || nowMinute >= REGULAR_WINDOW_MINUTES) return null;
    start = Date.parse(`${day}T${pad(nowHour)}:00:00+08:00`);
  }
  const d = new Date(start + 8 * 3600000);
  const hour = d.getUTCHours();
  const id = `${d.toISOString().slice(0, 10).replaceAll('-', '')}-${pad(hour)}${pad(d.getUTCMinutes())}`;
  const regularDailyCalls = config.dailyCalls - (config.sweepCalls || 0);
  const allocation = Math.ceil(regularDailyCalls / 3);
  const allocationFor = hour => hour === 20 ? regularDailyCalls - 2 * allocation : allocation;
  const roundCalls = supplement ? config.supplementCalls : validation ? config.validationCalls
    : kind === 'sweep' ? config.sweepCalls : (hour === 20 ? regularDailyCalls - 2 * allocation : allocation);
  const reservedRegularCalls = supplement ? REGULAR_HOURS.filter(h => h > hour).reduce((sum, h) => sum + allocationFor(h), 0) : 0;
  return { id, day: shanghaiDay(start), scheduledAt: start, closesAt: start + windowMinutes * 60000, validation, kind,
    sweepEnabled: Boolean(config.sweepCalls), roundCalls, ...(supplement ? { supplement: true, reservedRegularCalls } : {}),
    ...(config.discoveryMode === 'adaptive' ? { discoveryMode: 'adaptive', discoveryLimit: kind === 'sweep' ? 18 : 4,
      visionEnabled: config.vision?.enabled === true, ...(config.vision?.enabled ? { visionRoundCalls: config.vision.roundCalls } : {}) } : {}) };
}

module.exports = { loadConfig, assertTimer, scheduledRound, sweepWindow, error };
