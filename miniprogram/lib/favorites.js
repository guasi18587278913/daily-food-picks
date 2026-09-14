'use strict';
const ID = /^[0-9a-f]{24}$/;
/** @param {{get:()=>unknown,set:(value:{version:number,items:Record<string,number>,pending:Record<string,number>})=>void}} storage */
function createFavorites(storage) {
  let values = /** @type {Record<string,number>} */ ({});
  let pending = /** @type {Record<string,number>} */ ({}); let corrupt = false;
  /** @param {unknown} raw @returns {Record<string,number>} */
  function validItems(raw) {
    const result = /** @type {Record<string,number>} */ ({});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { corrupt = true; return result; }
    for (const [key, value] of Object.entries(raw)) {
      if (ID.test(key) && Number.isSafeInteger(value) && value > 0) result[key] = value;
      else corrupt = true;
    }
    return result;
  }
  try {
    const raw = storage.get();
    if (raw !== undefined && raw !== null && raw !== '') {
      if (typeof raw === 'object' && 'version' in raw && raw.version === 2) {
        values = validItems('items' in raw ? raw.items : null);
        const storedPending = validItems('pending' in raw ? raw.pending : null);
        for (const [key, value] of Object.entries(storedPending)) {
          if (values[key] === value) pending[key] = value; else corrupt = true;
        }
      } else {
        // An old client had no account sync marker: offer its saved items once during upgrade.
        values = validItems(raw); pending = { ...values };
      }
    }
  } catch { corrupt = true; }
  return {
    corrupt,
    /** @param {string} id */ has(id) { return Object.prototype.hasOwnProperty.call(values, id); },
    ids() { return Object.keys(values).sort((a, b) => values[b] - values[a] || a.localeCompare(b)); },
    /** The local copy, used as the source for a one-time merge into the account. */
    entries() { return { ...values }; },
    pendingEntries() { return { ...pending }; },
    count() { return Object.keys(values).length; },
    /**
     * Replaces the local copy with what the server holds. The server is authoritative once merged,
     * so this mirrors rather than merges; a storage failure is reported, not hidden.
     * @param {Record<string,number>} incoming @param {Record<string,number>} [acknowledged]
     */
    replace(incoming, acknowledged = pending) {
      const remaining = Object.fromEntries(Object.entries(pending).filter(([key, value]) => acknowledged[key] !== value));
      const next = { ...validItems(incoming || {}), ...remaining };
      try {
        storage.set({ version: 2, items: next, pending: remaining }); values = next; pending = remaining;
        return { ok: true, message: '' };
      } catch {
        values = next; pending = remaining;
        return { ok: false, message: '收藏已同步，但这台手机没能存下本地副本。' };
      }
    },
    /** @param {string} id */ toggle(id) {
      if (!ID.test(id)) return { ok: false, message: '收藏编号无效。' };
      if (Object.prototype.hasOwnProperty.call(values, id) && !Object.prototype.hasOwnProperty.call(pending, id)) {
        return { ok: false, message: '取消已同步的收藏需要连接，请恢复连接后重试。' };
      }
      const next = { ...values }; const nextPending = { ...pending };
      if (Object.prototype.hasOwnProperty.call(next, id)) { delete next[id]; delete nextPending[id]; }
      else { next[id] = Date.now(); nextPending[id] = next[id]; }
      try {
        storage.set({ version: 2, items: next, pending: nextPending }); values = next; pending = nextPending;
        return { ok: true, selected: Object.prototype.hasOwnProperty.call(values, id) };
      }
      catch { return { ok: false, message: '未能保存收藏，请检查手机存储后重试。' }; }
    }
  };
}
module.exports = { createFavorites };
