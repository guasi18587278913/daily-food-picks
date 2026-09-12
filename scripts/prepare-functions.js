'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const copies = [
  ['config/rules.json', 'cloudfunctions/collectTick/config/rules.json'],
  ['config/keywords.json', 'cloudfunctions/collectTick/config/keywords.json'],
  ['cloudfunctions/collectTick/lib/store.js', 'cloudfunctions/catalog/lib/store.js'],
  ['cloudfunctions/collectTick/lib/context.js', 'cloudfunctions/catalog/lib/context.js']
];
for (const [source, target] of copies) {
  const bytes = fs.readFileSync(path.join(root, source));
  const destination = path.join(root, target);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
}
console.log(`Prepared ${copies.length} deployment copies.`);
