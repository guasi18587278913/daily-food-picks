'use strict';
const { createApi, createPoller, shouldFollowLatest, copySource } = require('../../lib/api');
const { createFavorites } = require('../../lib/favorites');
const { boards, card, formatTime } = require('../../lib/view');
const STORAGE_KEY = 'food-picks:favorites:v1';

Page({
  data: {
    mode: 'round', query: '', loading: true, loadingMore: false, locked: false, message: '',
    statusLabel: '正在查看更新', statusTone: '', roundLabel: '每日三次，给创作找点新意', updatedLabel: '',
    partialReason: '', coverageNotice: '基于当轮关键词发现选题，未覆盖小红书全部内容。',
    newAvailable: false, total: 0, favoriteCount: 0, nextCursor: /** @type {string|null} */ (null),
    rounds: /** @type {RoundItem[]} */ ([]), roundIndex: 0, olderRounds: false,
    sorts: /** @type {Record<string,string>} */ ({}), boardViews: boards([], {}, () => false),
    favoriteCards: /** @type {ReturnType<typeof card>[]} */ ([]), missingFavorites: /** @type {string[]} */ ([])
  },
  _api: createApi(options => wx.cloud.callFunction(options)),
  _favorites: /** @type {ReturnType<typeof createFavorites>|null} */ (null),
  _poller: /** @type {ReturnType<typeof createPoller>|null} */ (null),
  _notes: /** @type {FoodNote[]} */ ([]),
  _currentRoundId: /** @type {string|null} */ (null),
  _latestId: /** @type {string|null} */ (null),
  _newestId: /** @type {string|null} */ (null),
  _roundCursor: /** @type {string|null} */ (null),
  _requestId: 0,
  _statusRequestId: 0,
  _favoriteOffset: 0,
  _returnMode: 'round',
  onLoad() {
    this._favorites = createFavorites({ get: () => wx.getStorageSync(STORAGE_KEY), set: value => wx.setStorageSync(STORAGE_KEY, value) });
    this.setData({ favoriteCount: this._favorites.ids().length });
    if (this._favorites.corrupt) wx.showToast({ title: '部分收藏记录无法读取', icon: 'none' });
    this._poller = createPoller(() => this.checkUpdates());
  },
  onShow() { void this._poller?.show(); },
  onHide() { this._poller?.hide(); },
  onUnload() { this._poller?.hide(); this._requestId++; this._statusRequestId++; },
  async onPullDownRefresh() {
    try {
      await this.checkUpdates();
      if (this.data.mode === 'search') await this.search();
      else if (this.data.mode === 'favorites') await this.loadFavorites();
      else if (this._currentRoundId) await this.loadRound(this._currentRoundId, this.data.mode);
    } finally { wx.stopPullDownRefresh(); }
  },
  /** @param {unknown} caught */
  showError(caught) {
    const e = /** @type {FoodError} */ (caught);
    if (e.code === 'FORBIDDEN' || e.code === 'UNAUTHENTICATED') {
      this._requestId++; this._statusRequestId++;
      this._notes = []; this.setData({ locked: true, boardViews: [], favoriteCards: [], total: 0 });
    }
    this.setData({ message: e.message || '暂时无法读取，请稍后再试。', loading: false, loadingMore: false });
  },
  renderNotes() {
    const has = (/** @type {string} */ id) => this._favorites?.has(id) || false;
    this.setData({ total: this._notes.length, boardViews: boards(this._notes, this.data.sorts, has),
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
      this.setData({ locked: false, statusLabel: labels[status.status] || '等待更新', statusTone: tones[status.status] || '', message: status.partialReason || '' });
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
      this._currentRoundId = snapshotId;
      this.setData({ mode, loading: false, loadingMore: false, locked: false, partialReason: result.partialReason || '',
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
    if (!['today', 'week', 'dark'].includes(board) || !['ratio', 'fanRatio', 'likes', 'collected', 'comments'].includes(sort)) return;
    this.setData({ sorts: { ...this.data.sorts, [board]: sort } }); this.renderNotes();
  },
  async onFavorites() { await this.loadFavorites(); },
  /** @param {boolean} [append] */
  async loadFavorites(append = false) {
    const request = ++this._requestId;
    const ids = this._favorites?.ids() || [];
    if (!append) { this._favoriteOffset = 0; this._notes = []; }
    this.setData({ mode: 'favorites', query: '', loading: !append, loadingMore: append, message: '',
      roundLabel: '我的选题收藏', updatedLabel: '保存在这台手机上', partialReason: '', missingFavorites: append ? this.data.missingFavorites : [] });
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
  onFavorite(event) {
    const id = event.currentTarget.dataset.id; const result = this._favorites?.toggle(id);
    if (!result?.ok) { wx.showToast({ title: result?.message || '收藏未能保存', icon: 'none' }); return; }
    if (this.data.mode === 'favorites' && !result.selected) {
      this._notes = this._notes.filter(x => x.noteId !== id);
      this._favoriteOffset = Math.max(0, this._favoriteOffset - 1);
      this.setData({ missingFavorites: this.data.missingFavorites.filter(x => x !== id) });
    }
    this.renderNotes();
    wx.showToast({ title: result.selected ? '已收藏' : '已取消收藏', icon: 'none' });
  },
  /** @param {{currentTarget:{dataset:Record<string,string>}}} event */
  async onCopy(event) {
    const note = this._notes.find(x => x.noteId === event.currentTarget.dataset.id);
    try {
      await copySource(note?.sourceUrl || null, options => wx.setClipboardData(options));
      wx.showModal({ title: '原文链接已复制', content: '可以粘贴到浏览器查看原文。小红书可能要求登录，内容也可能已被作者删除。', showCancel: false, confirmText: '知道了', confirmColor: '#B8441A' });
    } catch (e) { wx.showToast({ title: /** @type {Error} */ (e).message, icon: 'none' }); }
  },
  /** @param {{currentTarget:{dataset:Record<string,string>}}} event */
  onImageError(event) {
    this._notes = this._notes.map(x => x.noteId === event.currentTarget.dataset.id ? { ...x, thumbUrl: null } : x); this.renderNotes();
  }
});
