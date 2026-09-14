'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApi, createPoller, shouldFollowLatest, copySource } = require('../miniprogram/lib/api');
const { createFavorites } = require('../miniprogram/lib/favorites');
const { formatMetric, sortNotes } = require('../miniprogram/lib/view');
const id = n => String(n).padStart(24, '0');

test('refresh only calls catalog and rejects a business error even when transport succeeds', async () => {
  const called = [];
  const api = createApi(async options => { called.push(options); return { result: { ok: false, error: { code: 'FORBIDDEN', message: '暂未开通' } } }; });
  await assert.rejects(api('status'), e => e.code === 'FORBIDDEN');
  assert.deepEqual(called.map(x => x.name), ['catalog']);
  const successful = createApi(async () => ({ result: { ok: true, data: { revision: 'new' } } }));
  assert.equal((await successful('status')).revision, 'new');
});
test('returning to the page checks immediately and hiding clears the 60 second polling timer', async () => {
  let checks = 0; const timers = new Set();
  const poller = createPoller(async () => { checks++; }, {
    setInterval: (_callback, ms) => { assert.equal(ms, 60000); timers.add(1); return 1; },
    clearInterval: handle => timers.delete(handle)
  });
  await poller.show(); assert.equal(checks, 1); assert.equal(timers.size, 1);
  poller.hide(); assert.equal(timers.size, 0);
  await poller.show(); assert.equal(checks, 2);
  poller.hide();
});
test('historical reading and favorites are not forcibly replaced by a newer round', () => {
  assert.equal(shouldFollowLatest({ mode: 'round', snapshotId: 'old' }, 'old'), true);
  assert.equal(shouldFollowLatest({ mode: 'round', snapshotId: 'older' }, 'old'), false);
  assert.equal(shouldFollowLatest({ mode: 'favorites', snapshotId: 'old' }, 'old'), false);
});
test('favorites survive reopen; failed writes do not claim success; corrupt storage is reported', () => {
  let saved; const storage = { get: () => saved, set: value => { saved = value; } };
  const first = createFavorites(storage); assert.equal(first.toggle(id(1)).ok, true);
  const reopened = createFavorites(storage); assert.equal(reopened.has(id(1)), true);
  assert.equal(reopened.toggle(id(1)).ok, true); assert.equal(reopened.has(id(1)), false);
  const failed = createFavorites({ get: () => ({}), set: () => { throw new Error('full'); } });
  assert.equal(failed.toggle(id(2)).ok, false); assert.equal(failed.has(id(2)), false);
  assert.equal(createFavorites({ get: () => '{broken', set() {} }).corrupt, true);
});
test('null metrics stay unknown and sorting is stable, with unknown values last', () => {
  assert.equal(formatMetric(null), '—'); assert.equal(formatMetric(0), '0');
  const rows = [{ noteId: id(3), likes: null }, { noteId: id(2), likes: 0 }, { noteId: id(1), likes: 0 }];
  assert.deepEqual(sortNotes(rows, 'likes').map(x => x.noteId), [id(1), id(2), id(3)]);
  assert.deepEqual(sortNotes([{ noteId: id(1), ratio: 2 }, { noteId: id(2), ratio: 5 }], 'ratio').map(x => x.noteId), [id(2), id(1)]);
});
test('copy only reports success after the native callback and rejects unsafe or missing links', async () => {
  let requested;
  const result = copySource(`https://www.xiaohongshu.com/explore/${id(1)}`, options => { requested = options; });
  let done = false; result.then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false);
  requested.success(); await result; assert.equal(done, true);
  await assert.rejects(copySource('javascript:alert(1)', () => {}));
  await assert.rejects(copySource(null, () => {}));
  await assert.rejects(copySource(`https://www.xiaohongshu.com/explore/${id(1)}`, options => options.fail()));
});

