'use strict';

const { digest, imageUrl } = require('./provider');
const { assertLease } = require('./budget');
const { error } = require('./config');
const MAX_BYTES = 184000;
async function isPublished(store, snapshotId) {
  if (!snapshotId) return false;
  return (await store.get('dfp_snapshots', snapshotId))?.published === true;
}
async function previouslyPublished(store, noteId) {
  const ref = await store.get('dfp_candidates', `published_${noteId}`);
  return !!ref && await isPublished(store, ref.snapshotId);
}
function publicNote(note) {
  const keys = ['noteId', 'title', 'author', 'authorId', 'type', 'publishedAt', 'likes', 'collected', 'comments',
    'shared', 'fans', 'baseline', 'ratio', 'fanRatio', 'baselineReason', 'sourceUrl', 'fileId', 'coverUrl', 'boards', 'firstRoundId'];
  return Object.fromEntries(keys.map(k => [k, note[k] ?? null]));
}
function splitParts(notes) {
  const parts = []; let rows = [];
  for (const note of notes) {
    if (Buffer.byteLength(JSON.stringify({ notes: [note] })) >= MAX_BYTES) throw error('NOTE_TOO_LARGE');
    if (Buffer.byteLength(JSON.stringify({ notes: [...rows, note] })) >= MAX_BYTES) { parts.push(rows); rows = []; }
    rows.push(note);
  }
  if (rows.length) parts.push(rows);
  return parts;
}
async function readSnapshot(store, id) {
  const snapshot = await store.get('dfp_snapshots', id);
  if (!snapshot?.published) throw error('NOT_FOUND');
  if (!Array.isArray(snapshot.parts) || snapshot.parts.some(ref => typeof ref?.id !== 'string' || typeof ref.hash !== 'string')) throw error('CORRUPT_SNAPSHOT');
  const notes = [];
  for (const ref of snapshot.parts) {
    const part = await store.get('dfp_parts', ref.id);
    if (!part || !Array.isArray(part.notes) || digest(part.notes) !== ref.hash) throw error('CORRUPT_SNAPSHOT');
    notes.push(...part.notes);
  }
  if (notes.length !== snapshot.count) throw error('CORRUPT_SNAPSHOT');
  return { ...snapshot, notes };
}
async function publish({ store, lease, round, notes, carriedNotes = [], status, coverage, partialReason = '', successfulSearches, now, clock = Date.now }) {
  const time = () => now ?? clock();
  if (!['complete', 'partial'].includes(status)) throw error('INVALID_STATUS');
  if (status === 'partial' && !partialReason.trim()) throw error('PARTIAL_REASON_REQUIRED');
  if (!notes.length && !successfulSearches) throw error('NO_VALID_DATA');
  await store.transaction(tx => assertLease(tx, lease, time()));
  const unique = [];
  for (const note of new Map(notes.map(x => [x.noteId, x])).values()) {
    if (note.judgment?.verdict !== 'cooking' || !note.boards?.length) continue;
    if (!await previouslyPublished(store, note.noteId)) unique.push({ ...note, firstRoundId: round.id });
  }
  unique.sort((a, b) => a.noteId.localeCompare(b.noteId));
  // Carried notes were recommended by an earlier snapshot: shown again, but they get no new search rows or dedup references.
  const shown = new Map([...carriedNotes, ...unique].map(note => [note.noteId, publicNote(note)]));
  const visible = [...shown.values()].sort((a, b) => a.noteId.localeCompare(b.noteId));
  const id = `${round.id}-${digest([visible, status, coverage, partialReason]).slice(0, 12)}`;
  const existing = await store.get('dfp_snapshots', id);
  if (existing?.published) return existing;
  const parts = [];
  for (const [i, rows] of splitParts(visible).entries()) {
    const partId = `${id}-${i}`;
    const hash = digest(rows);
    await store.put('dfp_parts', partId, { notes: rows });
    if (digest((await store.get('dfp_parts', partId))?.notes) !== hash) throw error('CORRUPT_SNAPSHOT');
    parts.push({ id: partId, hash });
  }
  const snapshot = { id, roundId: round.id, scheduledAt: new Date(round.scheduledAt).toISOString(),
    finishedAt: new Date(time()).toISOString(), status, partialReason: partialReason || null, coverage,
    count: visible.length, boards: Object.fromEntries(['today', 'week', 'dark'].map(board => [board, visible.filter(x => x.boards.includes(board)).length])),
    parts, published: false };
  await store.transaction(async tx => {
    await assertLease(tx, lease, time());
    const current = await tx.get('dfp_snapshots', id);
    if (!current?.published) await tx.put('dfp_snapshots', id, snapshot);
  });
  // Search rows are immutable per snapshot. Shared references are committed with the manifest.
  for (const note of unique) {
    const indexId = `${id}_${note.noteId}`;
    await store.put('dfp_notes', indexId, { snapshotId: id, note: publicNote(note),
      searchText: [note.title, note.author, note.desc].map(x => typeof x === 'string' ? x : '').join('\n').toLocaleLowerCase() });
  }
  await store.transaction(async tx => {
    await assertLease(tx, lease, time());
    const current = await tx.get('dfp_rounds', round.id);
    if (current?.status !== 'running') throw error('ROUND_NOT_RUNNING');
    for (const note of unique) await tx.put('dfp_candidates', `published_${note.noteId}`, { snapshotId: id, indexId: `${id}_${note.noteId}` });
    await tx.put('dfp_snapshots', id, { ...snapshot, published: true });
    await tx.put('dfp_rounds', round.id, { ...current, status, snapshotId: id, partialReason: partialReason || null, finishedAt: snapshot.finishedAt, coverage });
    await tx.put('dfp_state', 'latest', { snapshotId: id, revision: id, scheduledAt: snapshot.scheduledAt, finishedAt: snapshot.finishedAt });
    await tx.put('dfp_state', 'status', { roundId: round.id, status, partialReason: partialReason || null, scheduledAt: snapshot.scheduledAt, finishedAt: snapshot.finishedAt });
  });
  return { ...snapshot, published: true };
}
async function storeCover({ store, upload, note, fetcher = fetch, report = () => {} }) {
  const url = imageUrl(note.coverUrl);
  if (!url) return null;
  const key = `cover_${digest(url).slice(0, 40)}`;
  const issue = (code, httpStatus = null) => { report({ code, httpStatus }); return null; };
  try {
    const cached = await store.get('dfp_state', key);
    if (typeof cached?.fileId === 'string' && cached.fileId.startsWith('cloud://')) return cached.fileId;
  } catch { issue('COVER_CACHE_READ_FAILED'); }
  let phase = 'download', httpStatus = null;
  try {
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    httpStatus = response.status;
    if (!response.ok) return issue('COVER_HTTP_ERROR', httpStatus);
    const contentType = response.headers.get('content-type') || '';
    if (!/^(?:image\/(?:jpeg|png|webp)|application\/octet-stream)(?:;|$)/i.test(contentType)) return issue('COVER_CONTENT_TYPE', httpStatus);
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) return issue('COVER_TOO_LARGE', httpStatus);
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    const ext = bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'jpg'
      : bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
      : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
    if (!ext) return issue('COVER_FORMAT', httpStatus);
    phase = 'upload';
    const result = await upload({ cloudPath: `covers/${digest(bytes)}.${ext}`, fileContent: bytes });
    if (typeof result.fileID !== 'string' || !result.fileID.startsWith('cloud://')) return issue('COVER_UPLOAD_INVALID', httpStatus);
    try { await store.put('dfp_state', key, { fileId: result.fileID }); }
    catch { issue('COVER_CACHE_WRITE_FAILED', httpStatus); }
    // A failed cache write does not invalidate an uploaded, usable cover.
    return result.fileID;
  } catch { return issue(phase === 'upload' ? 'COVER_UPLOAD_FAILED' : 'COVER_DOWNLOAD_FAILED', httpStatus); }
}

module.exports = { publicNote, splitParts, isPublished, previouslyPublished, readSnapshot, publish, storeCover };
