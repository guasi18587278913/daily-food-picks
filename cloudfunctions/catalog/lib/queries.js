'use strict';
const { createHash } = require('node:crypto');
const { authorize } = require('./access');
const NOTE_ID = /^[0-9a-f]{24}$/;
const SNAPSHOT_ID = /^\d{8}-\d{4}-[0-9a-f]{12}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function limitOf(value, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail('INVALID_ARGUMENT');
  return value;
}
function encode(query, position) { return Buffer.from(JSON.stringify({ q: hash(query), p: position })).toString('base64url'); }
function decode(cursor, query, numeric = false) {
  if (cursor === undefined || cursor === null || cursor === '') return numeric ? 0 : '';
  try {
    if (typeof cursor !== 'string' || cursor.length > 500 || !/^[a-zA-Z0-9_-]+$/.test(cursor)) fail('INVALID_CURSOR');
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value.q !== hash(query)) fail('INVALID_CURSOR');
    if (numeric ? (!Number.isSafeInteger(value.p) || value.p < 0 || value.p > 10000)
      : (typeof value.p !== 'string' || !/^[0-9a-f_-]{1,100}$/.test(value.p))) fail('INVALID_CURSOR');
    return value.p;
  } catch { fail('INVALID_CURSOR'); }
}
const ERRORS = {
  UNAUTHENTICATED: '请从微信重新进入。', NOT_REGISTERED: '这个微信还没有开通，输入邀请码即可使用。',
  SUSPENDED: '这个账号已停用，请联系管理员。', FORBIDDEN: '当前账号无法读取这些内容。',
  INVALID_ARGUMENT: '请求内容不正确，请重试。', INVALID_CURSOR: '列表已变化，请重新查询。',
  NOT_FOUND: '这轮内容暂不可用。', BACKEND_UNAVAILABLE: '服务暂时不可用，稍后再试。'
};
function createCatalog({ store, config, sign = async () => [] }) {
  // `seen` is created per invocation and released with it, so a publish during the next call is never masked.
  async function published(id, seen) {
    if (!id) return false;
    if (!seen.has(id)) seen.set(id, (await store.get('dfp_snapshots', id))?.published === true);
    return seen.get(id);
  }
  async function decorate(notes) {
    const fileIds = [...new Set(notes.map(n => n.fileId).filter(x => typeof x === 'string' && x.startsWith('cloud://')))];
    let urls = [];
    try { if (fileIds.length) urls = await sign(fileIds); } catch {}
    const map = new Map(urls.filter(x => fileIds.includes(x.fileID) && /^https:\/\//.test(x.tempFileURL || '') && (!x.status || x.status === 0))
      .map(x => [x.fileID, x.tempFileURL]));
    return notes.map(note => { const { fileId, ...rest } = note; return { ...rest, thumbUrl: map.get(fileId) || null }; });
  }
  async function latestNote(noteId, seen) {
    const ref = await store.get('dfp_candidates', `published_${noteId}`);
    if (!ref || !await published(ref.snapshotId, seen)) return null;
    const row = await store.get('dfp_notes', ref.indexId);
    return row?.snapshotId === ref.snapshotId && row.note?.noteId === noteId ? row.note : null;
  }
  return async (event, wxContext) => {
    const seen = new Map();
    try {
      // The user record is the only source of authorization; a static name list no longer grants anything.
      // No `mayProvision`: a query must never create or change a permission record as a side effect.
      await authorize(wxContext, config, store);
      if (!event || typeof event !== 'object') fail('INVALID_ARGUMENT');
      let data;
      if (event.action === 'status') {
        const latest = await store.get('dfp_state', 'latest');
        const state = await store.get('dfp_state', 'status');
        const available = !!latest && await published(latest.snapshotId, seen);
        data = { status: state?.status || 'pending', roundId: state?.roundId || null,
          scheduledAt: state?.scheduledAt || null, finishedAt: state?.finishedAt || null, partialReason: state?.partialReason || null,
          revision: available ? latest.revision : null,
          snapshotId: available ? latest.snapshotId : null };
      } else if (event.action === 'listRounds') {
        const limit = limitOf(event.limit, 20, 10); const query = ['rounds'];
        const after = decode(event.cursor, query);
        const rows = await store.list('dfp_snapshots', { descending: true, after, limit: limit + 1, filters: { published: true } });
        data = { rounds: rows.slice(0, limit).map(x => ({ snapshotId: x.id, scheduledAt: x.scheduledAt,
          finishedAt: x.finishedAt, status: x.status, count: x.count })),
          nextCursor: rows.length > limit ? encode(query, rows[limit - 1]._id) : null };
      } else if (event.action === 'getRound') {
        if (typeof event.snapshotId !== 'string' || !SNAPSHOT_ID.test(event.snapshotId)) fail('INVALID_ARGUMENT');
        const snapshot = await store.get('dfp_snapshots', event.snapshotId);
        if (!snapshot?.published) fail('NOT_FOUND');
        const query = ['round', event.snapshotId]; const offset = decode(event.cursor, query, true);
        const limit = limitOf(event.limit, 50, 50); const notes = [];
        for (const ref of snapshot.parts) {
          const part = await store.get('dfp_parts', ref.id);
          if (!part || !Array.isArray(part.notes) || hash(part.notes) !== ref.hash) fail('BACKEND_UNAVAILABLE');
          notes.push(...part.notes);
        }
        if (notes.length !== snapshot.count || offset > notes.length) fail('BACKEND_UNAVAILABLE');
        data = { snapshotId: snapshot.id, scheduledAt: snapshot.scheduledAt, finishedAt: snapshot.finishedAt,
          status: snapshot.status, partialReason: snapshot.partialReason, coverage: snapshot.coverage,
          count: snapshot.count, boards: snapshot.boards, notes: await decorate(notes.slice(offset, offset + limit)),
          nextCursor: offset + limit < notes.length ? encode(query, offset + limit) : null };
      } else if (event.action === 'getNotes') {
        if (!Array.isArray(event.noteIds) || event.noteIds.length > 50 || event.noteIds.some(x => typeof x !== 'string' || !NOTE_ID.test(x))) fail('INVALID_ARGUMENT');
        const notes = []; const missing = [];
        for (const noteId of new Set(event.noteIds)) {
          const note = await latestNote(noteId, seen);
          if (note) notes.push(note); else missing.push(noteId);
        }
        data = { notes: await decorate(notes), missing };
      } else if (event.action === 'search') {
        if (typeof event.query !== 'string' || !event.query.trim() || event.query.length > 100) fail('INVALID_ARGUMENT');
        const terms = [...new Set(event.query.trim().toLowerCase().split(/\s+/))];
        const query = ['search', terms]; let after = decode(event.cursor, query);
        const limit = limitOf(event.limit, 50, 30); const notes = []; let more = false; let lastAccepted = after;
        // Bound each read. Sparse matches can return an empty page with a continuation cursor.
        for (let pass = 0; pass < 8; pass++) {
          const rows = await store.list('dfp_notes', { descending: true, after, limit: 50, searchTerms: terms });
          for (const row of rows) {
            after = row._id;
            if (!row.note || !await published(row.snapshotId, seen)) continue;
            const current = await store.get('dfp_candidates', `published_${row.note.noteId}`);
            if (current?.indexId !== row._id || !terms.every(t => (row.searchText || '').includes(t))) continue;
            if (notes.length === limit) { more = true; break; }
            notes.push(row.note); lastAccepted = row._id;
          }
          if (more || rows.length < 50) break;
          if (pass === 7) { more = true; lastAccepted = after; }
        }
        data = { notes: await decorate(notes), nextCursor: more ? encode(query, lastAccepted) : null };
      } else fail('INVALID_ARGUMENT');
      return { ok: true, data };
    } catch (e) {
      const known = Object.hasOwn(ERRORS, e.code);
      // Unexpected failures are logged so a platform fault is distinguishable from a refusal.
      if (!known) console.error(`catalog action ${event && event.action} failed: code=${e && e.code} message=${e && e.message}`);
      const code = known ? e.code : 'BACKEND_UNAVAILABLE';
      return { ok: false, error: { code, message: ERRORS[code] } };
    }
  };
}
module.exports = { createCatalog, encode, decode };
