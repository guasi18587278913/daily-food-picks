'use strict';
const { assertLease } = require('./budget');
const { authorId, validAuthorNavigation, authorNavigationFor } = require('./author-navigation');
const { recordFansObservation } = require('./authors');
const REFRESH_MS = 86400000;
function navigationFromShareLink(value, id) {
  if (!authorId(id) || typeof value !== 'string' || value.length > 4000) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || !['www.xiaohongshu.com', 'xiaohongshu.com'].includes(u.hostname)
      || u.username || u.password || u.port || u.hash || u.pathname !== `/user/profile/${id}`
      || u.searchParams.getAll('xsec_token').length !== 1 || u.searchParams.getAll('xsec_source').length !== 1) return null;
    const navigation = { authorId: id, token: u.searchParams.get('xsec_token'), source: u.searchParams.get('xsec_source') };
    return validAuthorNavigation(navigation, id) ? navigation : null;
  } catch { return null; }
}
async function saveAuthorProfile(store, lease, navigation, capturedAt, now) {
  if (!validAuthorNavigation(navigation, navigation?.authorId) || !Number.isSafeInteger(capturedAt)
    || capturedAt <= 0 || capturedAt > now) throw Object.assign(Error('AUTHOR_PROFILE_INVALID'), { code: 'AUTHOR_PROFILE_INVALID' });
  const id = `author_profile_${navigation.authorId}`;
  return store.transaction(async tx => {
    await assertLease(tx, lease, now);
    const old = await tx.get('dfp_results', id);
    if (old?.capturedAt > capturedAt) return false;
    await tx.put('dfp_results', id, { recordType: 'author_navigation', authorId: navigation.authorId, capturedAt, navigation });
    return true;
  });
}
async function ensureAuthorProfile({ store, lease, provider, note, clock }) {
  if (!authorId(note?.authorId) || !note.boards?.length) return { status: 'not_selected' };
  const now = clock(), old = await store.get('dfp_results', `author_profile_${note.authorId}`);
  if (authorNavigationFor(old, note.authorId, now) && now - old.capturedAt < REFRESH_MS) return { status: 'cached' };
  const result = await provider.request('user', { user_id: note.authorId }, { purpose: 'inspection', requireAuthorProfile: true });
  // The same answer feeds the follower history and the published fan count; the navigation link stays optional.
  await recordFansObservation(store, lease, { authorId: note.authorId, author: note.author, fans: result.fans,
    at: result.capturedAt ?? result.fetchedAt, note }, clock());
  const fans = Number.isSafeInteger(result.fans) ? result.fans : null;
  if (!validAuthorNavigation(result.authorNavigation, note.authorId)) return { status: 'missing', fans };
  await saveAuthorProfile(store, lease, result.authorNavigation, result.capturedAt || result.fetchedAt, clock());
  return { status: 'saved', fans };
}
module.exports = { navigationFromShareLink, saveAuthorProfile, ensureAuthorProfile };
