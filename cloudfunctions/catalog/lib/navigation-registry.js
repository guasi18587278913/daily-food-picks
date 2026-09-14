'use strict';
const { mergeRegistry } = require('./source-navigation');
const REGISTRY_ID = 'source_navigation_v1';
async function registerLinks(store, { entries, expectedRevision, now = Date.now(), apply = false }) {
  return store.transaction(async tx => {
    const old = await tx.get('dfp_state', REGISTRY_ID);
    const next = mergeRegistry(old, entries, expectedRevision, now);
    const notes = [];
    for (const entry of entries) {
      const ref = await tx.get('dfp_candidates', `published_${entry.noteId}`);
      const snapshot = ref?.snapshotId && await tx.get('dfp_snapshots', ref.snapshotId);
      const row = ref?.indexId && await tx.get('dfp_notes', ref.indexId);
      if (!snapshot?.published || row?.snapshotId !== ref.snapshotId || row?.note?.noteId !== entry.noteId) throw new Error('SOURCE_NOTE_NOT_PUBLISHED');
      notes.push({ noteId: entry.noteId, title: row.note.title, author: row.note.author });
    }
    if (apply) await tx.put('dfp_state', REGISTRY_ID, next);
    return { applied: apply, revision: apply ? next.revision : expectedRevision, proposedRevision: next.revision, notes };
  });
}
module.exports = { REGISTRY_ID, registerLinks };
