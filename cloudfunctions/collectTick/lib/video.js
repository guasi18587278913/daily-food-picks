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
const SAMPLER_VERSION = 'six-interior-1';
function fail(code) { const e = new Error(code); e.code = code; throw e; }
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function validateMedia(media) {
  let url; try { url = new URL(media?.url); } catch { fail('VIDEO_UNAVAILABLE'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !/(^|\.)(xhscdn\.com|rednotecdn\.com)$/.test(url.hostname) || url.href.length > 4000
    || typeof media.identity !== 'string' || !media.identity || media.identity.length > 100) fail('VIDEO_UNAVAILABLE');
  if (Number.isFinite(media.bytes) && (media.bytes <= 0 || media.bytes > MAX_BYTES)) fail('VIDEO_TOO_LARGE');
  if (Number.isFinite(media.durationMs) && (media.durationMs <= 0 || media.durationMs > MAX_DURATION)) fail('VIDEO_TOO_LONG');
  return url.href;
}
async function download(media, file, fetcher) {
  const url = validateMedia(media);
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(25000) });
  if (!response.ok || !response.body) fail('VIDEO_DOWNLOAD_FAILED');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) fail('VIDEO_TOO_LARGE');
  let bytes = 0;
  await pipeline(Readable.fromWeb(response.body), async function* (chunks) {
    for await (const chunk of chunks) { bytes += chunk.length; if (bytes > MAX_BYTES) fail('VIDEO_TOO_LARGE'); yield chunk; }
  }, createWriteStream(file, { mode: 0o600 }));
  if (bytes < 12) fail('VIDEO_INVALID_CONTAINER');
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(12); await handle.read(header, 0, 12, 0);
    if (header.toString('ascii', 4, 8) !== 'ftyp') fail('VIDEO_INVALID_CONTAINER');
  } finally { await handle.close(); }
  return bytes;
}
async function extractFrames(media, { fetcher = fetch, execFile = execDefault, tempRoot = os.tmpdir(),
  ffmpegPath = path.join(__dirname, '../bin/ffmpeg'), ffprobePath = path.join(__dirname, '../bin/ffprobe'),
  processTimeoutMs = 25000 } = {}) {
  validateMedia(media);
  const directory = await fs.mkdtemp(path.join(tempRoot, 'dfp-video-'));
  await fs.chmod(directory, 0o700);
  try {
    const videoPath = path.join(directory, 'input.mp4');
    let downloadedBytes;
    try { downloadedBytes = await download(media, videoPath, fetcher); }
    catch (e) {
      if (typeof e.code === 'string' && e.code.startsWith('VIDEO_')) throw e;
      fail(['TimeoutError', 'AbortError'].includes(e.name) ? 'VIDEO_DOWNLOAD_TIMEOUT' : 'VIDEO_DOWNLOAD_FAILED');
    }
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
      downloadedBytes, samplerVersion: SAMPLER_VERSION, mediaIdentity: media.identity };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
module.exports = { extractFrames, validateMedia, MAX_BYTES, MAX_DURATION, FRAME_COUNT, SAMPLER_VERSION };
