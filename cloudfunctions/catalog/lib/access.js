'use strict';

function fail(code) { const e = new Error(code); e.code = code; throw e; }
function accessConfig(env = process.env) {
  return { appId: env.DFP_APP_ID || 'wx8a2388888683b769',
    allowedOpenIds: (env.DFP_ALLOWED_OPENIDS || '').split(',').map(x => x.trim()).filter(Boolean) };
}
function authorize(wxContext, config) {
  if (!wxContext || typeof wxContext.OPENID !== 'string' || !wxContext.OPENID
    || wxContext.APPID !== config.appId) fail('UNAUTHENTICATED');
  if (!Array.isArray(config.allowedOpenIds) || !config.allowedOpenIds.includes(wxContext.OPENID)) fail('FORBIDDEN');
  return wxContext.OPENID;
}

module.exports = { authorize, accessConfig };
