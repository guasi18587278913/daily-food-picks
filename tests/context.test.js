'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const wx = require('wx-server-sdk');
const { authorize } = require('../cloudfunctions/catalog/lib/access');
const { assertTimer } = require('../cloudfunctions/collectTick/lib/config');
const current = context => require('../cloudfunctions/collectTick/lib/context').currentWxContext(context);
const APP = 'wx8a2388888683b769';
const SECRET = 'a'.repeat(64);
function withPreviousUser(run) {
  const values = { WX_CONTEXT_KEYS: 'WX_OPENID,WX_APPID,WX_UNIONID', WX_OPENID: 'previous-user',
    WX_APPID: APP, WX_UNIONID: 'previous-union', TCB_SOURCE: 'wx_client' };
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  try { return run(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
test('a reused instance cannot lend the preceding WeChat identity to a request with no identity', () => withPreviousUser(() => {
  assert.equal(wx.getWXContext().OPENID, 'previous-user');
  const identity = current({ environment: '{}' });
  assert.deepEqual(identity, {});
  assert.throws(() => authorize(identity, { appId: APP, allowedOpenIds: ['previous-user'] }), /UNAUTHENTICATED/);
}));
test('current request identities replace previous process identities and remain subject to the allowlist', () => withPreviousUser(() => {
  const identity = current({ environment: JSON.stringify({ WX_APPID: APP, WX_OPENID: 'current-user', TCB_SOURCE: 'wx_client' }) });
  assert.deepEqual(identity, { APPID: APP, OPENID: 'current-user', SOURCE: 'wx_client' });
  assert.throws(() => authorize(identity, { appId: APP, allowedOpenIds: ['previous-user'] }), /FORBIDDEN/);
  assert.equal(authorize(identity, { appId: APP, allowedOpenIds: ['current-user'] }), 'current-user');
}));
test('legacy SCF request context is parsed without inheriting a previous user', () => withPreviousUser(() => {
  assert.deepEqual(current({ environ: `WX_APPID=${APP};WX_OPENID=current-user;TCB_SOURCE=wx_client` }),
    { APPID: APP, OPENID: 'current-user', SOURCE: 'wx_client' });
  assert.deepEqual(current({ environ: '' }), {});
}));
test('missing, malformed, ambiguous, or event-shaped contexts grant no identity', () => withPreviousUser(() => {
  for (const value of [undefined, null, {}, { environment: 'not-json' },
    { environment: JSON.stringify({ WX_APPID: APP, WX_OPENID: ['previous-user'] }) },
    { environment: JSON.stringify({ WX_APPID: APP, WX_OPENID: 'one', OPENID: 'two' }) },
    { APPID: APP, OPENID: 'previous-user' }]) {
    assert.deepEqual(current(value), {});
  }
}));
test('a real server timer is not poisoned by a preceding rejected WeChat call', () => withPreviousUser(() => {
  assert.doesNotThrow(() => assertTimer({ Type: 'Timer', TriggerName: 'food-picks-timer', Message: SECRET },
    current({ environment: '{}' }), { timerSecret: SECRET }));
}));
test('a current WeChat caller cannot use a server timer credential or an event-supplied identity', () => {
  const caller = current({ environment: JSON.stringify({ WX_APPID: APP, WX_OPENID: 'current-user' }) });
  assert.throws(() => assertTimer({ Type: 'Timer', TriggerName: 'food-picks-timer', Message: SECRET }, caller,
    { timerSecret: SECRET }), /UNAUTHORIZED_TRIGGER/);
  const forgedEvent = { OPENID: 'previous-user', APPID: APP, environment: JSON.stringify({ WX_APPID: APP, WX_OPENID: 'previous-user' }) };
  assert.throws(() => authorize(current({ environment: '{}' }), { appId: APP, allowedOpenIds: [forgedEvent.OPENID] }), /UNAUTHENTICATED/);
});
function entry(name, modules) {
  const exported = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', name, 'index.js'), 'utf8'), {
    exports: exported, process: { env: { DFP_CAPTURE_CALLER_FOR_SETUP: 'true' } }, console: { error() {} },
    require: key => {
      if (Object.hasOwn(modules, key)) return modules[key];
      throw new Error(`Unexpected dependency: ${key}`);
    }
  });
  return exported.main;
}
test('catalog entry uses the platform second argument, ignoring forged event context and stale SDK identity', async () => {
  let reads = 0; let writes = 0;
  class Store { async get() { reads++; return null; } async put() { writes++; } }
  const main = entry('catalog', {
    'wx-server-sdk': { init() {}, getWXContext: () => ({ APPID: APP, OPENID: 'previous-user' }) },
    '@cloudbase/node-sdk': { init: () => ({ database() {} }) },
    './lib/access': { accessConfig: () => ({ appId: APP, allowedOpenIds: ['previous-user'] }) },
    './lib/store': { CloudStore: Store }, './lib/queries': require('../cloudfunctions/catalog/lib/queries'),
    './lib/context': require('../cloudfunctions/collectTick/lib/context')
  });
  const fake = { action: 'status', OPENID: 'previous-user', APPID: APP,
    environment: JSON.stringify({ WX_APPID: APP, WX_OPENID: 'previous-user' }) };
  assert.equal((await main(fake, { environment: '{}' })).error.code, 'UNAUTHENTICATED');
  assert.equal(reads, 0); assert.equal(writes, 0);
  assert.equal((await main({ action: 'status' }, { environment: JSON.stringify({ WX_APPID: APP, WX_OPENID: 'previous-user' }) })).ok, true);
  assert.ok(reads > 0);
});
test('collector entry verifies this invocation before any provider or database work', async () => {
  let externalWork = 0;
  const main = entry('collectTick', {
    'wx-server-sdk': { init() {}, getWXContext: () => ({ APPID: APP, OPENID: 'previous-user' }) },
    '@cloudbase/node-sdk': { init: () => { externalWork++; return {}; } },
    './lib/config': { loadConfig: () => ({ enabled: false, envId: 'trial', timerSecret: SECRET }), assertTimer },
    './lib/store': {}, './lib/judge': {}, './lib/runner': {},
    './lib/context': require('../cloudfunctions/collectTick/lib/context')
  });
  const timer = { Type: 'Timer', TriggerName: 'food-picks-timer', Message: SECRET };
  assert.equal((await main(timer, { environment: '{}' })).status, 'disabled');
  const currentCaller = { environment: JSON.stringify({ WX_APPID: APP, WX_OPENID: 'current-user' }) };
  assert.equal((await main(timer, currentCaller)).error.code, 'UNAUTHORIZED_TRIGGER');
  assert.equal(externalWork, 0);
});
