'use strict';

const { createHash } = require('node:crypto');
const { PRICE_URL, PRICE_MICRO_USD, reserveAttempt, markInflight, finishAttempt } = require('./budget');
const { error } = require('./config');
const BASE = 'https://api.tikhub.io/api/v1/xiaohongshu/app_v2/';
const ENDPOINTS = Object.freeze({ search: 'search_notes', author: 'get_user_posted_notes',
  user: 'get_user_info', note_video: 'get_video_note_detail', note_image: 'get_image_note_detail' });
const ID = /^[0-9a-f]{24}$/;
const metric = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function sourceLink(value, noteId) {
  if (!ID.test(noteId || '')) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname)
      && !url.username && !url.password && url.pathname.endsWith(`/${noteId}`) && url.href.length <= 2000) return url.href;
  } catch {}
  return `https://www.xiaohongshu.com/explore/${noteId}`;
}
function imageUrl(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && /(^|\.)(xhscdn\.com|xiaohongshu\.com)$/.test(url.hostname) && url.href.length <= 3000) {
      url.protocol = 'https:'; return url.href;
    }
  } catch {}
  return null;
}
function publishedTime(raw) {
  const n = raw.timestamp ?? raw.create_time ?? raw.time;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e11 ? n : n * 1000;
  if (!Number.isSafeInteger(ms) || ms > 8640000000000000) return null;
  return new Date(ms).toISOString();
}
function normalizeNote(raw, { source = 'search', fetchedAt = Date.now(), authorId = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const noteId = raw.id ?? raw.note_id;
  const user = raw.user || {};
  const uid = user.userid ?? user.user_id ?? user.id ?? authorId;
  if (!ID.test(noteId || '') || !ID.test(uid || '') || !['video', 'normal'].includes(raw.type)) return null;
  const title = text(raw.title || raw.display_title, 2000);
  const desc = text(raw.desc, 12000);
  const pinned = raw.sticky ?? raw.is_top;
  const sticky = typeof pinned === 'boolean' ? pinned : ([0, 1].includes(pinned) ? pinned === 1 : null);
  const cover = raw.images_list?.[0] || raw.cover || {};
  const image = imageUrl(cover.url_default || cover.url || cover.url_size_large || cover.info_list?.[0]?.url);
  let link = raw.share_info?.link || raw.share_info?.share_link || raw.share_link;
  if (!link && typeof raw.xsec_token === 'string' && raw.xsec_token.length < 1000) {
    link = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${encodeURIComponent(raw.xsec_token)}&xsec_source=pc_search`;
  }
  return { noteId, authorId: uid, title, desc, type: raw.type, author: text(user.nickname || user.name, 120),
    publishedAt: publishedTime(raw), likes: metric(raw.liked_count ?? raw.likes),
    collected: metric(raw.collected_count), comments: metric(raw.comments_count), shared: metric(raw.shared_count ?? raw.share_count),
    fans: metric(user.fans), sticky, sourceUrl: sourceLink(link, noteId), coverUrl: image,
    bodyComplete: source === 'detail' && typeof raw.desc === 'string' && desc.trim().length > 0
      && raw.desc.length <= 12000 && (raw.title || '').length <= 2000 && raw.desc_truncated !== true
      && raw.has_more_desc !== true && !/[.。…]{3,}\s*$/.test(desc),
    source, fetchedAt: new Date(fetchedAt).toISOString() };
}
function parseResponse(kind, payload, now, params = {}) {
  if (!payload || payload.code !== 200 || !payload.data || payload.data.success === false
    || ![undefined, 0, 200].includes(payload.data.code)) throw error('PROVIDER_REJECTED');
  const wrapper = payload.data;
  const inner = wrapper.data;
  if (!inner || typeof inner !== 'object') throw error('PROVIDER_SCHEMA');
  if (kind === 'user') return { fans: metric(inner.fans), fetchedAt: now };
  let rows;
  if (kind === 'search') rows = Array.isArray(inner.items) ? inner.items.filter(x => x?.note).map(x => x.note) : null;
  else if (kind === 'author') rows = inner.notes ?? inner.items ?? inner.list;
  else rows = Array.isArray(inner) ? inner : inner.notes ?? inner.items ?? [inner.note ?? inner.note_info ?? inner];
  if (!Array.isArray(rows)) throw error('PROVIDER_SCHEMA');
  if (kind === 'note_image' || kind === 'note_video') rows = rows.flatMap(row => Array.isArray(row?.note_list) ? row.note_list : [row]);
  const notes = rows.map(row => normalizeNote(row?.note_info || row?.note || row,
    { source: kind === 'search' ? 'search' : kind === 'author' ? 'author' : 'detail', fetchedAt: now, authorId: params.user_id })).filter(Boolean);
  // Empty responses are valid; a nonempty page that cannot be decoded is a schema failure.
  if (rows.length && !notes.length) throw error('PROVIDER_SCHEMA');
  return { notes, searchId: text(wrapper.search_id, 200), searchSessionId: text(wrapper.search_session_id, 200),
    nextPage: Number.isSafeInteger(wrapper.next_page) && wrapper.next_page > 1 ? wrapper.next_page : null,
    hasMore: inner.has_more === true, cursor: text(inner.cursor || rows.at(-1)?.cursor, 300), fetchedAt: now };
}
function validateParams(kind, params) {
  const allowed = { search: ['keyword', 'page', 'sort_type', 'time_filter', 'note_type', 'source', 'ai_mode', 'search_id', 'search_session_id'],
    author: ['user_id', 'cursor'], user: ['user_id'], note_video: ['note_id'], note_image: ['note_id'] };
  if (!ENDPOINTS[kind] || !params || typeof params !== 'object' || Array.isArray(params)
    || Object.keys(params).some(k => !allowed[kind].includes(k))) throw error('INVALID_PARAMETERS');
  if (kind === 'search') {
    if (typeof params.keyword !== 'string' || !params.keyword.trim() || params.keyword.length > 60
      || !Number.isInteger(params.page) || params.page < 1 || params.page > 20
      || !['popularity_descending', 'time_descending'].includes(params.sort_type)
      || !['一天内', '一周内'].includes(params.time_filter)
      || !['视频笔记', '普通笔记'].includes(params.note_type)) throw error('INVALID_PARAMETERS');
  } else if (!ID.test(params.user_id || params.note_id || '')) throw error('INVALID_PARAMETERS');
  if (Object.values(params).some(v => !['string', 'number'].includes(typeof v) || String(v).length > 500)) throw error('INVALID_PARAMETERS');
}
async function readLimited(response, max = 6 * 1024 * 1024) {
  let size = 0; const chunks = [];
  if (!response.body) throw error('EMPTY_RESPONSE');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) { await response.body.cancel?.().catch(() => {}); throw error('RESPONSE_TOO_LARGE'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function verifyPrice(fetcher = fetch, now = Date.now()) {
  const response = await fetcher(PRICE_URL, { signal: AbortSignal.timeout(15000), redirect: 'error', headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw error('PRICE_UNAVAILABLE');
  const html = await readLimited(response, 2 * 1024 * 1024);
  const visible = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');
  const prices = [...visible.matchAll(/Rednote endpoints are billed at\s*\$([0-9]+(?:\.[0-9]+)?)\s+per request/gi)].map(match => Number(match[1]));
  if (!/xiaohongshu/i.test(visible) || !prices.length || prices.some(price => price !== 0.01)) throw error('UNVERIFIED_PRICE');
  return { source: PRICE_URL, microUsd: PRICE_MICRO_USD, verifiedAt: now, expiresAt: now + 86400000, evidenceHash: digest(html) };
}
function splitResultNotes(notes) {
  const parts = []; let current = [];
  for (const note of notes) {
    if (Buffer.byteLength(JSON.stringify({ notes: [note] })) >= 184000) throw error('PROVIDER_SCHEMA');
    if (Buffer.byteLength(JSON.stringify({ notes: [...current, note] })) >= 184000) { parts.push(current); current = []; }
    current.push(note);
  }
  if (current.length) parts.push(current);
  return parts;
}

class Provider {
  constructor({ store, lease, config, round, price, key, fetcher = fetch, clock = Date.now }) {
    Object.assign(this, { store, lease, config, round, price, key, fetcher, clock });
    this.sent = 0;
  }
  async request(kind, params) {
    if (!this.config.enabled || !this.config.freeAiConfirmed || typeof this.key !== 'string' || !this.key.trim()) throw error('COLLECTION_DISABLED');
    validateParams(kind, params);
    if (JSON.stringify(params).includes(this.key)) throw error('INVALID_PARAMETERS');
    const requestKey = `${kind}:${digest(Object.fromEntries(Object.entries(params).sort()))}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (this.sent >= 5) throw error('TICK_LIMIT');
      const record = await reserveAttempt(this.store, { roundId: this.round.id, requestKey, kind, attempt,
        now: this.clock(), lease: this.lease, price: this.price, validation: this.round.validation,
        limits: { ...this.config, roundCalls: this.round.roundCalls } });
      if (record.reused) {
        if (record.status === 'succeeded' && record.resultRef) {
          const result = await this.store.get('dfp_results', record.resultRef);
          if (result) return result.value;
        }
        if (['reserved', 'inflight', 'unknown'].includes(record.status)) throw error('REQUEST_UNCERTAIN');
        if (!['HTTP_RETRYABLE', 'NETWORK_ERROR'].includes(record.errorCode)) throw error(record.errorCode || 'REQUEST_FAILED');
        continue;
      }
      await markInflight(this.store, record.id, this.lease, this.clock());
      this.sent++;
      try {
        const url = new URL(ENDPOINTS[kind], BASE);
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
        const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${this.key}` },
          signal: AbortSignal.timeout(40000), redirect: 'error' });
        if (!response.ok) throw error(response.status === 401 || response.status === 403 ? 'PROVIDER_AUTH'
          : response.status === 429 || response.status >= 500 ? 'HTTP_RETRYABLE' : 'HTTP_REJECTED');
        const body = await readLimited(response);
        let payload; try { payload = JSON.parse(body); } catch { throw error('PROVIDER_SCHEMA'); }
        const parsed = parseResponse(kind, payload, this.clock(), params);
        // Store normalized pages in bounded chunks, never raw credentials or provider responses.
        const pages = [];
        if (parsed.notes) {
          for (const [i, notes] of splitResultNotes(parsed.notes).entries()) {
            const ref = `${record.id}-${i}`;
            await this.store.put('dfp_results', ref, { notes });
            pages.push(ref);
          }
        }
        const value = { ...parsed }; delete value.notes;
        value.pages = pages;
        await this.store.put('dfp_results', record.id, { value });
        await finishAttempt(this.store, record.id, this.lease, { status: 'succeeded', resultRef: record.id }, this.clock());
        return value;
      } catch (e) {
        const code = ['PROVIDER_AUTH', 'HTTP_RETRYABLE', 'HTTP_REJECTED', 'PROVIDER_REJECTED', 'PROVIDER_SCHEMA', 'RESPONSE_TOO_LARGE'].includes(e.code) ? e.code : 'NETWORK_ERROR';
        await finishAttempt(this.store, record.id, this.lease, { status: code === 'NETWORK_ERROR' ? 'unknown' : 'failed', errorCode: code }, this.clock());
        if (code !== 'HTTP_RETRYABLE' || attempt === 2) throw error(code);
      }
    }
    throw error('REQUEST_FAILED');
  }
  async notes(result) {
    const rows = [];
    for (const ref of result.pages || []) rows.push(...((await this.store.get('dfp_results', ref))?.notes || []));
    return rows;
  }
}

module.exports = { normalizeNote, parseResponse, validateParams, metric, sourceLink, imageUrl, digest,
  readLimited, verifyPrice, splitResultNotes, Provider, ID };
