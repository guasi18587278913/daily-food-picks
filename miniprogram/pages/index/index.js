'use strict';
const { createApi, createPoller, shouldFollowLatest } = require('../../lib/api');
const { createFavorites } = require('../../lib/favorites');
const { boards, card, formatTime } = require('../../lib/view');
const STORAGE_KEY = 'food-picks:favorites:v2';
const LEGACY_STORAGE_KEY = 'food-picks:favorites:v1';

Page({
  data: {
    // access: checking | ready | needsCode | suspended | blocked — decided by the server, never guessed here.
    access: 'checking', role: '', codeInput: '', redeeming: false,
    mode: 'round', query: '', loading: true, loadingMore: false, message: '',
    statusLabel: '正在查看更新', statusTone: '', roundLabel: '每天更新，给创作找点新意', updatedLabel: '',
    partialReason: '', coverageNotice: '基于当轮关键词发现选题，未覆盖小红书全部内容。',
    favoriteNotice: '收藏仅保存在本机',
    newAvailable: false, total: 0, favoriteCount: 0, nextCursor: /** @type {string|null} */ (null),
    rounds: /** @type {RoundItem[]} */ ([]), roundIndex: 0, olderRounds: false,
    sorts: /** @type {Record<string,string>} */ ({}), boardViews: boards([], {}, () => false, []),
    favoriteCards: /** @type {ReturnType<typeof card>[]} */ ([]), missingFavorites: /** @type {string[]} */ ([])
  },
  _api: createApi(options => wx.cloud.callFunction(options)),
  _account: createApi(options => wx.cloud.callFunction(options), 'account'),
  _favorites: /** @type {ReturnType<typeof createFavorites>|null} */ (null),
  _poller: /** @type {ReturnType<typeof createPoller>|null} */ (null),
  _notes: /** @type {FoodNote[]} */ ([]),
  _accounts: /** @type {RisingAccount[]} */ ([]),
  _currentRoundId: /** @type {string|null} */ (null),
  _latestId: /** @type {string|null} */ (null),
  _newestId: /** @type {string|null} */ (null),
  _roundCursor: /** @type {string|null} */ (null),
  _requestId: 0,
  _statusRequestId: 0,
  _favoriteOffset: 0,
  _cloudFavorites: false,
  _favoriteSync: /** @type {Promise<void>|null} */ (null),
  _favoriteOperation: /** @type {Promise<void>|null} */ (null),
  _syncingFavoriteIds: /** @type {string[]} */ ([]),
  _returnMode: 'round',
  _visible: false,
  _contentOpening: false,
  onLoad() {
    this._favorites = createFavorites({ get: () => {
      const current = wx.getStorageSync(STORAGE_KEY);
      return current === '' || current === undefined || current === null ? wx.getStorageSync(LEGACY_STORAGE_KEY) : current;
    }, set: value => wx.setStorageSync(STORAGE_KEY, value) });
    this.setData({ favoriteCount: this._favorites.ids().length });
    if (this._favorites.corrupt) wx.showToast({ title: '部分收藏记录无法读取', icon: 'none' });
    this._poller = createPoller(() => this.checkUpdates());
    void this.checkAccess();
  },
  onShow() { this._visible = true; if (this.data.access === 'ready') void this._poller?.show(); },
  onHide() { this._visible = false; this._poller?.hide(); },
  onUnload() { this._visible = false; this._poller?.hide(); this._requestId++; this._statusRequestId++; },
  async onPullDownRefresh() {
    try {
      if (this.data.access !== 'ready') { await this.checkAccess(); return; }
      await this.checkUpdates();
      if (this.data.mode === 'search') await this.search();
      else if (this.data.mode === 'favorites') await this.loadFavorites();
      else if (this._currentRoundId) await this.loadRound(this._currentRoundId, this.data.mode);
    } finally { wx.stopPullDownRefresh(); }
  },
  /** @param {string|undefined} code @returns {string} which screen a refusal leads to */
  accessStateFor(code) {
    if (code === 'NOT_REGISTERED') return 'needsCode';
    if (code === 'SUSPENDED') return 'suspended';
    return 'blocked';
  },
  /** Asks the server who the caller is. Nothing else decides which screen appears. */
  async checkAccess() {
    try {
      const me = await this._account('me');
      this.setData({ access: 'ready', role: me.role || '', message: '' });
      await this.syncFavorites();
      if (this._visible) void this._poller?.show();
      return true;
    } catch (caught) {
      const e = /** @type {FoodError} */ (caught);
      this.dropAccess(this.accessStateFor(e.code), e.message || '暂时无法读取，请稍后再试。');
      return false;
    }
  },
  /** @param {string} access @param {string} message */
  dropAccess(access, message) {
    this._requestId++; this._statusRequestId++;
    this._notes = []; this._poller?.hide();
    this.setData({ access, role: '', boardViews: [], favoriteCards: [], total: 0,
      message, loading: false, loadingMore: false });
  },
  /** @param {{detail:{value:string}}} event */
  onCodeInput(event) { this.setData({ codeInput: event.detail.value }); },
  async onSubmitCode() {
    if (this.data.redeeming) return;
    const code = this.data.codeInput.trim();
    if (!code) { wx.showToast({ title: '请先输入邀请码', icon: 'none' }); return; }
    this.setData({ redeeming: true, message: '' });
    try {
      const granted = await this._account('redeem', { code });
      this.setData({ access: 'ready', role: granted.role || 'member', codeInput: '', redeeming: false, message: '' });
      wx.showToast({ title: '已开通，正在载入选题', icon: 'none' });
      if (this._visible) void this._poller?.show();
    } catch (caught) {
      const e = /** @type {FoodError} */ (caught);
      // The typed code stays on screen so a typo can be corrected instead of retyped.
      this.setData({ redeeming: false, message: e.message || '开通未成功，请稍后再试。' });
    }
  },
  onManage() { wx.navigateTo({ url: '/pages/admin/admin' }); },
  /**
   * Brings favourites in line with the account. On the first run after the upgrade the local copy is
   * merged up, so nothing saved on this phone is lost; afterwards the server copy is mirrored down.
   */
  syncFavorites() {
    if (!this._favoriteSync) {
      this._favoriteSync = this.serializeFavorites(() => this.syncFavoritesOnce()).finally(() => {
        this._favoriteSync = null; this._syncingFavoriteIds = [];
      });
    }
    return this._favoriteSync;
  },
  /** Cloud writes and mirror refreshes share one order, so a stale read cannot undo a completed write.
   * @template T @param {()=>Promise<T>} operation @returns {Promise<T>}
   */
  serializeFavorites(operation) {
    const result = (this._favoriteOperation || Promise.resolve()).then(operation);
    // The caller still receives a failure; only the queue tail recovers so later work may proceed.
    this._favoriteOperation = result.then(() => {}, () => {});
    return result;
  },
  async syncFavoritesOnce() {
    const local = this._favorites;
    if (!local) return;
    try {
      const remote = await this._account('favorites.list');
      const pending = local.pendingEntries();
      this._syncingFavoriteIds = Object.keys(pending);
      // Only locally unsent additions are merged. Synced mirrors must follow removals on other devices.
      const held = remote.items || {};
      const unsent = Object.keys(pending).filter(id => !Object.prototype.hasOwnProperty.call(held, id));
      const merged = unsent.length ? await this._account('favorites.merge', { items: pending }) : remote;
      const stored = local.replace(merged.items || {}, pending);
      this._cloudFavorites = !Object.keys(local.pendingEntries()).length;
      this.setData({ favoriteNotice: this._cloudFavorites ? '收藏跟着微信账号' : '部分收藏等待同步', favoriteCount: local.ids().length });
      if (!stored.ok) wx.showToast({ title: stored.message || '本地副本未能保存', icon: 'none' });
    } catch (caught) {
      // The local copy is kept exactly as it is, so neither an upgrade nor an outage costs a favourite.
      const e = /** @type {FoodError} */ (caught);
      this._cloudFavorites = false;
      this.setData({ favoriteNotice: '收藏暂时只保存在本机' });
      wx.showToast({ title: e.code === 'LIMIT_EXCEEDED' ? '收藏太多，整理一些后才能同步' : '收藏暂时只存在这台手机上',
        icon: 'none' });
    }
  },
  /** @param {unknown} caught */
  showError(caught) {
    const e = /** @type {FoodError} */ (caught);
    if (['NOT_REGISTERED', 'SUSPENDED', 'UNAUTHENTICATED', 'FORBIDDEN'].includes(e.code || '')) {
      this.dropAccess(this.accessStateFor(e.code), e.message || '暂时无法读取，请稍后再试。');
      return;
    }
    this.setData({ message: e.message || '暂时无法读取，请稍后再试。', loading: false, loadingMore: false });
  },
  renderNotes() {
    const has = (/** @type {string} */ id) => this._favorites?.has(id) || false;
    // Accounts belong to the round being shown; searches and favourites are note lists, so the board stays empty there.
    const accounts = this.data.mode === 'round' || this.data.mode === 'history' ? this._accounts : [];
    this.setData({ total: this._notes.length, boardViews: boards(this._notes, this.data.sorts, has, accounts),
      favoriteCards: this.data.mode === 'favorites' ? this._notes.map(note => card(note, note.boards?.[0] || 'week', 'likes', has(note.noteId))) : [],
      favoriteCount: this._favorites?.ids().length || 0 });
  },
  async checkUpdates() {
    const statusRequest = ++this._statusRequestId;
    try {
      const status = await this._api('status');
      if (statusRequest !== this._statusRequestId) return;
      const labels = /** @type {Record<string,string>} */ ({ pending: '等待首次更新', running: '新选题整理中', complete: '已更新', partial: '本轮部分更新', failed: '本轮更新未完成', budget_exhausted: '本轮已到调用上限' });
      const tones = /** @type {Record<string,string>} */ ({ complete: 'ok', partial: 'warn', budget_exhausted: 'warn', failed: 'error' });
      this.setData({ statusLabel: labels[status.status] || '等待更新', statusTone: tones[status.status] || '', message: status.partialReason || '' });
      this._newestId = status.snapshotId;
      if (!status.snapshotId) { this.setData({ loading: false }); return; }
      const changed = status.snapshotId !== this._latestId;
      if (shouldFollowLatest({ mode: this.data.mode, snapshotId: this._currentRoundId }, this._latestId)) {
        if (status.snapshotId !== this._currentRoundId) {
          const loaded = await this.loadRound(status.snapshotId, 'round');
          if (!loaded) return;
        }
      } else if (changed) this.setData({ newAvailable: status.snapshotId !== this._currentRoundId });
      if (statusRequest !== this._statusRequestId) return;
      this._latestId = status.snapshotId;
      if (changed || !this.data.rounds.length) await this.loadRounds();
    } catch (e) { if (statusRequest === this._statusRequestId) this.showError(e); }
  },
  /** @param {string} snapshotId @param {string} [mode] @param {boolean} [append] */
  async loadRound(snapshotId, mode = 'round', append = false) {
    const request = ++this._requestId;
    this.setData(append ? { loadingMore: true } : { loading: true, message: '', mode });
    try {
      const result = /** @type {RoundData} */ (await this._api('getRound', { snapshotId, limit: 50, cursor: append ? this.data.nextCursor : null }));
      if (request !== this._requestId) return false;
      this._notes = append ? [...this._notes, ...result.notes] : result.notes;
      if (!append) this._accounts = Array.isArray(result.accounts) ? result.accounts : [];
      this._currentRoundId = snapshotId;
      this.setData({ mode, loading: false, loadingMore: false, partialReason: result.partialReason || '',
        roundLabel: `${formatTime(result.scheduledAt, true)} 选题`, updatedLabel: `整理于 ${formatTime(result.finishedAt, true)}`,
        coverageNotice: result.coverage?.notice || this.data.coverageNotice, nextCursor: result.nextCursor,
        newAvailable: mode === 'round' ? false : this._newestId !== snapshotId,
        roundIndex: Math.max(0, this.data.rounds.findIndex(x => x.snapshotId === snapshotId)), missingFavorites: [] });
      this.renderNotes(); return true;
    } catch (e) { if (request === this._requestId) this.showError(e); return false; }
  },
  /** @param {boolean} [append] */
  async loadRounds(append = false) {
    try {
      const result = await this._api('listRounds', { limit: 20, cursor: append ? this._roundCursor : null });
      const incoming = /** @type {RoundItem[]} */ (result.rounds);
      const all = append ? [...this.data.rounds, ...incoming] : incoming;
      const unique = [...new Map(all.map(x => [x.snapshotId, x])).values()].map(x => ({ ...x, label: `${formatTime(x.scheduledAt, true)} · ${x.count} 篇` }));
      this._roundCursor = result.nextCursor;
      this.setData({ rounds: unique, olderRounds: !!result.nextCursor,
        roundIndex: Math.max(0, unique.findIndex(x => x.snapshotId === this._currentRoundId)) });
      return true;
    } catch (e) { this.showError(e); return false; }
  },
  async onOlderRounds() { if (await this.loadRounds(true)) wx.showToast({ title: '更早轮次已加入选择列表', icon: 'none' }); },
  /** @param {{detail:{value:string}}} event */
  onRoundChange(event) {
    const index = Number(event.detail.value); const selected = this.data.rounds[index];
    if (!selected) return;
    this.setData({ query: '' });
    void this.loadRound(selected.snapshotId, selected.snapshotId === this._newestId ? 'round' : 'history');
  },
  onLatest() {
    this.setData({ query: '', mode: 'round', newAvailable: false });
    if (this._newestId) void this.loadRound(this._newestId, 'round'); else void this.checkUpdates();
  },
  /** @param {{detail:{value:string}}} event */
  onQueryInput(event) { this.setData({ query: event.detail.value }); },
  async onSearch() { await this.search(); },
  /** @param {boolean} [append] */
  async search(append = false) {
    const query = this.data.query.trim();
    if (!query) { this.onClearSearch(); return; }
    if (this.data.mode !== 'search') this._returnMode = this.data.mode;
    const request = ++this._requestId;
    this.setData({ mode: 'search', loading: !append, loadingMore: append, message: '' });
    try {
      const result = await this._api('search', { query, limit: 50, cursor: append ? this.data.nextCursor : null });
      if (request !== this._requestId) return;
      const notes = /** @type {FoodNote[]} */ (result.notes);
      this._notes = [...new Map([...(append ? this._notes : []), ...notes].map(x => [x.noteId, x])).values()];
      this.setData({ loading: false, loadingMore: false, roundLabel: `“${query}”的搜索结果`, partialReason: '', updatedLabel: '搜索已保存的全部轮次', nextCursor: result.nextCursor, missingFavorites: [] });
      this.renderNotes();
    } catch (e) { if (request === this._requestId) this.showError(e); }
  },
  onClearSearch() {
    if (this.data.mode !== 'search') { this.setData({ query: '' }); return; }
    this.setData({ query: '', mode: this._returnMode });
    if (this._returnMode === 'favorites') void this.loadFavorites();
    else if (this._currentRoundId) void this.loadRound(this._currentRoundId, this._returnMode);
    else this.onLatest();
  },
  /** @param {{currentTarget:{dataset:Record<string,string>}}} event */
  onSort(event) {
    const { board, sort } = event.currentTarget.dataset;
    if (!['today', 'week', 'saves'].includes(board) || !['ratio', 'fanRatio', 'collectRatio', 'likes', 'collected', 'comments'].includes(sort)) return;
    this.setData({ sorts: { ...this.data.sorts, [board]: sort } }); this.renderNotes();
  },
  async onFavorites() { await this.loadFavorites(); },
  /** @param {boolean} [append] */
  async loadFavorites(append = false) {
    // Opening the list is when another device's favourite matters, and also the chance to reconnect
    // after an outage — so try regardless of which mode the page is currently in.
    if (!append && this.data.access === 'ready') await this.syncFavorites();
    const request = ++this._requestId;
    const ids = this._favorites?.ids() || [];
    if (!append) { this._favoriteOffset = 0; this._notes = []; }
    this.setData({ mode: 'favorites', query: '', loading: !append, loadingMore: append, message: '',
      roundLabel: '我的选题收藏', updatedLabel: this._cloudFavorites ? '跟着微信账号，换手机也在' : '暂时只存在这台手机上',
      partialReason: '', missingFavorites: append ? this.data.missingFavorites : [] });
    try {
      const batch = ids.slice(this._favoriteOffset, this._favoriteOffset + 50);
      const result = batch.length ? await this._api('getNotes', { noteIds: batch }) : { notes: [], missing: [] };
      if (request !== this._requestId) return;
      this._favoriteOffset += batch.length;
      this._notes.push(...result.notes);
      this.setData({ loading: false, loadingMore: false, nextCursor: this._favoriteOffset < ids.length ? 'favorites-more' : null,
        missingFavorites: [...this.data.missingFavorites, ...result.missing] });
      this.renderNotes();
    } catch (e) { if (request === this._requestId) this.showError(e); }
  },
  async onMore() {
    if (this.data.loadingMore) return;
    if (this.data.mode === 'search') await this.search(true);
    else if (this.data.mode === 'favorites') await this.loadFavorites(true);
    else if (this._currentRoundId) await this.loadRound(this._currentRoundId, this.data.mode, true);
  },
  /** @param {{currentTarget:{dataset:Record<string,string>}}} event */
  async onFavorite(event) {
    const id = event.currentTarget.dataset.id;
    if ((this._favoriteSync && this._cloudFavorites) || this._syncingFavoriteIds.includes(id)) {
      wx.showToast({ title: '正在同步收藏，请完成后重试', icon: 'none' });
      return;
    }
    let selected;
    if (this._cloudFavorites) {
      // The account copy decides. Nothing on screen changes until the server confirms the write.
      try {
        selected = await this.serializeFavorites(async () => {
          const state = (await this._account('favorites.toggle', { noteId: id })).selected;
          const next = this._favorites?.entries() || {};
          if (state) next[id] = Date.now(); else delete next[id];
          this._favorites?.replace(next);
          return state;
        });
      } catch (caught) {
        const e = /** @type {FoodError} */ (caught);
        // An access-level refusal must close the content down, exactly as it does on a read.
        if (['NOT_REGISTERED', 'SUSPENDED', 'UNAUTHENTICATED', 'FORBIDDEN'].includes(e.code || '')) { this.showError(e); return; }
        wx.showToast({ title: e.message || '收藏未能保存', icon: 'none' });
        return;
      }
    } else {
      const result = this._favorites?.toggle(id);
      if (!result?.ok) { wx.showToast({ title: result?.message || '收藏未能保存', icon: 'none' }); return; }
      selected = result.selected;
    }
    if (this.data.mode === 'favorites' && !selected) {
      this._notes = this._notes.filter(x => x.noteId !== id);
      this._favoriteOffset = Math.max(0, this._favoriteOffset - 1);
      this.setData({ missingFavorites: this.data.missingFavorites.filter(x => x !== id) });
    }
    this.renderNotes();
    wx.showToast({ title: selected ? '已收藏' : '已取消收藏', icon: 'none' });
  },
  /** @param {{currentTarget:{dataset:Record<string,string>}}} event */
  onViewContent(event) {
    if (this._contentOpening) return;
    const note = this._notes.find(x => x.noteId === event.currentTarget.dataset.id);
    if (!note || !/^[a-f0-9]{24}$/.test(note.noteId)) {
      wx.showToast({ title: '这条选题已更新，请刷新后重试。', icon: 'none' }); return;
    }
    this._contentOpening = true;
    try {
      wx.navigateTo({ url: `/pages/detail/detail?noteId=${note.noteId}`,
        fail: () => wx.showToast({ title: '内容页暂未打开，请重试。', icon: 'none' }),
        complete: () => { this._contentOpening = false; } });
    } catch { this._contentOpening = false; wx.showToast({ title: '内容页暂未打开，请重试。', icon: 'none' }); }
  },
  /** @param {{currentTarget:{dataset:Record<string,string>}}} event */
  onImageError(event) {
    this._notes = this._notes.map(x => x.noteId === event.currentTarget.dataset.id
      ? { ...x, thumbUrl: x.thumbFallbackUrl !== x.thumbUrl ? x.thumbFallbackUrl || null : null } : x); this.renderNotes();
  }
});
