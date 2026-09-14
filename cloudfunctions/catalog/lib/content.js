'use strict';

const NOTE_ID = /^[a-f0-9]{24}$/;
const ROUND_ID = /^\d{8}-\d{4}$/;
function sourceMediaUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
      || url.href.length > 4000 || !/(^|\.)(xhscdn\.com|rednotecdn\.com|xiaohongshu\.com)$/.test(url.hostname)) return null;
    url.protocol = 'https:';
    return url.href;
  } catch { return null; }
}
// Only callers that already proved publication may resolve the server-owned candidate key.
async function capturedNote(store, publishedNote) {
  const { noteId, authorId, firstRoundId } = publishedNote;
  if (!NOTE_ID.test(noteId || '') || !NOTE_ID.test(authorId || '') || !ROUND_ID.test(firstRoundId || '')) return null;
  const row = await store.get('dfp_candidates', `${firstRoundId}_${noteId}`);
  if (row?.roundId !== firstRoundId || row.stage !== 'done' || row.note?.noteId !== noteId
    || row.note.authorId !== authorId || row.note.type !== publishedNote.type) return null;
  return row.note;
}
function contentFor(note) {
  if (!note) return { status: 'missing', desc: '', bodyComplete: false, images: [], imageCount: null,
    imagesComplete: false, videoUrl: null, capturedAt: null };
  const desc = typeof note.desc === 'string' ? note.desc.slice(0, 12000) : '';
  const images = [...new Set((Array.isArray(note.images) ? note.images : []).slice(0, 20).map(sourceMediaUrl).filter(Boolean))];
  const imageCount = Number.isSafeInteger(note.imageCount) && note.imageCount >= 0 ? note.imageCount : null;
  const capturedAt = typeof note.fetchedAt === 'string' && Number.isFinite(Date.parse(note.fetchedAt)) ? note.fetchedAt : null;
  return { status: 'available', desc, bodyComplete: note.bodyComplete === true && note.desc === desc,
    images, imageCount, imagesComplete: note.imagesComplete === true && imageCount === images.length,
    videoUrl: note.type === 'video' ? sourceMediaUrl(note.media?.url) : null, capturedAt };
}
module.exports = { capturedNote, contentFor, sourceMediaUrl };
