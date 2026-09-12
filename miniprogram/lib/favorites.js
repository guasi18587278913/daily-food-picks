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
    /** @param {string} id */ toggle(id) {
      if (!ID.test(id)) return { ok: false, message: '收藏编号无效。' };
      const next = { ...values }; if (Object.prototype.hasOwnProperty.call(next, id)) delete next[id]; else next[id] = Date.now();
      try { storage.set(next); values = next; return { ok: true, selected: Object.prototype.hasOwnProperty.call(values, id) }; }
      catch { return { ok: false, message: '未能保存收藏，请检查手机存储后重试。' }; }
    }
  };
}
module.exports = { createFavorites };
