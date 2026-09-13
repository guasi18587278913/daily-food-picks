'use strict';

const USES = { min: 1, max: 100 };
const DAYS = { min: 1, max: 365 };
const NOTE_MAX = 50;

/**
 * Checks the invite form before anything is sent. The server checks the same bounds again;
 * this only saves a round trip and gives a reason in the user's own words.
 * @param {{maxUses:unknown,expiresInDays:unknown,note:unknown}} input
 */
function checkInviteForm({ maxUses, expiresInDays, note }) {
  const uses = Number(maxUses);
  const days = Number(expiresInDays);
  if (!Number.isSafeInteger(uses) || uses < USES.min || uses > USES.max) {
    return { ok: false, message: `可用次数请填 ${USES.min}–${USES.max} 之间的整数。`, value: null };
  }
  if (!Number.isSafeInteger(days) || days < DAYS.min || days > DAYS.max) {
    return { ok: false, message: `有效天数请填 ${DAYS.min}–${DAYS.max} 之间的整数。`, value: null };
  }
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (trimmed.length > NOTE_MAX) return { ok: false, message: `备注请不超过 ${NOTE_MAX} 个字。`, value: null };
  return { ok: true, message: '', value: { maxUses: uses, expiresInDays: days, note: trimmed || null } };
}

/** @param {string} value @returns {string} a readable date, or a dash when the value is unusable */
function dateLabel(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '—';
  const at = new Date(time + 8 * 3600000);
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;
}

/** @param {unknown} openId Long identifiers are shortened for display; the full value stays available for actions. */
function shortId(openId) {
  return typeof openId === 'string' && openId.length > 14 ? `${openId.slice(0, 6)}…${openId.slice(-4)}` : String(openId || '');
}

/** @param {{openId:string,role:string,status:string,grantedAt:string|null,grantedVia:string|null,inviteCode:string|null}} user */
function userRow(user) {
  const origins = /** @type {Record<string,string>} */ ({ invite: '邀请码', bootstrap: '初始管理员', migration: '迁移' });
  return {
    openId: user.openId,
    label: shortId(user.openId),
    roleLabel: user.role === 'admin' ? '管理员' : '成员',
    isAdmin: user.role === 'admin',
    statusLabel: user.status === 'suspended' ? '已停用' : '使用中',
    suspended: user.status === 'suspended',
    grantedLabel: user.grantedAt ? dateLabel(user.grantedAt) : '—',
    originLabel: origins[user.grantedVia || ''] || '—',
    inviteCode: user.inviteCode || '—'
  };
}

/** @param {unknown} code Shown in two groups so it can be read aloud or retyped without losing the place. */
function displayCode(code) {
  return typeof code === 'string' && code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : String(code || '');
}

/** @param {{code:string,maxUses:number,usedCount:number,expiresAt:string,active:boolean,createdAt:string,note:string|null}} invite */
function inviteRow(invite, now = Date.now()) {
  const expired = !(now < Date.parse(invite.expiresAt));
  const exhausted = invite.usedCount >= invite.maxUses;
  return {
    code: invite.code,
    display: displayCode(invite.code),
    usageLabel: `${invite.usedCount} / ${invite.maxUses}`,
    expiryLabel: `${dateLabel(invite.expiresAt)} 到期`,
    createdLabel: dateLabel(invite.createdAt),
    note: invite.note || '',
    // A code is only offerable when it is active, unexpired and has uses left.
    usable: invite.active && !expired && !exhausted,
    stateLabel: !invite.active ? '已停用' : expired ? '已过期' : exhausted ? '已用完' : '可用'
  };
}

module.exports = { checkInviteForm, userRow, inviteRow, dateLabel, shortId, displayCode, USES, DAYS, NOTE_MAX };
