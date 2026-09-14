'use strict';
const fs = require('node:fs'); const path = require('node:path'); const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..'); const manifest = require('../config/media-decoder.json');
const from = path.resolve(process.argv[2] || path.join(root, '.local/media-layer'));
const to = path.join(root, 'cloudfunctions/collectTick/bin');
for (const [name, expected] of Object.entries(manifest.binaries)) {
 const bytes = fs.readFileSync(path.join(from, 'bin', name));
 if (createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('Unreviewed media binary; verify its build before changing the manifest');
 if (!bytes.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46])) || bytes.readUInt16LE(18) !== 62) throw Error('Expected Linux x86_64 ELF binary');
}
if (!fs.readFileSync(path.join(from,'source.sha256'),'utf8').startsWith(manifest.sourceSha256+' ')) throw Error('Source checksum mismatch');
fs.mkdirSync(to,{recursive:true});
for (const name of Object.keys(manifest.binaries)) { fs.copyFileSync(path.join(from,'bin',name),path.join(to,name));fs.chmodSync(path.join(to,name),0o755); }
for (const name of ['COPYING.LGPLv2.1','LICENSE.md']) fs.copyFileSync(path.join(from,'licenses',name),path.join(to,name));
fs.copyFileSync(path.join(root,'config/media-decoder.json'),path.join(to,'manifest.json'));
console.log(JSON.stringify({binariesPrepared:2,platform:manifest.platform,version:manifest.version}));
