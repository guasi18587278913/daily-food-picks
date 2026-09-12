'use strict';
const wx = require('wx-server-sdk');
const cloudbase = require('@cloudbase/node-sdk');
const { accessConfig } = require('./lib/access');
const { CloudStore } = require('./lib/store');
const { createCatalog } = require('./lib/queries');
const { currentWxContext } = require('./lib/context');

exports.main = async (event, runtimeContext) => {
  try {
    const config = accessConfig();
    const envId = process.env.DFP_ENV_ID || 'food-picks-trial-d5elis0ecfcb5d2';
    wx.init({ env: envId });
    const context = currentWxContext(runtimeContext);
    const store = new CloudStore(cloudbase.init({ env: envId }).database());
    // Temporary setup captures only the last genuine caller, never grants permission.
    if (process.env.DFP_CAPTURE_CALLER_FOR_SETUP === 'true' && context.APPID === config.appId && context.OPENID
      && !config.allowedOpenIds.includes(context.OPENID)) {
      await store.put('dfp_state', 'setup-last-caller', { appId: context.APPID, openId: context.OPENID, seenAt: new Date().toISOString() });
    }
    return await createCatalog({ store, config,
      sign: async fileIds => (await wx.getTempFileURL({ fileList: fileIds.map(fileID => ({ fileID, maxAge: 300 })) })).fileList })(event, context);
  } catch { return { ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: '服务暂时不可用，稍后再试。' } }; }
};
