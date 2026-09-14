'use strict';
const { validNavigation } = require('./source-navigation');
/** @param {{noteId:string,sourceNavigation?:unknown}|undefined} note */
function canOpenOriginal(note) { return !!note && validNavigation(note.sourceNavigation, note.noteId); }
/** @param {{noteId:string,sourceNavigation?:unknown}} note @param {(options:any)=>any} navigate @returns {Promise<'requested'|'cancelled'>} */
function openOriginal(note, navigate) {
  const navigation = note.sourceNavigation;
  if (!validNavigation(navigation, note.noteId)) return Promise.reject(new Error('SOURCE_LINK_UNAVAILABLE'));
  return new Promise((resolve, reject) => {
    try {
      navigate({ shortLink: navigation.shortLink,
        success: () => resolve('requested'),
        fail: (/** @type {{errMsg?:string}} */ result) => {
          if (/\bcancel(?:led|ed)?\b|取消/i.test(result?.errMsg || '')) resolve('cancelled');
          else reject(new Error('SOURCE_OPEN_FAILED'));
        } });
    } catch { reject(new Error('SOURCE_OPEN_FAILED')); }
  });
}
module.exports = { canOpenOriginal, openOriginal };
