'use strict';

const { shanghaiDay } = require('./budget');

function error(code) { const e = new Error(code); e.code = code; return e; }
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
function loadConfig(env = process.env) {
  const config = {
    enabled: env.DFP_ENABLED === 'true',
    appId: env.DFP_APP_ID || 'wx8a2388888683b769',
    envId: env.DFP_ENV_ID || 'food-picks-trial-d5elis0ecfcb5d2',
    dailyCalls: number(env.DFP_DAILY_CALLS, 50), dailyMicroUsd: number(env.DFP_DAILY_MICRO_USD, 500000),
    validationCalls: number(env.DFP_VALIDATION_CALLS, 20), validationMicroUsd: number(env.DFP_VALIDATION_MICRO_USD, 200000),
    validationAt: env.DFP_VALIDATION_AT || null,
    freeAiConfirmed: env.DFP_FREE_AI_CONFIRMED === 'true',
    aiProvider: env.DFP_AI_PROVIDER || 'hunyuan-v3', aiModel: env.DFP_AI_MODEL || 'hy3',
    maxAiCallsPerRound: 20, maxAiOutputTokens: 1024, maxAiInputChars: 12000,
    captureCallerForSetup: env.DFP_CAPTURE_CALLER_FOR_SETUP === 'true'
  };
  if (config.aiProvider !== 'hunyuan-v3' || config.aiModel !== 'hy3') throw error('FREE_AI_ONLY');
  if (!/^wx[0-9a-f]{16}$/.test(config.appId)) throw error('INVALID_APP_ID');
  if (config.enabled && (!config.dailyCalls || !config.dailyMicroUsd || !config.validationCalls || !config.validationMicroUsd || !config.freeAiConfirmed)) throw error('CONFIGURATION_INCOMPLETE');
  if (config.validationAt && !validInstant(config.validationAt)) throw error('INVALID_VALIDATION_TIME');
  return config;
}

function assertTimer(event, wxContext) {
  if (wxContext?.SOURCE !== 'wx_trigger' || wxContext?.OPENID || wxContext?.APPID || wxContext?.UNIONID
    || event?.Type !== 'Timer' || event?.TriggerName !== 'food-picks-timer') throw error('UNAUTHORIZED_TRIGGER');
}

function scheduledRound(now, config) {
  const shifted = new Date(now + 8 * 3600000);
  const day = shanghaiDay(now);
  let start;
  let validation = false;
  const v = config.validationAt ? Date.parse(config.validationAt) : NaN;
  if (Number.isFinite(v) && now >= v && now < v + 20 * 60000) { start = v; validation = true; }
  else {
    if (![9, 12, 20].includes(shifted.getUTCHours()) || shifted.getUTCMinutes() >= 20) return null;
    start = Date.parse(`${day}T${String(shifted.getUTCHours()).padStart(2, '0')}:00:00+08:00`);
  }
  const d = new Date(start + 8 * 3600000);
  const hour = d.getUTCHours();
  const id = `${d.toISOString().slice(0, 10).replaceAll('-', '')}-${String(hour).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const allocation = Math.ceil(config.dailyCalls / 3);
  const roundCalls = validation ? config.validationCalls : (hour === 20 ? config.dailyCalls - 2 * allocation : allocation);
  return { id, day: shanghaiDay(start), scheduledAt: start, closesAt: start + 20 * 60000, validation, roundCalls };
}

module.exports = { loadConfig, assertTimer, scheduledRound, error };
