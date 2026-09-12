'use strict';
const cloudbase = require('@cloudbase/node-sdk');

function currentWxContext(runtimeContext) {
  try {
    if (!runtimeContext || typeof runtimeContext !== 'object' || Array.isArray(runtimeContext)) return {};
    // parseContext reads only this invocation; getWXContext/getCloudbaseContext can inherit old process variables.
    const parsed = cloudbase.parseContext(runtimeContext);
    const env = parsed.environment || parsed.environ;
    if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
    const identity = {};
    for (const key of ['APPID', 'OPENID', 'UNIONID']) {
      const values = [env[`WX_${key}`], env[key]].filter(value => value !== undefined && value !== null);
      if (values.some(value => typeof value !== 'string' || value.length > 256 || value !== values[0])) return {};
      if (values[0]) identity[key] = values[0];
    }
    if (typeof env.TCB_SOURCE === 'string' && env.TCB_SOURCE.length <= 128) identity.SOURCE = env.TCB_SOURCE;
    return identity;
  } catch { return {}; }
}

module.exports = { currentWxContext };
