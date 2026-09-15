'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { extractFrames, MAX_BYTES } = require('../cloudfunctions/collectTick/lib/video');
const media = { url: 'https://sns-video-v1.xhscdn.com/stream/fixture.mp4', identity: 'video-v1', durationMs: 34000, bytes: 128 };
const movie = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(100)]);
async function sandbox(fn) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dfp-test-')); try { await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); } }
function decoder(log, duration = 34) {
  return async (binary, args, options) => {
    log.push({ binary, args, options });
    if (binary.endsWith('ffprobe')) return { stdout: JSON.stringify({ format: { duration }, streams: [{ codec_type: 'video', width: 720, height: 1280 }] }) };
    await fs.writeFile(args.at(-1), Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(100), Buffer.from([0xff, 0xd9])]));
    return { stdout: '' };
  };
}
test('six bounded ordered samples are extracted with local-only decoder input and cleaned up', async () => sandbox(async root => {
  const calls = [];
  const result = await extractFrames(media, { tempRoot: root, fetcher: async () => new Response(movie), execFile: decoder(calls) });
  assert.equal(result.frameCount, 6); assert.equal(result.samples.length, 6);
  assert.ok(result.samples.every((s, i, a) => i === 0 || s.requestedAtMs > a[i - 1].requestedAtMs));
  assert.ok(calls.every(c => c.args.includes('file,pipe') && c.options.timeout <= 25000));
  assert.equal(calls.filter(c => c.args.includes('-ss')).length, 6);
  assert.deepEqual(await fs.readdir(root), []);
}));
test('unapproved hosts, ports, excessive metadata and non-MP4 content do not reach the decoder', async () => sandbox(async root => {
  let downloads = 0, processes = 0;
  const options = { tempRoot: root, fetcher: async () => { downloads++; return new Response('not an mp4 video'); }, execFile: async () => { processes++; } };
  for (const patch of [{ url: 'https://127.0.0.1/a' }, { url: 'https://xhscdn.com.evil.test/a' },
    { url: 'https://sns-video-v1.xhscdn.com:444/a' }, { bytes: MAX_BYTES + 1 }, { durationMs: 600001 }])
    await assert.rejects(() => extractFrames({ ...media, ...patch }, options));
  assert.equal(downloads, 0);
  await assert.rejects(() => extractFrames(media, options), /VIDEO_INVALID_CONTAINER/);
  assert.equal(processes, 0); assert.deepEqual(await fs.readdir(root), []);
}));
test('response size, actual duration and failed decoding stop without leaving temporary media', async () => sandbox(async root => {
  await assert.rejects(() => extractFrames(media, { tempRoot: root, fetcher: async () => new Response(movie, { headers: { 'content-length': String(MAX_BYTES + 1) } }) }), /VIDEO_TOO_LARGE/);
  await assert.rejects(() => extractFrames(media, { tempRoot: root, fetcher: async () => new Response(movie), execFile: decoder([], 700) }), /VIDEO_TOO_LONG/);
  await assert.rejects(() => extractFrames(media, { tempRoot: root, fetcher: async () => new Response(movie), execFile: async () => { throw Object.assign(Error(), { killed: true }); } }), /VIDEO_PROCESS_TIMEOUT/);
  assert.deepEqual(await fs.readdir(root), []);
}));
test('download timeouts are reported as video failures, without invoking a model or decoder',async()=>sandbox(async root=>{
 let processes=0;await assert.rejects(extractFrames(media,{tempRoot:root,fetcher:async()=>{throw new DOMException('sample timeout','TimeoutError');},execFile:async()=>{processes++;}}),/VIDEO_DOWNLOAD_TIMEOUT/);assert.equal(processes,0);assert.deepEqual(await fs.readdir(root),[]);
}));
