'use strict';
const wx = require('wx-server-sdk');
const cloudbase = require('@cloudbase/node-sdk');
const { loadConfig, assertTimer } = require('./lib/config');
const { CloudStore } = require('./lib/store');
const { freeModelGenerator } = require('./lib/judge');
const { runTick } = require('./lib/runner');
const { currentWxContext } = require('./lib/context');

exports.main = async (event, runtimeContext) => {
  try {
    const config = loadConfig();
    wx.init({ env: config.envId });
    assertTimer(event, currentWxContext(runtimeContext), config);
    if (!config.enabled) return { status: 'disabled' };
    const app = cloudbase.init({ env: config.envId });
    return await runTick({ config, store: new CloudStore(app.database()), key: process.env.DFP_TIKHUB_KEY,
      generate: freeModelGenerator(app), upload: options => wx.uploadFile(options), visionKey: process.env.DFP_VISION_KEY });
  } catch (e) {
    const code = ['UNAUTHORIZED_TRIGGER', 'CONFIGURATION_INCOMPLETE', 'FREE_AI_ONLY', 'INVALID_VALIDATION_TIME',
      'INVALID_SUPPLEMENT_CONFIG', 'INVALID_SUPPLEMENT_TIME', 'LEASE_EXPIRED', 'UNVERIFIED_PRICE'].includes(e.code) ? e.code : 'COLLECTOR_UNAVAILABLE';
    console.error(JSON.stringify({ code }));
    return { status: 'failed', error: { code } };
  }
};
