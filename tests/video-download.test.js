'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { extractFrames, validateMedia, DOWNLOAD_BUDGET_MS } = require('../cloudfunctions/collectTick/lib/video');
const { normalizeNote } = require('../cloudfunctions/collectTick/lib/provider');
const movie = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(100)]);
const media = { url: 'https://sns-video-v11.xhscdn.com/stream/a.mp4', identity: 'video-a', durationMs: 34000, bytes: 128,
  backupUrls: ['https://sns-bak-v8.xhscdn.com/stream/a.mp4', 'https://evil.test/stream/a.mp4', 'https://sns-bak-v10.xhscdn.com/stream/a.mp4'] };
async function sandbox(fn) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dfp-test-')); try { await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); } }
const decoder = async (binary, args) => {
  if (binary.endsWith('ffprobe')) return { stdout: JSON.stringify({ format: { duration: 34 }, streams: [{ codec_type: 'video', width: 720, height: 1280 }] }) };
  await fs.writeFile(args.at(-1), Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(100), Buffer.from([0xff, 0xd9])]));
  return { stdout: '' };
};
const timeout = () => { throw new DOMException('stalled', 'TimeoutError'); };

test('only approved alternate hosts are kept, in order, without duplicates', () => {
  assert.deepEqual(validateMedia(media), ['https://sns-video-v11.xhscdn.com/stream/a.mp4', 'https://sns-bak-v8.xhscdn.com/stream/a.mp4', 'https://sns-bak-v10.xhscdn.com/stream/a.mp4']);
  assert.deepEqual(validateMedia({ ...media, backupUrls: [media.url] }), [media.url]);
  assert.deepEqual(validateMedia({ ...media, backupUrls: undefined }), [media.url]);
});

test('a stalled primary host falls back to an alternate host and records every attempt', async () => sandbox(async root => {
  const hosts = [];
  const fetcher = async url => { hosts.push(new URL(url).hostname); if (hosts.length === 1) timeout(); return new Response(movie); };
  const result = await extractFrames(media, { tempRoot: root, fetcher, execFile: decoder });
  assert.equal(result.frameCount, 6);
  assert.deepEqual(hosts, ['sns-video-v11.xhscdn.com', 'sns-bak-v8.xhscdn.com']);
  assert.deepEqual(result.downloadAttempts.map(a => [a.host, a.code]), [['sns-video-v11.xhscdn.com', 'VIDEO_DOWNLOAD_TIMEOUT'], ['sns-bak-v8.xhscdn.com', 'ok']]);
  assert.equal(result.downloadAttempts[1].bytes, movie.length);
  assert.deepEqual(await fs.readdir(root), []);
}));

test('when every host stalls the failure names the timeout and carries per-host diagnostics only', async () => sandbox(async root => {
  let downloads = 0;
  const error = await extractFrames(media, { tempRoot: root, fetcher: async () => { downloads++; timeout(); }, execFile: async () => assert.fail('no decode') })
    .then(() => assert.fail('expected failure'), e => e);
  assert.equal(error.code, 'VIDEO_DOWNLOAD_TIMEOUT'); assert.equal(downloads, 3);
  assert.deepEqual(error.downloadAttempts.map(a => a.code), ['VIDEO_DOWNLOAD_TIMEOUT', 'VIDEO_DOWNLOAD_TIMEOUT', 'VIDEO_DOWNLOAD_TIMEOUT']);
  assert.ok(error.downloadAttempts.every(a => Object.keys(a).sort().join() === 'bytes,code,host,ms'));
  assert.deepEqual(await fs.readdir(root), []);
}));

test('a rejected primary response is retried elsewhere, but an oversized or corrupt file is not', async () => sandbox(async root => {
  let downloads = 0; const signals = [];
  const result = await extractFrames(media, { tempRoot: root, execFile: decoder,
    fetcher: async (url, options) => { downloads++; signals.push(options.signal); return downloads === 1 ? new Response('', { status: 403 }) : new Response(movie); } });
  assert.equal(result.downloadAttempts[0].code, 'VIDEO_DOWNLOAD_FAILED'); assert.equal(downloads, 2);
  // The unread 403 response is abandoned explicitly so its connection does not linger; the good one is left alone.
  assert.deepEqual(signals.map(s => s.aborted), [true, false]);
  downloads = 0;
  const corrupt = await extractFrames(media, { tempRoot: root, fetcher: async () => { downloads++; return new Response('not an mp4 video'); } }).then(() => assert.fail('expected failure'), e => e);
  assert.equal(corrupt.code, 'VIDEO_INVALID_CONTAINER'); assert.equal(downloads, 1);
  assert.deepEqual(corrupt.downloadAttempts.map(a => a.code), ['VIDEO_INVALID_CONTAINER']);
  downloads = 0; signals.length = 0;
  const large = await extractFrames(media, { tempRoot: root, fetcher: async (url, options) => { downloads++; signals.push(options.signal); return new Response(movie, { headers: { 'content-length': String(64 * 1024 * 1024) } }); } }).then(() => assert.fail('expected failure'), e => e);
  assert.equal(large.code, 'VIDEO_TOO_LARGE'); assert.equal(downloads, 1);
  assert.deepEqual(large.downloadAttempts.map(a => [a.host, a.code]), [['sns-video-v11.xhscdn.com', 'VIDEO_TOO_LARGE']]);
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(await fs.readdir(root), []);
}));

