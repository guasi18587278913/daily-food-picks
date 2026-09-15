'use strict';
const { authorTarget } = require('./author-navigation');
/** @param {{authorId?:string,authorNavigation?:unknown}|null} note */
function canOpenAuthor(note) { return !!note && !!authorTarget(note.authorNavigation, note.authorId); }
/** @param {{authorId?:string,authorNavigation?:unknown}} note @param {(options:any)=>any} navigate @returns {Promise<'requested'|'cancelled'>} */
function openAuthor(note, navigate) {
  const target = authorTarget(note.authorNavigation, note.authorId);
  if (!target) return Promise.reject(Error('AUTHOR_LINK_UNAVAILABLE'));
  return new Promise((resolve, reject) => {
    try {
      navigate({ ...target, success: () => resolve('requested'), fail: (/** @type {{errMsg?:string}} */ result) => {
        if (/\bcancel(?:led|ed)?\b|取消/i.test(result?.errMsg || '')) resolve('cancelled');
        else reject(Error('AUTHOR_OPEN_FAILED'));
      } });
    } catch { reject(Error('AUTHOR_OPEN_FAILED')); }
  });
}
module.exports = { canOpenAuthor, openAuthor };
