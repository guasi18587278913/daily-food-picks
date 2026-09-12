'use strict';

/** @param {(options: {name:string,data:Record<string,unknown>}) => Promise<{result:any}>} callCloud */
function createApi(callCloud) {
  /** @param {string} action @param {Record<string,unknown>} [params] @returns {Promise<any>} */
  return async (action, params = {}) => {
    let response;
    try { response = await callCloud({ name: 'catalog', data: { ...params, action } }); }
    catch { const e = /** @type {FoodError} */ (new Error('连接失败，原有内容已保留。')); e.code = 'NETWORK_ERROR'; throw e; }
    const result = response.result;
    if (!result || result.ok !== true || !result.data || typeof result.data !== 'object') {
      const code = result?.error?.code;
      const messages = /** @type {Record<string,string>} */ ({ FORBIDDEN: '当前微信尚未开通试用。',
        UNAUTHENTICATED: '请从微信重新进入。', NOT_FOUND: '这轮内容暂不可用。', INVALID_CURSOR: '列表已变化，请重新查询。' });
      const e = /** @type {FoodError} */ (new Error(messages[code] || '服务暂时不可用，原有内容已保留。'));
      e.code = typeof code === 'string' ? code : 'INVALID_RESPONSE'; throw e;
    }
    return result.data;
  };
}
/** @param {() => Promise<unknown>} check @param {{setInterval:(fn:()=>void,ms:number)=>any,clearInterval:(id:any)=>void}} [timers] */
function createPoller(check, timers = { setInterval, clearInterval }) {
  let handle = /** @type {any} */ (null); let busy = false; let visible = false;
  const run = async () => { if (!visible || busy) return; busy = true; try { await check(); } catch {} finally { busy = false; } };
  return {
    async show() { visible = true; if (handle !== null) timers.clearInterval(handle); handle = timers.setInterval(() => { void run(); }, 60000); await run(); },
    hide() { visible = false; if (handle !== null) timers.clearInterval(handle); handle = null; }
  };
}
/** @param {{mode:string,snapshotId:string|null}} view @param {string|null} previousLatest */
function shouldFollowLatest(view, previousLatest) { return view.mode === 'round' && (!view.snapshotId || view.snapshotId === previousLatest); }
/** @param {string|null} url @param {(options:{data:string,success:()=>void,fail:()=>void})=>unknown} setClipboard @returns {Promise<void>} */
function copySource(url, setClipboard) {
  if (typeof url !== 'string' || !/^https:\/\/(?:www\.)?xiaohongshu\.com\/(?:explore|discovery\/item)\/[0-9a-f]{24}(?:\?[^\s]*)?$/.test(url)) {
    return Promise.reject(new Error('这篇内容暂时没有可用原文链接。'));
  }
  return new Promise((resolve, reject) => setClipboard({ data: url, success: resolve, fail: () => reject(new Error('复制失败，请再试一次。')) }));
}
module.exports = { createApi, createPoller, shouldFollowLatest, copySource };