test('alternate hosts share one download budget that still fits the runner visual window', async () => sandbox(async root => {
  // Download, decode (25 s) and the vision request (35 s) must fit the 100 s the runner reserves before a visual review.
  assert.ok(DOWNLOAD_BUDGET_MS + 25000 + 35000 <= 100000);
  let clock = 0, downloads = 0;
  const spent = await extractFrames(media, { tempRoot: root, now: () => clock,
    fetcher: async () => { downloads++; clock += 31000; timeout(); } }).then(() => assert.fail('expected failure'), e => e);
  assert.equal(spent.code, 'VIDEO_DOWNLOAD_TIMEOUT'); assert.equal(downloads, 1);
  clock = 0; downloads = 0;
  await assert.rejects(() => extractFrames(media, { tempRoot: root, now: () => clock,
    fetcher: async () => { downloads++; clock += 8000; timeout(); } }), /VIDEO_DOWNLOAD_TIMEOUT/);
  assert.equal(downloads, 3);
  assert.deepEqual(await fs.readdir(root), []);
}));

test('a real HTTP body that stops sending is abandoned by the stall timer and the next host is used', async () => sandbox(async root => {
  const http = require('node:http');
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'video/mp4' });
    if (req.url === '/stall') { res.write(movie.subarray(0, 20)); return; }
    res.end(movie);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const fetcher = (url, options) => fetch(`http://127.0.0.1:${port}${new URL(url).hostname.startsWith('sns-video') ? '/stall' : '/ok'}`, options);
    const started = Date.now();
    const result = await extractFrames(media, { tempRoot: root, fetcher, execFile: decoder, stallTimeoutMs: 1000 });
    assert.deepEqual(result.downloadAttempts.map(a => a.code), ['VIDEO_DOWNLOAD_TIMEOUT', 'ok']);
    assert.ok(result.downloadAttempts[0].bytes < movie.length); assert.equal(result.downloadAttempts[1].bytes, movie.length);
    assert.ok(Date.now() - started < 8000);
    assert.equal(requests, 2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));

test('normalized video media keeps approved backup hosts and the next rendition as alternates', () => {
  const raw = { id: '1'.repeat(24), user: { userid: '2'.repeat(24) }, type: 'video', title: 't', desc: 'd', liked_count: 10,
    video_info_v2: { media: { video: { duration: 30, md5: 'a'.repeat(32) }, stream: {
      h265: [{ master_url: 'http://sns-video-v28.xhscdn.com/stream/1/hd', size: 3000000, backup_urls: ['http://sns-bak-v8.xhscdn.com/stream/1/hd', 'https://evil.test/1', 'http://sns-bak-v8.xhscdn.com/stream/1/hd'] },
        { master_url: 'http://sns-video-v28.xhscdn.com/stream/1/fhd', size: 5000000, backup_urls: [] }],
      h264: [{ master_url: 'http://sns-video-v28.xhscdn.com/stream/1/h264', size: 11000000 }] } } } };
  const note = normalizeNote(raw, { source: 'search' });
  assert.equal(note.media.url, 'https://sns-video-v28.xhscdn.com/stream/1/hd');
  assert.deepEqual(note.media.backupUrls, ['https://sns-bak-v8.xhscdn.com/stream/1/hd', 'https://sns-video-v28.xhscdn.com/stream/1/fhd']);
  assert.equal(note.media.bytes, 3000000);
  const bare = normalizeNote({ ...raw, video_info_v2: { media: { video: { duration: 30 }, stream: { h264: [{ master_url: 'http://sns-video-v28.xhscdn.com/stream/1/only', size: 100 }] } } } }, { source: 'search' });
  assert.equal('backupUrls' in bare.media, false);
});
