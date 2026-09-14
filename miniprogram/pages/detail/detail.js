'use strict';
const { createApi } = require('../../lib/api');
const { formatTime, formatMetric } = require('../../lib/view');
const { canOpenOriginal, openOriginal } = require('../../lib/source');
Page({
  data: {
    loading: true, message: '', note: /** @type {FoodNote|null} */ (null),
    content: /** @type {NoteContent|null} */ (null),
    images: /** @type {{url:string,failed:boolean}[]} */ ([]),
    title: '', publishedLabel: '', capturedLabel: '', likesLabel: '', collectedLabel: '', commentsLabel: '',
    canOpenOriginal: false, openingOriginal: false, videoFailed: false, videoHeight: 440
  },
  _api: createApi(options => wx.cloud.callFunction(options)),
  _noteId: '', _requestId: 0, _loadedOnce: false,
  /** @param {{noteId?:string}} options */
  onLoad(options) {
    if (!/^[a-f0-9]{24}$/.test(options.noteId || '')) {
      this.setData({ loading: false, message: '这条选题的地址无效，请返回列表重新打开。' }); return;
    }
    this._noteId = options.noteId || '';
    void this.loadContent();
  },
  onShow() { if (this._loadedOnce) void this.loadContent(); },
  onHide() { wx.createVideoContext('note-video', this).pause(); },
  onUnload() { this._requestId++; },
  async onPullDownRefresh() { try { await this.loadContent(); } finally { wx.stopPullDownRefresh(); } },
  async loadContent() {
    if (!this._noteId) return;
    const requestId = ++this._requestId;
    this.setData({ loading: true, message: '' });
    try {
      const result = await this._api('getContent', { noteId: this._noteId });
      if (requestId !== this._requestId) return;
      if (result.note?.noteId !== this._noteId || !result.content || !Array.isArray(result.content.images)) throw Error('内容暂时无法读取，请稍后重试。');
      const note = /** @type {FoodNote} */ (result.note);
      const content = /** @type {NoteContent} */ (result.content);
      this.setData({ note, content, title: note.title || '这篇笔记未提供标题',
        images: content.images.map(url => ({ url, failed: false })), videoFailed: false, videoHeight: 440,
        publishedLabel: formatTime(note.publishedAt), capturedLabel: formatTime(content.capturedAt, true),
        likesLabel: formatMetric(note.likes), collectedLabel: formatMetric(note.collected), commentsLabel: formatMetric(note.comments),
        canOpenOriginal: canOpenOriginal(note) });
    } catch (error) {
      if (requestId !== this._requestId) return;
      const code = /** @type {FoodError} */ (error)?.code || '';
      const messages = /** @type {Record<string,string>} */ ({ NETWORK_ERROR: '连接失败，请重试。',
        INVALID_RESPONSE: '服务暂时不可用，请重试。', NOT_FOUND: '这条选题的内容暂不可用，请返回列表。' });
      this.setData({ note: null, content: null, images: [], canOpenOriginal: false,
        message: messages[code] || (error instanceof Error ? error.message : '内容暂时无法读取，请稍后重试。') });
    } finally {
      if (requestId === this._requestId) { this._loadedOnce = true; this.setData({ loading: false }); }
    }
  },
  onRetry() { void this.loadContent(); },
  /** @param {{detail:{width:number,height:number}}} event */
  onVideoMetadata(event) {
    const { width, height } = event.detail;
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      this.setData({ videoHeight: Math.round(Math.min(1000, Math.max(360, 686 * height / width))) });
    }
  },
  onVideoError() { this.setData({ videoFailed: true }); },
  /** @param {{currentTarget:{dataset:{index:string}}}} event */
  onImageError(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ images: this.data.images.map((image, i) => i === index ? { ...image, failed: true } : image) });
  },
  /** @param {{currentTarget:{dataset:{index:string}}}} event */
  onPreviewImage(event) {
    const current = this.data.images[Number(event.currentTarget.dataset.index)];
    if (!current || current.failed) return;
    wx.previewImage({ current: current.url, urls: this.data.images.filter(image => !image.failed).map(image => image.url) });
  },
  onPosterError() {
    const note = this.data.note;
    if (!note) return;
    this.setData({ note: { ...note, thumbUrl: note.thumbFallbackUrl !== note.thumbUrl ? note.thumbFallbackUrl || null : null } });
  },
  async onOpenOriginal() {
    if (this.data.openingOriginal || !this.data.note || !canOpenOriginal(this.data.note)) return;
    this.setData({ openingOriginal: true });
    try { await openOriginal(this.data.note, options => wx.navigateToMiniProgram(options)); }
    catch { wx.showToast({ title: '小红书暂未打开，可继续查看本页内容。', icon: 'none' }); }
    finally { this.setData({ openingOriginal: false }); }
  },
  onBack() { wx.navigateBack({ delta: 1, fail: () => wx.reLaunch({ url: '/pages/index/index' }) }); }
});