function pageHarness() {
  let definition;
  global.wx = { cloud: { callFunction: async () => ({}) }, showToast() {} };
  global.Page = value => { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/index/index'); delete require.cache[modulePath]; require(modulePath);
  delete global.Page;
  return { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
}
function accessHarness(meResult, accountCalls = []) {
  const page = pageHarness();
  page._account = async (action, params) => {
    accountCalls.push({ action, params });
    if (action === 'me') { if (meResult instanceof Error) throw meResult; return meResult; }
    throw new Error(`unexpected account action ${action}`);
  };
  return page;
}
function refusal(code, message) {
  const error = /** @type {any} */ (new Error(message || code));
  error.code = code;
  return error;
}

test('the entry screen is decided by the server, not guessed by the client', async () => {
  for (const [result, access, role] of [
    [{ role: 'member', status: 'active', grantedAt: '2026-09-13T00:00:00.000Z' }, 'ready', 'member'],
    [{ role: 'admin', status: 'active', grantedAt: '2026-09-13T00:00:00.000Z' }, 'ready', 'admin'],
    [refusal('NOT_REGISTERED', '这个微信还没有开通，输入邀请码即可使用。'), 'needsCode', ''],
    [refusal('SUSPENDED', '这个账号已停用，请联系管理员。'), 'suspended', ''],
    [refusal('UNAUTHENTICATED', '请从微信重新进入。'), 'blocked', ''],
    [refusal('NETWORK_ERROR', '连接失败，原有内容已保留。'), 'blocked', '']
  ]) {
    const page = accessHarness(result);
    await page.checkAccess();
    assert.equal(page.data.access, access);
    assert.equal(page.data.role, role);
  }
});

test('an account without access fetches no topic data and starts no polling', async () => {
  for (const code of ['NOT_REGISTERED', 'SUSPENDED', 'UNAUTHENTICATED']) {
    const calls = [];
    const page = accessHarness(refusal(code), calls);
    const catalogCalls = [];
    page._api = async action => { catalogCalls.push(action); return {}; };
    const timers = [];
    page._poller = createPoller(() => page.checkUpdates(), {
      setInterval: () => { timers.push(1); return 1; }, clearInterval: () => timers.pop()
    });
    page._visible = true;
    await page.checkAccess();
    assert.deepEqual(catalogCalls, [], `${code} must not reach the topic data`);
    assert.deepEqual(timers, [], `${code} must not start the 60 second poller`);
    assert.deepEqual(calls.map(c => c.action), ['me']);
  }
});

test('a granted account starts polling only while the page is in the foreground', async () => {
  const me = { role: 'member', status: 'active', grantedAt: '2026-09-13T00:00:00.000Z' };
  for (const visible of [true, false]) {
    const page = accessHarness(me);
    const timers = [];
    page._poller = createPoller(async () => {}, {
      setInterval: () => { timers.push(1); return 1; }, clearInterval: () => timers.pop()
    });
    page._visible = visible;
    await page.checkAccess();
    assert.equal(timers.length, visible ? 1 : 0);
  }
});

test('submitting an invite code opens the current session without a restart', async () => {
  const calls = [];
  const page = accessHarness(refusal('NOT_REGISTERED'), calls);
  await page.checkAccess();
  assert.equal(page.data.access, 'needsCode');

  page._account = async (action, params) => {
    calls.push({ action, params });
    if (action === 'redeem') return { role: 'member', status: 'active' };
    throw new Error('unexpected');
  };
  const checks = [];
  page._poller = createPoller(async () => { checks.push(1); }, { setInterval: () => 1, clearInterval() {} });
  page._visible = true;
  page.data.codeInput = ' abcde-fghjk ';
  await page.onSubmitCode();

  assert.equal(page.data.access, 'ready');
  assert.equal(page.data.role, 'member');
  assert.equal(page.data.codeInput, '');
  assert.equal(page.data.redeeming, false);
  assert.deepEqual(calls.filter(c => c.action === 'redeem').map(c => c.params.code), ['abcde-fghjk']);
  assert.equal(checks.length, 1, 'a fresh grant loads content straight away');
});

test('a refused invite code keeps the entry screen and shows why', async () => {
  const page = accessHarness(refusal('NOT_REGISTERED'));
  await page.checkAccess();
  page._account = async () => { throw refusal('CODE_EXHAUSTED', '邀请码已被用完，请向管理员要一个新的。'); };
  page.data.codeInput = 'ABCDEFGHJK';
  await page.onSubmitCode();
  assert.equal(page.data.access, 'needsCode');
  assert.equal(page.data.message, '邀请码已被用完，请向管理员要一个新的。');
  assert.equal(page.data.redeeming, false);
  assert.equal(page.data.codeInput, 'ABCDEFGHJK', 'the typed code is kept so it can be corrected');
});

test('an empty or in-flight submission is not sent', async () => {
  const page = accessHarness(refusal('NOT_REGISTERED'));
  await page.checkAccess();
  const sent = [];
  page._account = async (action, params) => { sent.push(params.code); return { role: 'member', status: 'active' }; };
  page.data.codeInput = '   ';
  await page.onSubmitCode();
  assert.deepEqual(sent, []);

  page.data.codeInput = 'ABCDEFGHJK';
  page.data.redeeming = true;
  await page.onSubmitCode();
  assert.deepEqual(sent, [], 'a second tap while one submission is in flight is ignored');
});

test('losing access mid-session clears content and stops polling', async () => {
  const page = accessHarness({ role: 'member', status: 'active', grantedAt: '2026-09-13T00:00:00.000Z' });
  const timers = [];
  page._poller = createPoller(async () => {}, {
    setInterval: () => { timers.push(1); return 1; }, clearInterval: () => timers.pop()
  });
  page._visible = true;
  await page.checkAccess();
  assert.equal(timers.length, 1);

  page._notes = [{ noteId: id(1) }];
  page.showError(refusal('SUSPENDED', '这个账号已停用，请联系管理员。'));
  assert.equal(page.data.access, 'suspended');
  assert.equal(page._notes.length, 0);
  assert.equal(page.data.total, 0);
  assert.deepEqual(timers, [], 'polling must stop once access is gone');
});

test('the management entry is shown to an administrator only', async () => {
  for (const [role, visible] of [['admin', true], ['member', false]]) {
    const page = accessHarness({ role, status: 'active', grantedAt: '2026-09-13T00:00:00.000Z' });
    await page.checkAccess();
    assert.equal(page.data.role === 'admin', visible);
  }
});

function favoritesHarness(localItems, responses) {
  const page = pageHarness();
  const calls = [];
  let saved = { ...localItems };
  page._favorites = createFavorites({ get: () => saved, set: value => { saved = value; } });
  page._account = async (action, params) => {
    calls.push({ action, params });
    const reply = responses[action];
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(params) : reply;
  };
  page._poller = createPoller(async () => {}, { setInterval: () => 1, clearInterval() {} });
  return { page, calls, local: () => saved?.version === 2 ? saved.items : saved,
    reopen() { page._favorites = createFavorites({ get: () => saved, set: value => { saved = value; } }); } };
}

test('a local favourite set is merged up once, then the account copy is mirrored down', async () => {
  const { page, calls, local } = favoritesHarness({ [id(1)]: 1000 }, {
    me: { role: 'member', status: 'active', grantedAt: '2026-09-13T00:00:00.000Z' },
    'favorites.list': { items: { [id(2)]: 2000 }, mergedAt: null },
    'favorites.merge': { items: { [id(1)]: 1000, [id(2)]: 2000 }, mergedAt: '2026-09-13T02:00:00.000Z', count: 2 }
  });
  await page.checkAccess();
  assert.deepEqual(calls.map(c => c.action), ['me', 'favorites.list', 'favorites.merge']);
  assert.deepEqual(calls[2].params.items, { [id(1)]: 1000 }, 'only the local copy is offered for merging');
  assert.deepEqual(local(), { [id(1)]: 1000, [id(2)]: 2000 }, 'the union is mirrored locally');
  assert.equal(page.data.favoriteCount, 2);
});

test('nothing extra is sent when this phone holds no favourite the account is missing', async () => {
  const { page, calls, local } = favoritesHarness({ [id(3)]: 3000 }, {
    me: { role: 'member', status: 'active', grantedAt: '2026-09-13T00:00:00.000Z' },
    'favorites.list': { items: { [id(3)]: 3000, [id(4)]: 4000 }, mergedAt: '2026-09-13T02:00:00.000Z' }
  });
  await page.checkAccess();
  assert.deepEqual(calls.map(c => c.action), ['me', 'favorites.list'], 'no merge is needed, so none is sent');
  assert.deepEqual(local(), { [id(3)]: 3000, [id(4)]: 4000 }, 'the account copy is mirrored down');
});

test('favourites added while the account was unreachable are merged up, not discarded', async () => {
  // The failure this covers: an outage flips the page to local-only, the user keeps saving,
  // and the next cold start used to overwrite those entries with the account copy.
  const outage = /** @type {any} */ (new Error('连接失败'));
  outage.code = 'NETWORK_ERROR';
  const responses = {
    me: { role: 'member', status: 'active', grantedAt: '2026-09-13T00:00:00.000Z' },
    'favorites.list': outage
  };
  const { page, calls, local } = favoritesHarness({ [id(1)]: 1000 }, responses);
  await page.checkAccess();
  assert.equal(page._cloudFavorites, false);

  // Offline additions land in local storage only.
  await page.onFavorite({ currentTarget: { dataset: { id: id(5) } } });
  assert.deepEqual(Object.keys(local()).sort(), [id(1), id(5)].sort());

  // The account comes back and already carries mergedAt from the first upgrade.
  calls.length = 0;
  responses['favorites.list'] = { items: { [id(1)]: 1000 }, mergedAt: '2026-09-13T02:00:00.000Z' };
  responses['favorites.merge'] = params => ({ items: { ...params.items, [id(1)]: 1000 },
    mergedAt: '2026-09-13T05:00:00.000Z', count: Object.keys(params.items).length });
  await page.checkAccess();

  assert.deepEqual(calls.map(c => c.action), ['me', 'favorites.list', 'favorites.merge'],
    'a local-only addition must still be offered for merging after mergedAt is set');
  assert.deepEqual(Object.keys(local()).sort(), [id(1), id(5)].sort(), 'the offline addition survives');
  assert.equal(page._cloudFavorites, true);
});

test('opening the favourites list retries the sync after an outage', async () => {
  const outage = /** @type {any} */ (new Error('连接失败'));
  outage.code = 'NETWORK_ERROR';
  const responses = {
    me: { role: 'member', status: 'active', grantedAt: '2026-09-13T00:00:00.000Z' },
    'favorites.list': outage
  };
  const { page, calls } = favoritesHarness({}, responses);
  await page.checkAccess();
  assert.equal(page._cloudFavorites, false);

  responses['favorites.list'] = { items: {}, mergedAt: '2026-09-13T02:00:00.000Z' };
  page._api = async () => ({ notes: [], missing: [] });
  calls.length = 0;
  await page.loadFavorites();
  assert.deepEqual(calls.map(c => c.action), ['favorites.list'], 'local-only mode is not a one-way trap');
  assert.equal(page._cloudFavorites, true);
});

test('a reopened device does not restore a synced favourite cancelled on another device', async () => {
  const responses = {
    'favorites.list': { items: { [id(1)]: 1000 }, mergedAt: 'already-merged' },
    'favorites.merge': params => ({ items: params.items, mergedAt: 'already-merged' })
  };
  const phoneB = favoritesHarness({}, responses);
  await phoneB.page.syncFavorites();
  assert.deepEqual(phoneB.local(), { [id(1)]: 1000 });
  // Device A has successfully removed the shared favourite on the server.
  responses['favorites.list'] = { items: {}, mergedAt: 'already-merged' };
  phoneB.reopen(); phoneB.calls.length = 0;
  await phoneB.page.syncFavorites();
  assert.deepEqual(phoneB.calls.map(call => call.action), ['favorites.list']);
  assert.deepEqual(phoneB.local(), {}, 'the old synced mirror must follow the remote removal');
});

test('an offline cancellation of a synced item reports that connection is required', async () => {
  const responses = { 'favorites.list': { items: { [id(1)]: 1000 } } };
  const phone = favoritesHarness({}, responses);
  await phone.page.syncFavorites();
  responses['favorites.list'] = new Error('offline');
  await phone.page.syncFavorites();
  const toasts = []; global.wx.showToast = message => toasts.push(message.title);
  await phone.page.onFavorite({ currentTarget: { dataset: { id: id(1) } } });
  assert.equal(phone.page._favorites.has(id(1)), true);
  assert.ok(toasts.some(message => /恢复连接/.test(message)));
  assert.equal(toasts.includes('已取消收藏'), false);
});

test('offline additions survive a cold start without reuploading an old synced mirror', async () => {
  const responses = {
    'favorites.list': { items: { [id(1)]: 1000 }, mergedAt: 'already-merged' },
    'favorites.merge': params => ({ items: params.items, mergedAt: 'already-merged' })
  };
  const phone = favoritesHarness({}, responses);
  await phone.page.syncFavorites();
  responses['favorites.list'] = new Error('offline');
  await phone.page.syncFavorites();
  await phone.page.onFavorite({ currentTarget: { dataset: { id: id(2) } } });
  phone.reopen(); phone.calls.length = 0;
  responses['favorites.list'] = { items: {}, mergedAt: 'already-merged' };
  await phone.page.syncFavorites();
  assert.deepEqual(Object.keys(phone.calls.find(call => call.action === 'favorites.merge').params.items), [id(2)]);
  assert.deepEqual(Object.keys(phone.local()), [id(2)]);
});

test('a new local favourite saved during a pending sync is retained for the next sync', async () => {
  let completeMerge;
  const mergeStarted = new Promise(resolve => { completeMerge = resolve; });
  let answer;
  const phone = favoritesHarness({ [id(1)]: 1000 }, {
    'favorites.list': { items: {} },
    'favorites.merge': () => { completeMerge(); return new Promise(resolve => { answer = resolve; }); }
  });
  const syncing = phone.page.syncFavorites();
  await mergeStarted;
  await phone.page.onFavorite({ currentTarget: { dataset: { id: id(2) } } });
  answer({ items: { [id(1)]: 1000 } });
  await syncing;
  assert.deepEqual(Object.keys(phone.local()).sort(), [id(1), id(2)]);
  phone.reopen();
  assert.deepEqual(Object.keys(phone.page._favorites.pendingEntries()), [id(2)]);
});

test('cancelling a favourite currently being uploaded waits for a retry instead of falsely succeeding', async () => {
  let started; let answer;
  const merging = new Promise(resolve => { started = resolve; });
  const phone = favoritesHarness({ [id(1)]: 1000 }, {
    'favorites.list': { items: {} },
    'favorites.merge': () => { started(); return new Promise(resolve => { answer = resolve; }); }
  });
  const toasts = []; global.wx.showToast = message => toasts.push(message.title);
  const syncing = phone.page.syncFavorites();
  await merging;
  const secondSync = phone.page.syncFavorites();
  await phone.page.onFavorite({ currentTarget: { dataset: { id: id(1) } } });
  assert.equal(phone.page._favorites.has(id(1)), true);
  assert.ok(toasts.some(message => /同步.*重试/.test(message)));
  assert.equal(toasts.includes('已取消收藏'), false);
  answer({ items: { [id(1)]: 1000 } });
  await Promise.all([syncing, secondSync]);
  assert.equal(phone.calls.filter(call => call.action === 'favorites.merge').length, 1);
});

test('sync waits for an earlier cloud cancellation before reading its authoritative state', async () => {
  let started; let finishWrite; let remote = { [id(1)]: 1000 };
  const writing = new Promise(resolve => { started = resolve; });
  const phone = favoritesHarness({}, {
    'favorites.list': () => ({ items: { ...remote } }),
    'favorites.toggle': async () => {
      started(); await new Promise(resolve => { finishWrite = resolve; });
      remote = {}; return { selected: false };
    }
  });
  await phone.page.syncFavorites(); phone.calls.length = 0;
  const cancelling = phone.page.onFavorite({ currentTarget: { dataset: { id: id(1) } } });
  await writing;
  const syncing = phone.page.syncFavorites();
  await Promise.resolve(); await Promise.resolve();
  const readWhileWriting = phone.calls.some(call => call.action === 'favorites.list');
  finishWrite();
  await Promise.all([cancelling, syncing]);
  assert.equal(readWhileWriting, false, 'the sync must not read stale state during a pending write');
  assert.deepEqual(phone.local(), {});
  assert.deepEqual(remote, {});
});

test('an access-level refusal on a favourite write closes the content down', async () => {
  const suspended = /** @type {any} */ (new Error('这个账号已停用，请联系管理员。'));
  suspended.code = 'SUSPENDED';
  const { page } = favoritesHarness({}, {
    me: { role: 'member', status: 'active', grantedAt: '2026-09-13T00:00:00.000Z' },
    'favorites.list': { items: {}, mergedAt: '2026-09-13T02:00:00.000Z' },
    'favorites.toggle': suspended
  });
  page._notes = [{ noteId: id(1) }];
  await page.checkAccess();
  await page.onFavorite({ currentTarget: { dataset: { id: id(5) } } });
  assert.equal(page.data.access, 'suspended', 'the page must not keep showing content after losing access');
  assert.equal(page._notes.length, 0);
});

test('a failed sync keeps the local favourites untouched', async () => {
  const failure = /** @type {any} */ (new Error('服务暂时不可用'));
  failure.code = 'BACKEND_UNAVAILABLE';
  const { page, local } = favoritesHarness({ [id(1)]: 1000 }, {
    me: { role: 'member', status: 'active', grantedAt: '2026-09-13T00:00:00.000Z' },
    'favorites.list': failure
  });
  await page.checkAccess();
  assert.equal(page.data.access, 'ready', 'a favourites problem does not lock the user out');
  assert.deepEqual(local(), { [id(1)]: 1000 }, 'nothing saved on this phone is lost');
  assert.equal(page._cloudFavorites, false);
});

test('a favourite is only shown as saved once the account write succeeds', async () => {
  const refusal = /** @type {any} */ (new Error('收藏数量已达上限，清理一些再试。'));
  refusal.code = 'LIMIT_EXCEEDED';
  const { page, local } = favoritesHarness({}, {
    me: { role: 'member', status: 'active', grantedAt: '2026-09-13T00:00:00.000Z' },
    'favorites.list': { items: {}, mergedAt: '2026-09-13T02:00:00.000Z' },
    'favorites.toggle': refusal
  });
  await page.checkAccess();
  assert.equal(page._cloudFavorites, true);
  await page.onFavorite({ currentTarget: { dataset: { id: id(5) } } });
  assert.deepEqual(local(), {}, 'a refused write leaves no local trace');
  assert.equal(page.data.favoriteCount, 0);
});

test('a successful account write updates both the account and the local mirror', async () => {
  const { page, local } = favoritesHarness({}, {
    me: { role: 'member', status: 'active', grantedAt: '2026-09-13T00:00:00.000Z' },
    'favorites.list': { items: {}, mergedAt: '2026-09-13T02:00:00.000Z' },
    'favorites.toggle': params => ({ selected: true, count: 1, noteId: params.noteId })
  });
  await page.checkAccess();
  await page.onFavorite({ currentTarget: { dataset: { id: id(5) } } });
  assert.deepEqual(Object.keys(local()), [id(5)]);

  page._account = async () => ({ selected: false, count: 0 });
  await page.onFavorite({ currentTarget: { dataset: { id: id(5) } } });
  assert.deepEqual(local(), {});
});

test('without a cloud copy the local path still works so an offline device is not blocked', async () => {
  const failure = /** @type {any} */ (new Error('连接失败'));
  failure.code = 'NETWORK_ERROR';
  const { page, local } = favoritesHarness({}, {
    me: { role: 'member', status: 'active', grantedAt: '2026-09-13T00:00:00.000Z' },
    'favorites.list': failure
  });
  await page.checkAccess();
  assert.equal(page._cloudFavorites, false);
  await page.onFavorite({ currentTarget: { dataset: { id: id(5) } } });
  assert.deepEqual(Object.keys(local()), [id(5)], 'the local-only path keeps working');
});

test('a failed replacement snapshot keeps the current content and identity', async () => {
  const page = pageHarness(); page._currentRoundId = 'old'; page._notes = [{ noteId: id(1) }];
  page._api = async () => { throw new Error('network'); };
  assert.equal(await page.loadRound('new'), false);
  assert.equal(page._currentRoundId, 'old'); assert.equal(page._notes[0].noteId, id(1));
});
test('a pending history selection wins over a concurrently arriving latest-status response', async () => {
  const page = pageHarness(); page._currentRoundId = 'old-latest'; page._latestId = 'old-latest';
  let resolveStatus; let resolveHistory; const requested = [];
  page._api = async (action, params) => {
    if (action === 'status') return new Promise(resolve => { resolveStatus = resolve; });
    if (action === 'getRound') { requested.push(params.snapshotId); return new Promise(resolve => { resolveHistory = resolve; }); }
    return { rounds: [], nextCursor: null };
  };
  const poll = page.checkUpdates();
  const selected = page.loadRound('older-history', 'history');
  resolveStatus({ status: 'complete', snapshotId: 'new-latest' }); await poll;
  resolveHistory({ snapshotId: 'older-history', notes: [], scheduledAt: '2026-09-11T01:00:00Z', finishedAt: '2026-09-11T01:01:00Z', count: 0 });
  await selected;
  assert.deepEqual(requested, ['older-history']); assert.equal(page._currentRoundId, 'older-history');
  assert.equal(page.data.newAvailable, true);
});
test('older status responses cannot roll the latest page back after a newer response is accepted', async () => {
  const page = pageHarness(); page._currentRoundId = 'initial'; page._latestId = 'initial';
  const statuses = []; const loaded = [];
  page._api = async (action, params) => {
    if (action === 'status') return new Promise(resolve => statuses.push(resolve));
    if (action === 'getRound') {
      loaded.push(params.snapshotId);
      return { snapshotId: params.snapshotId, notes: [], scheduledAt: '2026-09-12T01:00:00Z', finishedAt: '2026-09-12T01:01:00Z' };
    }
    return { rounds: [], nextCursor: null };
  };
  const older = page.checkUpdates(); const newer = page.checkUpdates();
  statuses[1]({ status: 'complete', snapshotId: 'B' }); await newer;
  statuses[0]({ status: 'complete', snapshotId: 'A' }); await older;
  assert.equal(page._currentRoundId, 'B'); assert.deepEqual(loaded, ['B']);
});
test('permission denial invalidates older successful data responses', async () => {
  const page = pageHarness(); let resolveRound;
  page._api = async action => {
    if (action === 'getRound') return new Promise(resolve => { resolveRound = resolve; });
    const error = new Error('forbidden'); error.code = 'FORBIDDEN'; throw error;
  };
  const old = page.loadRound('old-success'); await page.checkUpdates();
  assert.equal(page.data.access, 'blocked');
  resolveRound({ snapshotId: 'old-success', notes: [{ noteId: id(1), boards: ['today'] }], scheduledAt: '2026-09-12T01:00:00Z', finishedAt: '2026-09-12T01:01:00Z' });
  await old; assert.equal(page.data.access, 'blocked'); assert.equal(page._notes.length, 0);
});
test('clearing an unsubmitted search preserves the current favorites or history view', () => {
  for (const mode of ['favorites', 'history']) {
    const page = pageHarness(); page.data.mode = mode; page.data.query = '鸡蛋';
    page.onClearSearch(); assert.equal(page.data.mode, mode); assert.equal(page.data.query, '');
  }
});
