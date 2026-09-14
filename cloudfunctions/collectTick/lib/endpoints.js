'use strict';

// One row per TikHub App V2 endpoint the collector may call. provider, budget, discovery and reuse all read this
// table instead of keeping their own kind lists, so adding an endpoint is one row here plus its tests.
// Rows only describe; the caller decides which error to raise when a predicate fails.
//   path            request path under the App V2 base URL
//   params          the only query parameters accepted; anything else is rejected before spending
//   accepts         per-endpoint parameter rules (types, enums, 24-hex identifiers)
//   yields          'notes' (posts), 'signals' (topic or hot leads without posts) or 'profile' (author info)
//   rows            for 'notes': raw post rows from the response body, or a non-array when the shape is unknown
//   source          for 'notes': the source label written into each normalized note
//   authorFromParams  the response omits the author, so the requested user_id fills it in
//   signalRows      for 'signals': raw lead rows from the response body
//   topicFromDeeplink  leads without a page_id may carry one inside their xhsdiscover deeplink
//   detail          the endpoint returns one requested note plus related ones
//   discoveryOnly   may only be charged to the round's discovery allowance, never to inspection
const ID = /^[0-9a-f]{24}$/;
const identifier = field => params => ID.test(params[field] || '');
const optionalCursor = params => params.cursor === undefined || typeof params.cursor === 'string';
const listRows = inner => inner.notes ?? inner.items ?? inner.list;
// A detail response wraps the target with related notes; either level may carry a note_list.
const detailRows = inner => {
  const rows = Array.isArray(inner) ? inner : inner.notes ?? inner.items ?? [inner.note ?? inner.note_info ?? inner];
  return Array.isArray(rows) ? rows.flatMap(row => Array.isArray(row?.note_list) ? row.note_list : [row]) : rows;
};

const ENDPOINTS = Object.freeze({
  search: Object.freeze({ path: 'search_notes', yields: 'notes', source: 'search', discoveryOnly: true,
    params: ['keyword', 'page', 'sort_type', 'time_filter', 'note_type', 'source', 'ai_mode', 'search_id', 'search_session_id'],
    accepts: params => typeof params.keyword === 'string' && params.keyword.trim() !== '' && params.keyword.length <= 60
      && Number.isInteger(params.page) && params.page >= 1 && params.page <= 20
      && ['popularity_descending', 'time_descending'].includes(params.sort_type)
      && ['一天内', '一周内'].includes(params.time_filter)
      && ['视频笔记', '普通笔记', '不限'].includes(params.note_type),
    rows: inner => Array.isArray(inner.items) ? inner.items.filter(x => x?.note).map(x => x.note) : null }),
  author: Object.freeze({ path: 'get_user_posted_notes', yields: 'notes', source: 'author', authorFromParams: true,
    params: ['user_id', 'cursor'], accepts: identifier('user_id'), rows: listRows }),
  user: Object.freeze({ path: 'get_user_info', yields: 'profile', params: ['user_id'], accepts: identifier('user_id') }),
  note_video: Object.freeze({ path: 'get_video_note_detail', yields: 'notes', source: 'detail', detail: true,
    params: ['note_id'], accepts: identifier('note_id'), rows: detailRows }),
  note_image: Object.freeze({ path: 'get_image_note_detail', yields: 'notes', source: 'detail', detail: true,
    params: ['note_id'], accepts: identifier('note_id'), rows: detailRows }),
  hot: Object.freeze({ path: 'get_creator_hot_inspiration_feed', yields: 'signals', discoveryOnly: true,
    params: ['cursor'], accepts: optionalCursor, signalRows: inner => inner.items }),
  inspiration: Object.freeze({ path: 'get_creator_inspiration_feed', yields: 'signals', discoveryOnly: true, topicFromDeeplink: true,
    params: ['cursor', 'tab', 'source'],
    accepts: params => optionalCursor(params) && (params.tab === undefined || params.tab === 0)
      && (params.source === undefined || params.source === 'creator_center'),
    signalRows: inner => inner.inspirations }),
  topic: Object.freeze({ path: 'get_topic_feed', yields: 'notes', source: 'topic', discoveryOnly: true,
    params: ['page_id', 'sort'], accepts: params => ID.test(params.page_id || '') && ['trend', 'time'].includes(params.sort),
    rows: listRows }),
  faved: Object.freeze({ path: 'get_user_faved_notes', yields: 'notes', source: 'faved', discoveryOnly: true,
    params: ['user_id', 'cursor'], accepts: identifier('user_id'),
    // A fallback page is TikHub substituting recommendations for a private collection, never the author's own picks.
    rows: inner => inner.fallback === true ? null : listRows(inner) })
});

// Own keys only: 'constructor' or '__proto__' must never resolve to an endpoint.
function endpoint(kind) {
  return typeof kind === 'string' && Object.hasOwn(ENDPOINTS, kind) ? ENDPOINTS[kind] : null;
}
const detailKind = noteType => noteType === 'video' ? 'note_video' : 'note_image';

module.exports = { ENDPOINTS, ID, endpoint, detailKind };
