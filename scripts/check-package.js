'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const mini = path.join(root, 'miniprogram');
let count = 0; let size = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Client bundle cannot contain symbolic links');
    if (entry.isDirectory()) { walk(file); continue; }
    if (/\.pem$|\.key$|\.env|\.local\./i.test(entry.name)) throw new Error('Private configuration found in client bundle');
    const content = fs.readFileSync(file); size += content.length; count++;
    if (/\.(js|json|wxml|wxss|ts)$/.test(entry.name)) {
      const text = content.toString('utf8');
      if (/PRIVATE KEY|DFP_TIKHUB_KEY|TENCENTCLOUD_SECRET|Bearer\s+[a-zA-Z0-9_-]{20,}/.test(text)) throw new Error('Server-only credential material found in client bundle');
      if (/name\s*:\s*['"]collectTick['"]/.test(text)) throw new Error('Client must not invoke collector');
    }
  }
}
walk(mini);
if (size >= 2 * 1024 * 1024) throw new Error('Mini program exceeds the 2 MiB main-package budget');
for (const [a, b] of [
  ['shared/author-navigation.js', 'miniprogram/lib/author-navigation.js'],
  ['shared/author-navigation.js', 'cloudfunctions/catalog/lib/author-navigation.js'],
  ['shared/author-navigation.js', 'cloudfunctions/collectTick/lib/author-navigation.js'],
  ['shared/source-navigation.js', 'miniprogram/lib/source-navigation.js'],
  ['shared/source-navigation.js', 'cloudfunctions/catalog/lib/source-navigation.js'],
  ['config/rules.json', 'cloudfunctions/collectTick/config/rules.json'],
  ['config/keywords.json', 'cloudfunctions/collectTick/config/keywords.json'],
  ['config/discovery.json', 'cloudfunctions/collectTick/config/discovery.json'],
  ['cloudfunctions/collectTick/lib/store.js', 'cloudfunctions/catalog/lib/store.js'],
  ['cloudfunctions/collectTick/lib/context.js', 'cloudfunctions/catalog/lib/context.js'],
  ['cloudfunctions/collectTick/lib/store.js', 'cloudfunctions/account/lib/store.js'],
  ['cloudfunctions/collectTick/lib/context.js', 'cloudfunctions/account/lib/context.js'],
  ['cloudfunctions/account/lib/users.js', 'cloudfunctions/catalog/lib/users.js'],
  ['cloudfunctions/account/lib/access.js', 'cloudfunctions/catalog/lib/access.js']
]) if (!fs.readFileSync(path.join(root, a)).equals(fs.readFileSync(path.join(root, b)))) throw new Error('Run prepare:functions before deployment; generated code is stale');
const app = JSON.parse(fs.readFileSync(path.join(mini, 'app.json'), 'utf8'));
for (const page of app.pages) for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
  if (!fs.existsSync(path.join(mini, `${page}${ext}`))) throw new Error('Missing page artifact');
}
const cloud = JSON.parse(fs.readFileSync(path.join(root, 'config/cloudbaserc.example.json'), 'utf8'));
for (const fn of cloud.functions) {
  for (const file of ['index.js', 'package.json']) if (!fs.existsSync(path.join(root, cloud.functionRoot, fn.name, file))) throw new Error('Cloud function directory does not resolve from repository root');
}
const media = require('../config/media-decoder.json');
let mediaBytes = 0;
const mediaDirectory = path.join(root, 'cloudfunctions/collectTick/bin');
const validateMedia = process.argv.includes('--with-vision') || fs.existsSync(mediaDirectory);
if (validateMedia) for (const [name, hash] of Object.entries(media.binaries)) {
  const file = path.join(root, 'cloudfunctions/collectTick/bin', name), bytes = fs.readFileSync(file);
  if (createHash('sha256').update(bytes).digest('hex') !== hash || !(fs.statSync(file).mode & 0o111)) throw Error('Missing or unverified Linux decoder; run prepare-media.js');
  mediaBytes += bytes.length;
}
if (validateMedia) {
  for (const name of ['COPYING.LGPLv2.1', 'LICENSE.md', 'manifest.json']) if (!fs.existsSync(path.join(mediaDirectory, name))) throw Error('Missing media license or manifest');
  if (!fs.readFileSync(path.join(mediaDirectory, 'manifest.json')).equals(fs.readFileSync(path.join(root, 'config/media-decoder.json')))) throw Error('Stale media manifest');
}
if (mediaBytes > 12 * 1024 * 1024) throw Error('Media dependency exceeds package allocation');
console.log(JSON.stringify({ checksPassed: validateMedia ? 12 : 10, checksFailed: 0, clientFiles: count, clientBytes: size, mediaBytes,
  visualPackageVerified: validateMedia, maxBytes: 2 * 1024 * 1024 }));
