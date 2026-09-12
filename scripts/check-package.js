'use strict';
const fs = require('node:fs');
const path = require('node:path');
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
  ['config/rules.json', 'cloudfunctions/collectTick/config/rules.json'],
  ['config/keywords.json', 'cloudfunctions/collectTick/config/keywords.json'],
  ['cloudfunctions/collectTick/lib/store.js', 'cloudfunctions/catalog/lib/store.js'],
  ['cloudfunctions/collectTick/lib/context.js', 'cloudfunctions/catalog/lib/context.js']
]) if (!fs.readFileSync(path.join(root, a)).equals(fs.readFileSync(path.join(root, b)))) throw new Error('Run prepare:functions before deployment; generated code is stale');
const app = JSON.parse(fs.readFileSync(path.join(mini, 'app.json'), 'utf8'));
for (const page of app.pages) for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
  if (!fs.existsSync(path.join(mini, `${page}${ext}`))) throw new Error('Missing page artifact');
}
const cloud = JSON.parse(fs.readFileSync(path.join(root, 'config/cloudbaserc.example.json'), 'utf8'));
for (const fn of cloud.functions) {
  for (const file of ['index.js', 'package.json']) if (!fs.existsSync(path.join(root, cloud.functionRoot, fn.name, file))) throw new Error('Cloud function directory does not resolve from repository root');
}
console.log(JSON.stringify({ checksPassed: 6, checksFailed: 0, clientFiles: count, clientBytes: size, maxBytes: 2 * 1024 * 1024 }));
