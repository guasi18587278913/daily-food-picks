'use strict';
/** @typedef {{noteId:string,shortLink:string,confirmedAt:number,expiresAt?:number}} VerifiedEntry */
/** @typedef {{version:1,revision:number,entries:Record<string,VerifiedEntry>}} NavigationRegistry */
/** @param {unknown} x @returns {x is Record<string, any>} */
function object(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
/** @param {unknown} id @returns {id is string} */
function noteId(id) { return typeof id === 'string' && /^[a-f0-9]{24}$/.test(id); }
/** @param {unknown} value @returns {value is string} */
function shortLink(value) {
  return typeof value === 'string' && value.length <= 512
    && /^#小程序:\/\/小红书\/(?:[^/\s?#\u0000-\u001f]{1,100}\/){0,3}[a-zA-Z0-9_-]{6,128}$/.test(value);
}
/** @param {unknown} value @param {string} id @param {number} now @returns {value is VerifiedEntry} */
function entry(value, id, now) {
  return object(value) && Object.keys(value).every(k => ['noteId','shortLink','confirmedAt','expiresAt'].includes(k))
    && noteId(id) && value.noteId === id && shortLink(value.shortLink)
    && Number.isSafeInteger(value.confirmedAt) && value.confirmedAt > 0 && value.confirmedAt <= now
    && (value.expiresAt === undefined || Number.isSafeInteger(value.expiresAt) && value.expiresAt > value.confirmedAt);
}
/** @param {unknown} value @param {number} now @returns {value is NavigationRegistry} */
function validRegistry(value, now) {
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !object(value.entries) || Object.keys(value).some(k => !['version','revision','entries','_id'].includes(k))
    || Object.keys(value.entries).length > 100 || JSON.stringify(value).length > 40000) return false;
  const codes = new Set();
  for (const [id, record] of Object.entries(value.entries)) {
    if (!entry(record, id, now)) return false;
    const code = record.shortLink.split('/').slice(-1)[0];
    if (codes.has(code)) return false; codes.add(code);
  }
  return true;
}
/** @param {unknown} value @param {string} id @returns {value is {noteId:string,shortLink:string}} */
function validNavigation(value, id) {
  return object(value) && Object.keys(value).every(k => ['noteId','shortLink'].includes(k))
    && noteId(id) && value.noteId === id && shortLink(value.shortLink);
}
/** @param {unknown} registry @param {string} id @param {number} now */
function navigationFor(registry, id, now) {
  if (!noteId(id) || !validRegistry(registry, now)) return null;
  const record = registry.entries[id];
  if (!record || record.expiresAt !== undefined && record.expiresAt <= now) return null;
  return { noteId: id, shortLink: record.shortLink };
}
/** @param {unknown} current @param {Array<Record<string,any>>} additions @param {number} expectedRevision @param {number} now @returns {NavigationRegistry} */
function mergeRegistry(current, additions, expectedRevision, now) {
  const old = current === null ? { version: 1, revision: 0, entries: {} } : current;
  if (!validRegistry(old, now)) throw new Error('SOURCE_REGISTRY_INVALID');
  if (old.revision !== expectedRevision) throw new Error('SOURCE_REGISTRY_CONFLICT');
  if (!Array.isArray(additions) || !additions.length || additions.length > 20) throw new Error('SOURCE_LINK_BATCH_INVALID');
  /** @type {NavigationRegistry} */
  const next = { version: 1, revision: old.revision + 1, entries: { ...old.entries } };
  const ids = new Set();
  for (const item of additions) {
    if (!object(item) || item.confirmed !== true || !noteId(item.noteId) || !shortLink(item.shortLink)
      || Object.keys(item).some(k => !['noteId','shortLink','confirmed','expiresAt'].includes(k)) || ids.has(item.noteId)) throw new Error('SOURCE_LINK_UNCONFIRMED');
    ids.add(item.noteId);
    const record = { noteId: item.noteId, shortLink: item.shortLink, confirmedAt: now,
      ...(item.expiresAt !== undefined ? { expiresAt: item.expiresAt } : {}) };
    if (!entry(record, item.noteId, now) || record.expiresAt !== undefined && record.expiresAt <= now) throw new Error('SOURCE_LINK_INVALID');
    next.entries[item.noteId] = record;
  }
  if (!validRegistry(next, now)) throw new Error('SOURCE_REGISTRY_INVALID');
  return next;
}
module.exports = { noteId, shortLink, validNavigation, validRegistry, navigationFor, mergeRegistry };
