'use strict';
const ID = /^[0-9a-f]{24}$/;
/** @param {{get:()=>unknown,set:(value:Record<string,number>)=>void}} storage */
function createFavorites(storage) {
  let values = /** @type {Record<string,number>} */ ({}); let corrupt = false;
  try {
    const raw = storage.get();
    if (raw !== undefined && raw !== null && raw !== '') {
      if (typeof raw !== 'object' || Array.isArray(raw)) corrupt = true;
      else for (const [key, value] of Object.entries(raw)) {
        if (ID.test(key) && Number.isSafeInteger(value) && value > 0) values[key] = value;
        else corrupt = true;
      }
    }
  } catch { corrupt = true; }
  return {
    corrupt,
    /** @param {string} id */ has(id) { return Object.prototype.hasOwnProperty.call(values, id); },
    ids() { return Object.keys(values).sort((a, b) => values[b] - values[a] || a.localeCompare(b)); },
    /** The local copy, used as the source for a one-time merge into the account. */
    entries() { return { ...values }; },
    count() { return Object.keys(values).length; },
    /**
     * Replaces the local copy with what the server holds. The server is authoritative once merged,
     * so this mirrors rather than merges; a storage failure is reported, not hidden.
     * @param {Record<string,number>} incoming
     */
    replace(incoming) {
      const next = /** @type {Record<string,number>} */ ({});
      for (const [key, value] of Object.entries(incoming || {})) {
        if (ID.test(key) && Number.isSafeInteger(value) && value > 0) next[key] = value;
      }
      try { storage.set(next); values = next; return { ok: true, message: '' }; }
      catch { values = next; return { ok: false, message: '收藏已同步，但这台手机没能存下本地副本。' }; }
    },
    /** @param {string} id */ toggle(id) {
      if (!ID.test(id)) return { ok: false, message: '收藏编号无效。' };
      const next = { ...values }; if (Object.prototype.hasOwnProperty.call(next, id)) delete next[id]; else next[id] = Date.now();
      try { storage.set(next); values = next; return { ok: true, selected: Object.prototype.hasOwnProperty.call(values, id) }; }
      catch { return { ok: false, message: '未能保存收藏，请检查手机存储后重试。' }; }
    }
  };
}
module.exports = { createFavorites };
