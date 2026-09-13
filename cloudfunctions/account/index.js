'use strict';
const cloudbase = require('@cloudbase/node-sdk');
const { accessConfig } = require('./lib/access');
const { CloudStore } = require('./lib/store');
const { createAccount } = require('./lib/actions');
const { currentWxContext } = require('./lib/context');

exports.main = async (event, runtimeContext) => {
  try {
    const config = accessConfig();
    const envId = process.env.DFP_ENV_ID || 'food-picks-trial-d5elis0ecfcb5d2';
    const context = currentWxContext(runtimeContext);
    const store = new CloudStore(cloudbase.init({ env: envId }).database());
    return await createAccount({ store, config })(event, context);
  } catch (error) {
    // Initialisation failures would otherwise be invisible in the function log.
    console.error(`account entry failed: ${error && error.message}`);
    return { ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: '服务暂时不可用，稍后再试。' } };
  }
};
