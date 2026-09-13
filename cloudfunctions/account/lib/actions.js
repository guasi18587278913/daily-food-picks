'use strict';
const { authorize, identify } = require('./access');
const { redeem } = require('./invites');
const { audit } = require('./audit');
const { isAdmin } = require('./users');
const admin = require('./admin');
const favorites = require('./favorites');

const ERRORS = {
  UNAUTHENTICATED: '请从微信重新进入。',
  NOT_REGISTERED: '这个微信还没有开通，输入邀请码即可使用。',
  SUSPENDED: '这个账号已停用，请联系管理员。',
  FORBIDDEN: '没有权限执行这个操作。',
  INVALID_ARGUMENT: '请求内容不正确，请重试。',
  NOT_FOUND: '找不到这个账号或邀请码。',
  CODE_NOT_FOUND: '邀请码无效。',
  CODE_EXPIRED: '邀请码已过期。',
  CODE_EXHAUSTED: '邀请码已被用完。',
  ALREADY_REGISTERED: '这个微信已经开通，直接使用即可。',
  TOO_MANY_ATTEMPTS: '尝试次数过多。',
  LAST_ADMIN: '系统需要保留至少一个管理员，这个操作被拒绝。',
  LIMIT_EXCEEDED: '收藏数量已达上限，清理一些再试。',
  BACKEND_UNAVAILABLE: '服务暂时不可用，稍后再试。'
};

function fail(code) { const error = new Error(code); error.code = code; throw error; }

/**
 * @param {{store:object,config:object,now?:() => number}} deps
 * @returns {(event:unknown, wxContext:unknown) => Promise<{ok:boolean,data?:object,error?:{code:string,message:string}}>}
 */
function createAccount({ store, config, now = () => Date.now() }) {
  return async (event, wxContext) => {
    try {
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.action !== 'string') fail('INVALID_ARGUMENT');
      const at = now();

      // Redeeming is the only action a caller without a record may reach, so it needs identity but not authorization.
      if (event.action === 'redeem') {
        const openId = identify(wxContext, config);
        const granted = await redeem(store, { openId, code: event.code, at });
        await audit(store, { actor: openId, action: 'redeem', target: granted.code, at });
        return { ok: true, data: { role: granted.role, status: granted.status } };
      }

      // Every other action requires a usable record; authorize() is the only place that decides that.
      // Only this function may create a record from server configuration; see access.js.
      const session = await authorize(wxContext, config, store, { now: at, mayProvision: true });

      if (event.action === 'me') {
        return { ok: true, data: { role: session.role, status: session.status, grantedAt: session.record.grantedAt } };
      }

      if (event.action === 'favorites.list') {
        return { ok: true, data: await favorites.listFavorites(store, session.openId) };
      }
      if (event.action === 'favorites.toggle') {
        return { ok: true, data: await favorites.toggleFavorite(store, { openId: session.openId, noteId: event.noteId, at }) };
      }
      if (event.action === 'favorites.merge') {
        return { ok: true, data: await favorites.mergeFavorites(store, { openId: session.openId, items: event.items, at }) };
      }

      if (event.action.startsWith('admin.')) {
        // The screen hiding the entry is a convenience; this check is what actually restricts management.
        if (!isAdmin(session.record)) fail('FORBIDDEN');
        const READ_ONLY = ['admin.listUsers', 'admin.listInvites'];
        const run = {
          'admin.listUsers': () => admin.listUsers(store, event),
          'admin.listInvites': () => admin.listInvites(store, event),
          'admin.setUserStatus': () => admin.changeAccess(store, event, { actor: session.openId, at, field: 'status' }),
          'admin.setUserRole': () => admin.changeAccess(store, event, { actor: session.openId, at, field: 'role' }),
          'admin.createInvite': () => admin.issueInvite(store, event, { actor: session.openId, at }),
          'admin.revokeInvite': () => admin.revokeInvite(store, event, { at }),
          'admin.migrateWhitelist': () => admin.migrateWhitelist(store,
            { actor: session.openId, at, openIds: config.fallbackOpenIds })
        }[event.action];
        if (!run) fail('INVALID_ARGUMENT');
        const outcome = await run();
        // Which actions return a plain payload is declared here rather than inferred from the shape,
        // so a state-changing action that forgets its audit entry cannot leak its wrapper to the client.
        if (READ_ONLY.includes(event.action)) return { ok: true, data: outcome };
        await audit(store, { actor: session.openId, at, ...outcome.audit });
        return { ok: true, data: outcome.data };
      }
      return fail('INVALID_ARGUMENT');
    } catch (error) {
      const known = Object.hasOwn(ERRORS, error.code);
      // An unexpected failure leaves a log line, so a platform fault can be told apart from a
      // business refusal. The client still sees only the generic message.
      if (!known) {
        const action = event && typeof event === 'object' ? String(event.action) : 'unknown';
        console.error(`account action ${action} failed: code=${error && error.code} message=${error && error.message}`);
      }
      const code = known ? error.code : 'BACKEND_UNAVAILABLE';
      const hint = typeof error.hint === 'string' ? error.hint : '';
      return { ok: false, error: { code, message: `${ERRORS[code]}${hint}` } };
    }
  };
}

module.exports = { createAccount, ERRORS };
