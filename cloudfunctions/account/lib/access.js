'use strict';
const { newUser, valid } = require('./users');

function fail(code) { const error = new Error(code); error.code = code; throw error; }

/** @param {Record<string,string|undefined>} [env] */
function accessConfig(env = process.env) {
  return {
    appId: env.DFP_APP_ID || 'wx8a2388888683b769',
    bootstrapAdminOpenId: (env.DFP_BOOTSTRAP_ADMIN_OPENID || '').trim(),
    // Only the exact string opens the migration window, so a stray value cannot widen access.
    migrationFallback: env.DFP_MIGRATION_FALLBACK === 'true',
    fallbackOpenIds: (env.DFP_ALLOWED_OPENIDS || '').split(',').map(value => value.trim()).filter(Boolean)
  };
}

/** Identity comes from the platform context of this invocation only, never from the request payload. */
function identify(wxContext, config) {
  if (!wxContext || typeof wxContext !== 'object' || Array.isArray(wxContext)) fail('UNAUTHENTICATED');
  const { APPID, OPENID } = wxContext;
  if (typeof OPENID !== 'string' || !OPENID || APPID !== config.appId) fail('UNAUTHENTICATED');
  return OPENID;
}

/** Missing or unexpected field values never widen access; a suspended record reports its own code. */
function granted(record, openId) {
  if (!valid(record)) return null;
  if (record.status === 'suspended') fail('SUSPENDED');
  // `record` lets a caller read other stored fields without a second read; it is never returned to a client as is.
  return { openId, role: record.role, status: record.status, record };
}

async function provision(store, openId, origin) {
  const record = newUser({ ...origin, actor: openId });
  try {
    await store.create('dfp_users', openId, record);
    return record;
  } catch (error) {
    // A lost race leaves a usable record behind, and that stored record stays authoritative.
    // Deciding by re-reading rather than by the error text keeps this correct even if the platform
    // wraps the message. Anything else (conflict, quota, permissions) surfaces instead of being hidden.
    const stored = await store.get('dfp_users', openId);
    if (stored) return stored;
    throw error;
  }
}

/**
 * @param {unknown} wxContext platform identity for this invocation
 * @param {ReturnType<typeof accessConfig>} config
 * @param {{get:Function,create:Function}} store
 * @returns {Promise<{openId:string,role:string,status:string}>}
 */
async function authorize(wxContext, config, store, { now = Date.now(), mayProvision = false } = {}) {
  const openId = identify(wxContext, config);
  const existing = granted(await store.get('dfp_users', openId), openId);
  if (existing) return existing;

  // Bootstrap and the migration window are the only ways a record appears without an invite code.
  // Both come from server configuration, so neither is reachable from a client request.
  //
  // `mayProvision` keeps that writing to the account function. A read-only caller such as the catalog
  // must not create a record as a side effect of a query (constitution principle II), and must never be
  // able to mint an administrator even if someone later gives it the bootstrap setting.
  const origin = config.bootstrapAdminOpenId && openId === config.bootstrapAdminOpenId
    ? { role: 'admin', grantedVia: 'bootstrap', at: now }
    : config.migrationFallback && config.fallbackOpenIds.includes(openId)
      ? { role: 'member', grantedVia: 'migration', at: now }
      : null;
  if (!origin || !mayProvision) return fail('NOT_REGISTERED');
  return granted(await provision(store, openId, origin), openId) || fail('NOT_REGISTERED');
}

module.exports = { accessConfig, authorize, identify };
