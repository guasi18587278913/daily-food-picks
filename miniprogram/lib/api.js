'use strict';

// The server decides what a caller may see; these texts only make a refusal readable.
const MESSAGES = /** @type {Record<string,string>} */ ({
  NOT_REGISTERED: '这个微信还没有开通，输入邀请码即可使用。',
  SUSPENDED: '这个账号已停用，请联系管理员。',
  FORBIDDEN: '没有权限执行这个操作。',
  UNAUTHENTICATED: '请从微信重新进入。',
  NOT_FOUND: '这轮内容暂不可用。',
  INVALID_CURSOR: '列表已变化，请重新查询。',
  CODE_NOT_FOUND: '邀请码无效，请核对后重新输入。',
  CODE_EXPIRED: '邀请码已过期，请向管理员要一个新的。',
  CODE_EXHAUSTED: '邀请码已被用完，请向管理员要一个新的。',
  ALREADY_REGISTERED: '这个微信已经开通，直接使用即可。',
  TOO_MANY_ATTEMPTS: '尝试次数过多，请稍后再试。',
  LAST_ADMIN: '系统需要保留至少一个管理员，这个操作被拒绝。',
  LIMIT_EXCEEDED: '收藏数量已达上限，清理一些再试。'
});

/**
 * @param {(options: {name:string,data:Record<string,unknown>}) => Promise<{result:any}>} callCloud
 * @param {string} [name] which cloud function to call
 */
function createApi(callCloud, name = 'catalog') {
  /** @param {string} action @param {Record<string,unknown>} [params] @returns {Promise<any>} */
  return async (action, params = {}) => {
    let response;
    try { response = await callCloud({ name, data: { ...params, action } }); }
    catch { const e = /** @type {FoodError} */ (new Error('连接失败，原有内容已保留。')); e.code = 'NETWORK_ERROR'; throw e; }
    const result = response.result;
    if (!result || result.ok !== true || !result.data || typeof result.data !== 'object') {
      const code = result?.error?.code;
      // A server message is preferred when present: only it can carry details such as a retry time.
      const e = /** @type {FoodError} */ (new Error(result?.error?.message || MESSAGES[code] || '服务暂时不可用，原有内容已保留。'));
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
module.exports = { createApi, createPoller, shouldFollowLatest, copySource, MESSAGES };
