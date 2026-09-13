'use strict';
const { createApi } = require('../../lib/api');
const { checkInviteForm, userRow, inviteRow, displayCode } = require('../../lib/admin');

Page({
  data: {
    ready: false, message: '', tab: 'users',
    loadingUsers: false, loadingInvites: false, busy: '',
    users: /** @type {ReturnType<typeof userRow>[]} */ ([]), usersCursor: /** @type {string|null} */ (null),
    invites: /** @type {ReturnType<typeof inviteRow>[]} */ ([]), invitesCursor: /** @type {string|null} */ (null),
    form: { maxUses: '1', expiresInDays: '30', note: '' },
    created: /** @type {{display:string,code:string,expiryLabel:string}|null} */ (null)
  },
  _account: createApi(options => wx.cloud.callFunction(options), 'account'),
  async onLoad() {
    // The server decides whether this page may show anything; arriving here grants nothing.
    try {
      const me = await this._account('me');
      if (me.role !== 'admin') { this.setData({ ready: false, message: '这个页面只对管理员开放。' }); return; }
      this.setData({ ready: true, message: '' });
      await Promise.all([this.loadUsers(), this.loadInvites()]);
    } catch (caught) {
      this.setData({ ready: false, message: /** @type {FoodError} */ (caught).message || '暂时无法打开管理页。' });
    }
  },
  /** @param {{currentTarget:{dataset:Record<string,string>}}} event */
  onTab(event) {
    const tab = event.currentTarget.dataset.tab;
    if (tab === 'users' || tab === 'invites') this.setData({ tab, message: '' });
  },
  /** @param {boolean} [append] */
  async loadUsers(append = false) {
    if (this.data.loadingUsers) return;
    this.setData({ loadingUsers: true });
    try {
      const result = await this._account('admin.listUsers',
        { limit: 20, ...(append && this.data.usersCursor ? { cursor: this.data.usersCursor } : {}) });
      const rows = result.users.map(userRow);
      this.setData({ users: append ? [...this.data.users, ...rows] : rows,
        usersCursor: result.nextCursor, loadingUsers: false });
    } catch (caught) {
      this.setData({ loadingUsers: false, message: /** @type {FoodError} */ (caught).message || '用户列表读取失败。' });
    }
  },
  /** @param {boolean} [append] */
  async loadInvites(append = false) {
    if (this.data.loadingInvites) return;
    this.setData({ loadingInvites: true });
    try {
      const result = await this._account('admin.listInvites',
        { limit: 20, ...(append && this.data.invitesCursor ? { cursor: this.data.invitesCursor } : {}) });
      const rows = result.invites.map((/** @type {any} */ invite) => inviteRow(invite));
      this.setData({ invites: append ? [...this.data.invites, ...rows] : rows,
        invitesCursor: result.nextCursor, loadingInvites: false });
    } catch (caught) {
      this.setData({ loadingInvites: false, message: /** @type {FoodError} */ (caught).message || '邀请码列表读取失败。' });
    }
  },
  async onMoreUsers() { if (this.data.usersCursor) await this.loadUsers(true); },
  async onMoreInvites() { if (this.data.invitesCursor) await this.loadInvites(true); },
  /** @param {{currentTarget:{dataset:Record<string,string>}}} event */
  async onToggleStatus(event) {
    const { id, suspended } = event.currentTarget.dataset;
    await this.run(`status:${id}`, 'admin.setUserStatus',
      { openId: id, status: suspended === 'true' ? 'active' : 'suspended' }, () => this.loadUsers());
  },
  /** @param {{currentTarget:{dataset:Record<string,string>}}} event */
  async onToggleRole(event) {
    const { id, admin } = event.currentTarget.dataset;
    await this.run(`role:${id}`, 'admin.setUserRole',
      { openId: id, role: admin === 'true' ? 'member' : 'admin' }, () => this.loadUsers());
  },
  /** @param {{currentTarget:{dataset:Record<string,string>}}} event */
  async onRevoke(event) {
    const code = event.currentTarget.dataset.code;
    await this.run(`revoke:${code}`, 'admin.revokeInvite', { code }, () => this.loadInvites());
  },
  /** @param {string} field @param {string} value */
  setField(field, value) { this.setData({ form: { ...this.data.form, [field]: value } }); },
  /** @param {{detail:{value:string}}} event */
  onUsesInput(event) { this.setField('maxUses', event.detail.value); },
  /** @param {{detail:{value:string}}} event */
  onDaysInput(event) { this.setField('expiresInDays', event.detail.value); },
  /** @param {{detail:{value:string}}} event */
  onNoteInput(event) { this.setField('note', event.detail.value); },
  async onCreateInvite() {
    const checked = checkInviteForm(this.data.form);
    if (!checked.ok || !checked.value) { this.setData({ message: checked.message || '表单内容不正确。' }); return; }
    await this.run('create', 'admin.createInvite', checked.value, result => {
      this.setData({ created: { code: result.code, display: displayCode(result.code),
        expiryLabel: inviteRow({ ...result, usedCount: 0, active: true, createdAt: result.expiresAt, note: null }).expiryLabel } });
      return this.loadInvites();
    });
  },
  onCopyCode() {
    const created = this.data.created;
    if (!created) return;
    wx.setClipboardData({ data: created.display,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请手动记录', icon: 'none' }) });
  },
  /**
   * Runs one management call with a single in-flight guard, so a double tap cannot act twice.
   * @param {string} token @param {string} action @param {Record<string,unknown>} params
   * @param {(result:any) => unknown} [after]
   */
  async run(token, action, params, after) {
    if (this.data.busy) return;
    this.setData({ busy: token, message: '' });
    try {
      const result = await this._account(action, params);
      this.setData({ busy: '' });
      if (after) await after(result);
    } catch (caught) {
      // A refusal is reported as given; the page never claims an action succeeded.
      this.setData({ busy: '', message: /** @type {FoodError} */ (caught).message || '这个操作没有完成。' });
    }
  }
});
