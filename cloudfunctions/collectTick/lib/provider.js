'use strict';

const { createHash } = require('node:crypto');
const { PRICE_URL, PRICE_MICRO_USD, reserveAttempt, markInflight, finishAttempt } = require('./budget');
const { error } = require('./config');
const { cacheKey, readCache, writeCache, maximumAge, mergeDetail } = require('./reuse');
const { ID, endpoint, detailKind } = require('./endpoints');
const { navigationFromShareLink } = require('./author-profiles');
const BASE = 'https://api.tikhub.io/api/v1/xiaohongshu/app_v2/';
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
      && /(^|\.)(xhscdn\.com|xiaohongshu\.com|rednotecdn\.com)$/.test(url.hostname) && url.href.length <= 3000) {
      url.protocol = 'https:'; return url.href;
    }
  } catch {}
  return null;
}
function publishedTime(raw) {
  const n = raw.timestamp ?? raw.create_time ?? raw.time ?? raw.note_time?.create_time;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e11 ? n : n * 1000;
  if (!Number.isSafeInteger(ms) || ms > 8640000000000000) return null;
  return new Date(ms).toISOString();
}
function topicPage(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'xhsdiscover:' && !(url.protocol === 'https:'
      && ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname))) return null;
    const candidate = url.searchParams.get('id') || url.pathname.split('/').filter(Boolean).at(-1);
    return ID.test(candidate || '') ? candidate : null;
  } catch { return null; }
}
function topicsOf(raw) {
  const rows = [raw.hash_tag, raw.hash_tags, raw.topics].filter(Array.isArray).flat().slice(0, 40);
  const topics = new Map();
  for (const item of rows) {
    const pageId = ID.test(item?.page_id || '') ? item.page_id : topicPage(item?.link);
    const label = text(item?.name || item?.title, 120);
    if (pageId && label) topics.set(pageId, { pageId, label });
  }
  return [...topics.values()].slice(0, 20);
}
function mediaUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4000
      || !/(^|\.)(xhscdn\.com|rednotecdn\.com)$/.test(url.hostname)) return null;
    url.protocol = 'https:'; return url.href;
  } catch { return null; }
}
function mediaOf(raw) {
  if (raw.type !== 'video') return null;
  const media = raw.video_info_v2?.media;
  const streamGroups = media?.stream || {};
  const streams = Object.values(streamGroups).filter(Array.isArray).flat().slice(0, 40)
    .map(s => ({ url: mediaUrl(s?.master_url), bytes: metric(s?.size) }))
    .filter(s => s.url && s.bytes > 0 && s.bytes <= 32 * 1024 * 1024)
    .sort((a, b) => a.bytes - b.bytes);
  if (!streams.length) return null;
  const duration = media?.video?.duration;
  const durationMs = Number.isFinite(duration) && duration > 0 ? Math.ceil(duration * 1000) : null;
  const chosen = streams[0];
  const contentId = /^[a-f0-9]{32}$/i.test(media?.video?.md5 || '')
    ? media.video.md5.toLowerCase() : new URL(chosen.url).pathname;
  return { ...chosen, durationMs, identity: digest(contentId) };
}
function metadataSignals(spec, inner) {
  const rows = spec.signalRows(inner);
  if (!Array.isArray(rows)) throw error('PROVIDER_SCHEMA');
  const signals = rows.slice(0, 60).map(row => {
    let pageId = ID.test(row?.page_id || '') ? row.page_id : null;
    if (!pageId && spec.topicFromDeeplink) {
      try {
        const link = new URL(row?.post_deeplink);
        if (link.protocol === 'xhsdiscover:') {
          const attach = JSON.parse(link.searchParams.get('attach') || '{}');
          const id = attach.topics?.[0]?.page_id;
          if (ID.test(id || '')) pageId = id;
        }
      } catch {}
    }
    return { label: text(row?.title || row?.name, 120), pageId,
      signalType: text(row?.type, 40), displayMetric: text(row?.score_text || row?.cnt_desc, 120) };
  }).filter(x => x.label);
  if (rows.length && !signals.length) throw error('PROVIDER_SCHEMA');
  return signals;
}
function normalizeNote(raw, { source = 'search', fetchedAt = Date.now(), authorId = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const noteId = raw.id ?? raw.note_id;
  const user = raw.user || {};
  const uid = user.userid ?? user.user_id ?? user.id ?? authorId;
  if (!ID.test(noteId || '') || !ID.test(uid || '') || !['video', 'normal'].includes(raw.type)) return null;
  const rawTitle = raw.title || raw.display_title || '';
  const title = text(rawTitle, 2000);
  const desc = text(raw.desc, 12000);
  const pinned = raw.sticky ?? raw.is_top;
  const sticky = typeof pinned === 'boolean' ? pinned : ([0, 1].includes(pinned) ? pinned === 1 : null);
  const cover = raw.images_list?.[0] || raw.cover || {};
  const imageOf = item => imageUrl(item?.url_default || item?.url || item?.url_size_large || item?.original || item?.info_list?.[0]?.url);
  const image = imageOf(cover);
  const rawImages = Array.isArray(raw.images_list) ? raw.images_list : [];
  const images = [...new Set(rawImages.slice(0, 20).map(imageOf).filter(Boolean))];
  const imageCount = Number.isSafeInteger(raw.image_count) && raw.image_count >= rawImages.length ? raw.image_count : rawImages.length;
  const imagesComplete = source === 'detail' && Array.isArray(raw.images_list) && images.length === imageCount && raw.has_more_images !== true;
  let link = raw.share_info?.link || raw.share_info?.share_link || raw.share_link;
  if (!link && typeof raw.xsec_token === 'string' && raw.xsec_token.length < 1000) {
    link = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${encodeURIComponent(raw.xsec_token)}&xsec_source=pc_search`;
  }
  const topics = topicsOf(raw), media = mediaOf(raw), interaction = raw.interaction_info || {};
  return { noteId, authorId: uid, title, desc, type: raw.type, author: text(user.nickname || user.name, 120),
    publishedAt: publishedTime(raw), likes: metric(raw.liked_count ?? raw.likes ?? interaction.like_count),
    collected: metric(raw.collected_count ?? interaction.collect_count), comments: metric(raw.comments_count ?? interaction.comment_count),
    shared: metric(raw.shared_count ?? raw.share_count ?? interaction.share_count),
    fans: metric(user.fans), sticky, sourceUrl: sourceLink(link, noteId), coverUrl: image,
    images, imageCount, imagesComplete,
    bodyComplete: source === 'detail' && typeof raw.desc === 'string'
      && raw.desc.length <= 12000 && typeof rawTitle === 'string' && rawTitle.length <= 2000 && raw.desc_truncated !== true
      && raw.has_more_desc !== true && raw.title_truncated !== true
      && !/(?:[.。]{3,}|…+)\s*$/.test(desc) && !/(?:[.。]{3,}|…+)\s*$/.test(title),
    source, fetchedAt: new Date(fetchedAt).toISOString(), ...(topics.length ? { topics } : {}), ...(media ? { media } : {}) };
}
function parseResponse(kind, payload, now, params = {}) {
  const spec = endpoint(kind);
  if (!spec) throw error('INVALID_PARAMETERS');
  if (!payload || payload.code !== 200 || !payload.data || payload.data.success === false
    || ![undefined, 0, 200].includes(payload.data.code)) throw error('PROVIDER_REJECTED');
  const wrapper = payload.data;
  const inner = wrapper.data;
  if (!inner || typeof inner !== 'object') throw error('PROVIDER_SCHEMA');
  if (spec.yields === 'profile') {
    const visibility = inner.tab_public?.collection;
    const authorNavigation = navigationFromShareLink(inner.share_link, params.user_id);
    return { fans: metric(inner.fans), fetchedAt: now, ...(authorNavigation ? { authorNavigation } : {}),
      ...(typeof visibility === 'boolean' ? { collectionsPublic: visibility && inner.tab_visible?.collect !== false } : {}) };
  }
  if (spec.yields === 'signals') return { notes: [], signals: metadataSignals(spec, inner),
    cursor: text(inner.cursor, 300), hasMore: inner.end_flag === false, fetchedAt: now };
  const rows = spec.rows(inner);
  if (!Array.isArray(rows)) throw error('PROVIDER_SCHEMA');
  const notes = rows.map(row => normalizeNote(row?.note_info || row?.note || row,
    { source: spec.source, fetchedAt: now, authorId: spec.authorFromParams ? params.user_id : null })).filter(Boolean);
  // Empty responses are valid; a nonempty page that cannot be decoded is a schema failure.
  if (rows.length && !notes.length) throw error('PROVIDER_SCHEMA');
  return { notes, searchId: text(wrapper.search_id, 200), searchSessionId: text(wrapper.search_session_id, 200),
    nextPage: Number.isSafeInteger(wrapper.next_page) && wrapper.next_page > 1 ? wrapper.next_page : null,
    hasMore: inner.has_more === true, cursor: text(inner.cursor || rows.at(-1)?.cursor, 300), fetchedAt: now };
}
function validateParams(kind, params) {
  const spec = endpoint(kind);
  if (!spec || !params || typeof params !== 'object' || Array.isArray(params)
    || Object.keys(params).some(k => !spec.params.includes(k)) || !spec.accepts(params)) throw error('INVALID_PARAMETERS');
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
    this.cacheHits = 0;
  }
  async reusable(kind, requestKey, options) {
    const version = 'discovery-provider-1';
    const cached = await readCache(this.store, cacheKey('result', requestKey),
      { now: this.clock(), maxAgeMs: 6 * 3600000, version });
    if (!cached) return null;
    if (kind === 'user' && options.requireAuthorProfile && !cached.value.authorNavigation) return null;
    if (!Array.isArray(cached.value.pages)) return null;
    let notes;
    try { notes = await this.notes(cached.value); } catch { return null; }
    const candidate = options.expectedNote || notes.find(n => n.noteId === options.noteId) || cached.value;
    if (this.clock() - cached.capturedAt > maximumAge(kind, candidate, this.clock())) return null;
    const detail = endpoint(kind)?.detail === true;
    if (detail && options.expectedNote) {
      const full = notes.find(n => n.noteId === options.expectedNote.noteId);
      const merged = mergeDetail(full, options.expectedNote, this.clock());
      if (!merged) return null;
      notes = notes.map(n => n.noteId === merged.noteId ? merged : n);
    }
    // A long-lived week detail can contain a short-lived today candidate. Check each attached note separately.
    if (detail) notes = notes.map(note => note.noteId !== options.noteId
      && this.clock() - cached.capturedAt > maximumAge(detailKind(note.type), note, this.clock())
      ? { ...note, bodyComplete: false } : note);
    this.cacheHits++;
    return { ...cached.value, cached: true, capturedAt: cached.capturedAt, _notes: notes };
  }
  async request(kind, params, options = {}) {
    if (!this.config.enabled || !this.config.freeAiConfirmed || typeof this.key !== 'string' || !this.key.trim()) throw error('COLLECTION_DISABLED');
    validateParams(kind, params);
    if (JSON.stringify(params).includes(this.key)) throw error('INVALID_PARAMETERS');
    const requestKey = `${kind}:${digest(Object.fromEntries(Object.entries(params).sort()))}`;
    const reuseEnabled = this.round.discoveryMode === 'adaptive';
    if (reuseEnabled && !options.forceFresh) {
      const reused = await this.reusable(kind, requestKey, { ...options, noteId: params.note_id });
      if (reused) return reused;
    }
    const maxAttempts = options.requireAuthorProfile ? 1 : 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // The runner stops claiming work at 105 s, so ten serial requests (about 4 s each for searches) fit one tick.
      if (this.sent >= 10) throw error('TICK_LIMIT');
      const record = await reserveAttempt(this.store, { roundId: this.round.id, requestKey, kind, attempt,
        now: this.clock(), lease: this.lease, price: this.price, validation: this.round.validation,
        purpose: options.purpose, sourceKey: options.sourceKey, limits: { ...this.config, roundCalls: this.round.roundCalls } });
      if (record.reused) {
        if (record.status === 'succeeded' && record.resultRef) {
          const result = await this.store.get('dfp_results', record.resultRef);
          if (result) return { ...result.value, reused: true };
        }
        if (['reserved', 'inflight', 'unknown'].includes(record.status)) throw error('REQUEST_UNCERTAIN');
        if (!['HTTP_RETRYABLE', 'NETWORK_ERROR'].includes(record.errorCode)) throw error(record.errorCode || 'REQUEST_FAILED');
        continue;
      }
      const capturedAt = this.clock();
      await markInflight(this.store, record.id, this.lease, capturedAt);
      this.sent++;
      // Persist only status numbers; response messages may contain private data.
      const diagnostics = { httpStatus: null, providerCode: null, providerDataCode: null };
      try {
        const url = new URL(endpoint(kind).path, BASE);
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
        const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${this.key}` },
          signal: AbortSignal.timeout(options.requireAuthorProfile ? 10000 : 40000), redirect: 'error' });
        diagnostics.httpStatus = response.status;
        if (!response.ok) throw error(response.status === 401 || response.status === 403 ? 'PROVIDER_AUTH'
          : response.status === 429 || response.status >= 500 ? 'HTTP_RETRYABLE' : 'HTTP_REJECTED');
        const body = await readLimited(response);
        let payload; try { payload = JSON.parse(body); } catch { throw error('PROVIDER_SCHEMA'); }
        diagnostics.providerCode = payload?.code;
        diagnostics.providerDataCode = payload?.data?.code;
        const parsed = parseResponse(kind, payload, capturedAt, params);
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
        if (reuseEnabled) value.capturedAt = capturedAt;
        await this.store.put('dfp_results', record.id, { value });
        await finishAttempt(this.store, record.id, this.lease, { status: 'succeeded', resultRef: record.id, ...diagnostics }, this.clock());
        if (reuseEnabled) {
          try {
            await writeCache(this.store, this.lease, cacheKey('result', requestKey),
              { capturedAt, ttlMs: 6 * 3600000, version: 'discovery-provider-1', value }, this.clock());
          } catch (cacheError) {
            if (cacheError.code === 'LEASE_EXPIRED') throw cacheError;
            return { ...value, cacheWarning: 'CACHE_WRITE_FAILED' };
          }
        }
        return value;
      } catch (e) {
        if (e.code === 'LEASE_EXPIRED') throw e;
        const code = ['PROVIDER_AUTH', 'HTTP_RETRYABLE', 'HTTP_REJECTED', 'PROVIDER_REJECTED', 'PROVIDER_SCHEMA', 'RESPONSE_TOO_LARGE'].includes(e.code) ? e.code : 'NETWORK_ERROR';
        await finishAttempt(this.store, record.id, this.lease, { status: code === 'NETWORK_ERROR' ? 'unknown' : 'failed', errorCode: code, ...diagnostics }, this.clock());
        if (code !== 'HTTP_RETRYABLE' || attempt === maxAttempts) throw error(code);
      }
    }
    throw error('REQUEST_FAILED');
  }
  async notes(result) {
    if (Array.isArray(result._notes)) return result._notes;
    const rows = [];
    for (const ref of result.pages || []) {
      const page = await this.store.get('dfp_results', ref);
      if (!Array.isArray(page?.notes)) throw error('PROVIDER_SCHEMA');
      rows.push(...page.notes);
    }
    return rows;
  }
}

module.exports = { normalizeNote, parseResponse, validateParams, metric, sourceLink, imageUrl, digest,
  readLimited, verifyPrice, splitResultNotes, Provider, ID, mediaUrl, topicPage };
