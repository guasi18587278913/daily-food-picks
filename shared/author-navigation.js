'use strict';
/** @typedef {{authorId:string,token:string,source:string}} AuthorNavigation */
/** @param {unknown} id @returns {id is string} */
function authorId(id) { return typeof id === 'string' && /^[a-f0-9]{24}$/.test(id); }
/** @param {unknown} value @param {unknown} id @returns {value is AuthorNavigation} */
function validAuthorNavigation(value, id) {
  if (!authorId(id) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = /** @type {Record<string,any>} */ (value);
  return Object.keys(v).every(k => ['authorId', 'token', 'source'].includes(k)) && v.authorId === id
    && typeof v.token === 'string' && /^[\x21-\x7e]{1,1500}$/.test(v.token)
    && ['app_share', 'mp_share'].includes(v.source);
}
/** @param {unknown} value @param {unknown} id */
function authorTarget(value, id) {
  if (!validAuthorNavigation(value, id)) return null;
  return { appId: 'wxb296433268a1c654', path: `pages/secondary/author/index?author_id=${value.authorId}`
    + `&xsec_token=${encodeURIComponent(value.token)}&xsec_source=${encodeURIComponent(value.source)}` };
}
/** @param {any} record @param {unknown} id @param {number} now */
function authorNavigationFor(record, id, now) {
  return record?.recordType === 'author_navigation' && record.authorId === id
    && Number.isSafeInteger(record.capturedAt) && record.capturedAt > 0 && record.capturedAt <= now
    && validAuthorNavigation(record.navigation, id) ? record.navigation : null;
}
module.exports = { authorId, validAuthorNavigation, authorTarget, authorNavigationFor };
