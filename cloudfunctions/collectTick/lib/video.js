'use strict';
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile: execCallback } = require('node:child_process');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const execDefault = promisify(execCallback);
const MAX_BYTES = 32 * 1024 * 1024, FRAME_COUNT = 6, MAX_DURATION = 600000;
// One attempt may take 25 s but is abandoned after 8 s without data; alternate hosts share a 35 s download budget,
// so download, decode (25 s) and the vision request (35 s) still fit the runner's 100 s visual window.
// 2026-09-15: in one round nine downloads failed on the same CDN hosts where larger files succeeded, and the same
// files later downloaded locally at about 2 MB/s, which points to stalled connections rather than slow ones.
const ATTEMPT_TIMEOUT_MS = 25000, STALL_TIMEOUT_MS = 8000, DOWNLOAD_BUDGET_MS = 35000, MAX_ALTERNATES = 4;
const SAMPLER_VERSION = 'six-interior-1';
function fail(code, extra) { const e = new Error(code); e.code = code; Object.assign(e, extra); throw e; }
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function approvedMediaUrl(value) {
  let url; try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !/(^|\.)(xhscdn\.com|rednotecdn\.com)$/.test(url.hostname) || url.href.length > 4000) return null;
  return url.href;
}
function validateMedia(media) {
  const url = approvedMediaUrl(media?.url);
  if (!url || typeof media.identity !== 'string' || !media.identity || media.identity.length > 100) fail('VIDEO_UNAVAILABLE');
  if (Number.isFinite(media.bytes) && (media.bytes <= 0 || media.bytes > MAX_BYTES)) fail('VIDEO_TOO_LARGE');
  if (Number.isFinite(media.durationMs) && (media.durationMs <= 0 || media.durationMs > MAX_DURATION)) fail('VIDEO_TOO_LONG');
  const alternates = (Array.isArray(media.backupUrls) ? media.backupUrls : []).slice(0, MAX_ALTERNATES).map(approvedMediaUrl).filter(Boolean);
  return [...new Set([url, ...alternates])];
}
async function downloadOnce(url, file, fetcher, timeoutMs, progress, { now, stallTimeoutMs }) {
  const controller = new AbortController();
  let timer = null;
  const arm = ms => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new DOMException('stalled', 'TimeoutError')), ms); };
  const remaining = () => Math.max(1, timeoutMs - (now() - progress.startedAt));
  arm(Math.min(stallTimeoutMs, remaining()));
  let completed = false;
  try {
    const response = await fetcher(url, { redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) fail('VIDEO_DOWNLOAD_FAILED');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) fail('VIDEO_TOO_LARGE');
    await pipeline(Readable.fromWeb(response.body), async function* (chunks) {
      for await (const chunk of chunks) {
        progress.bytes += chunk.length; if (progress.bytes > MAX_BYTES) fail('VIDEO_TOO_LARGE');
        arm(Math.min(stallTimeoutMs, remaining())); yield chunk;
      }
    }, createWriteStream(file, { mode: 0o600 }));
    completed = true;
  } finally {
    clearTimeout(timer);
    // A rejected or oversized response is never read to the end; abort so the connection does not linger.
    if (!completed) controller.abort(new DOMException('abandoned', 'AbortError'));
  }
}
async function download(media, file, fetcher, { now = Date.now, stallTimeoutMs = STALL_TIMEOUT_MS } = {}) {
  const urls = validateMedia(media);
  const deadline = now() + DOWNLOAD_BUDGET_MS;
  const attempts = [];
  for (const url of urls) {
    const remaining = deadline - now();
    if (attempts.length && remaining < 5000) break;
    const progress = { bytes: 0, startedAt: now() };
    const host = new URL(url).hostname;
    try {
      await downloadOnce(url, file, fetcher, Math.min(ATTEMPT_TIMEOUT_MS, remaining), progress, { now, stallTimeoutMs });
      if (progress.bytes < 12) fail('VIDEO_INVALID_CONTAINER');
      const handle = await fs.open(file, 'r');
      try {
        const header = Buffer.alloc(12); await handle.read(header, 0, 12, 0);
        if (header.toString('ascii', 4, 8) !== 'ftyp') fail('VIDEO_INVALID_CONTAINER');
      } finally { await handle.close(); }
      attempts.push({ host, code: 'ok', bytes: progress.bytes, ms: now() - progress.startedAt });
      return { bytes: progress.bytes, attempts };
    } catch (e) {
      const final = typeof e.code === 'string' && e.code.startsWith('VIDEO_') && e.code !== 'VIDEO_DOWNLOAD_FAILED';
      const code = final ? e.code : ['TimeoutError', 'AbortError'].includes(e.name) ? 'VIDEO_DOWNLOAD_TIMEOUT' : 'VIDEO_DOWNLOAD_FAILED';
      attempts.push({ host, code, bytes: progress.bytes, ms: now() - progress.startedAt });
      await fs.rm(file, { force: true });
      // An oversized or corrupt file is the video's fault, not the host's: no alternate host is tried.
      if (final) throw Object.assign(e, { downloadAttempts: attempts });
    }
  }
  fail(attempts.some(a => a.code === 'VIDEO_DOWNLOAD_TIMEOUT') ? 'VIDEO_DOWNLOAD_TIMEOUT' : 'VIDEO_DOWNLOAD_FAILED', { downloadAttempts: attempts });
}
async function extractFrames(media, { fetcher = fetch, execFile = execDefault, tempRoot = os.tmpdir(),
  ffmpegPath = path.join(__dirname, '../bin/ffmpeg'), ffprobePath = path.join(__dirname, '../bin/ffprobe'),
  processTimeoutMs = 25000, now = Date.now, stallTimeoutMs = STALL_TIMEOUT_MS } = {}) {
  validateMedia(media);
  const directory = await fs.mkdtemp(path.join(tempRoot, 'dfp-video-'));
  await fs.chmod(directory, 0o700);
  try {
    const videoPath = path.join(directory, 'input.mp4');
    const { bytes: downloadedBytes, attempts: downloadAttempts } = await download(media, videoPath, fetcher, { now, stallTimeoutMs });
    const deadline = Date.now() + Math.min(processTimeoutMs, 25000);
    async function run(binary, args) {
      const remaining = deadline - Date.now(); if (remaining <= 0) fail('VIDEO_PROCESS_TIMEOUT');
      try { return await execFile(binary, args, { timeout: remaining, maxBuffer: 256000, killSignal: 'SIGKILL', windowsHide: true }); }
      catch (e) { fail(e.killed || e.signal ? 'VIDEO_PROCESS_TIMEOUT' : 'VIDEO_DECODE_FAILED'); }
    }
    const probe = await run(ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'mov',
      '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', videoPath]);
    let info; try { info = JSON.parse(probe.stdout); } catch { fail('VIDEO_DECODE_FAILED'); }
    const durationMs = Math.round(Number(info.format?.duration) * 1000);
    const stream = info.streams?.find(s => s.codec_type === 'video');
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION) fail('VIDEO_TOO_LONG');
    if (!stream || !Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height)
      || stream.width <= 0 || stream.height <= 0 || stream.width * stream.height > 4096 * 2160) fail('VIDEO_DIMENSIONS');
    const samples = [], images = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      const atMs = Math.round(durationMs * (i + 1) / (FRAME_COUNT + 1));
      const output = path.join(directory, `frame-${String(i + 1).padStart(2, '0')}.jpg`);
      const scale = stream.width >= stream.height ? 'scale=512:-2' : 'scale=-2:512';
      await run(ffmpegPath, ['-nostdin', '-v', 'error', '-threads', '1', '-protocol_whitelist', 'file,pipe',
        '-ss', String(atMs / 1000), '-f', 'mov', '-i', videoPath, '-an', '-frames:v', '1', '-vf', scale, '-q:v', '5', output]);
      const bytes = await fs.readFile(output);
      if (bytes.length > 512000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('VIDEO_FRAME_INVALID');
      samples.push({ index: i + 1, requestedAtMs: atMs, sha256: hash(bytes) });
      images.push(bytes);
    }
    const sheetPath = path.join(directory, 'frames.jpg');
    await run(ffmpegPath, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'image2',
      '-framerate', '1', '-i', path.join(directory, 'frame-%02d.jpg'), '-vf', 'tile=3x2', '-frames:v', '1', '-q:v', '5', sheetPath]);
    const image = await fs.readFile(sheetPath);
    if (image.length > 2 * 1024 * 1024 || image[0] !== 0xff || image[1] !== 0xd8) fail('VIDEO_FRAME_INVALID');
    return { image, images, imageHash: hash(image), frameCount: FRAME_COUNT, samples, durationMs,
      downloadedBytes, downloadAttempts, samplerVersion: SAMPLER_VERSION, mediaIdentity: media.identity };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
module.exports = { extractFrames, validateMedia, MAX_BYTES, MAX_DURATION, FRAME_COUNT, SAMPLER_VERSION, ATTEMPT_TIMEOUT_MS, STALL_TIMEOUT_MS, DOWNLOAD_BUDGET_MS };
