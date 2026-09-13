'use strict';

const NOTE_ID = /^[0-9a-f]{24}$/;
// A document is capped at 184000 bytes; 500 entries of roughly 45 bytes leaves ample headroom.
const FAVORITE_LIMIT = 500;

function fail(code) { const error = new Error(code); error.code = code; throw error; }

/** Keeps only entries that match the stored shape, so a damaged document cannot spread. */
function sanitize(items) {
  if (!items || typeof items !== 'object' || Array.isArray(items)) return {};
  const clean = {};
  for (const [noteId, at] of Object.entries(items)) {
    if (NOTE_ID.test(noteId) && Number.isSafeInteger(at) && at > 0) clean[noteId] = at;
  }
  return clean;
}

/** Validates a set supplied by a client; anything off-shape refuses the whole call. */
function incoming(items) {
  if (!items || typeof items !== 'object' || Array.isArray(items)) fail('INVALID_ARGUMENT');
  const entries = Object.entries(items);
  if (entries.length > FAVORITE_LIMIT) fail('LIMIT_EXCEEDED');
  const clean = {};
  for (const [noteId, at] of entries) {
    if (!NOTE_ID.test(noteId) || !Number.isSafeInteger(at) || at <= 0) fail('INVALID_ARGUMENT');
    clean[noteId] = at;
  }
  return clean;
}

async function listFavorites(store, openId) {
  const record = await store.get('dfp_favorites', openId);
  return { items: sanitize(record?.items), mergedAt: record?.mergedAt || null };
}

/**
 * Adds or removes one entry. Runs in a transaction so two devices cannot drop each other's change.
 * @param {{transaction:Function}} store
 */
async function toggleFavorite(store, { openId, noteId, at }) {
  if (typeof noteId !== 'string' || !NOTE_ID.test(noteId)) fail('INVALID_ARGUMENT');
  return store.transaction(async tx => {
    const record = await tx.get('dfp_favorites', openId);
    const items = sanitize(record?.items);
    const selected = !Object.hasOwn(items, noteId);
    if (selected) {
      if (Object.keys(items).length >= FAVORITE_LIMIT) fail('LIMIT_EXCEEDED');
      items[noteId] = at;
    } else delete items[noteId];
    await tx.put('dfp_favorites', openId, { items, updatedAt: new Date(at).toISOString(), mergedAt: record?.mergedAt || null });
    return { selected, count: Object.keys(items).length };
  });
}

/**
 * Folds a locally stored set into the stored one. The union is taken and the earlier
 * timestamp kept, so neither side can erase the other and repeating it changes nothing.
 * @param {{transaction:Function}} store
 */
async function mergeFavorites(store, { openId, items, at }) {
  const local = incoming(items);
  return store.transaction(async tx => {
    const record = await tx.get('dfp_favorites', openId);
    const merged = sanitize(record?.items);
    for (const [noteId, stamp] of Object.entries(local)) {
      merged[noteId] = Object.hasOwn(merged, noteId) ? Math.min(merged[noteId], stamp) : stamp;
    }
    if (Object.keys(merged).length > FAVORITE_LIMIT) fail('LIMIT_EXCEEDED');
    const mergedAt = new Date(at).toISOString();
    await tx.put('dfp_favorites', openId, { items: merged, updatedAt: mergedAt, mergedAt });
    return { items: merged, mergedAt, count: Object.keys(merged).length };
  });
}

module.exports = { listFavorites, toggleFavorite, mergeFavorites, FAVORITE_LIMIT, NOTE_ID };
