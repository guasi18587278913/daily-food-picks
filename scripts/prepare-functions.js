'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const copies = [
  ['shared/author-navigation.js', 'miniprogram/lib/author-navigation.js'],
  ['shared/author-navigation.js', 'cloudfunctions/catalog/lib/author-navigation.js'],
  ['shared/author-navigation.js', 'cloudfunctions/collectTick/lib/author-navigation.js'],
  ['shared/source-navigation.js', 'miniprogram/lib/source-navigation.js'],
  ['shared/source-navigation.js', 'cloudfunctions/catalog/lib/source-navigation.js'],
  ['config/rules.json', 'cloudfunctions/collectTick/config/rules.json'],
  ['config/keywords/food.json', 'cloudfunctions/collectTick/config/keywords/food.json'],
  ['config/keywords/fde.json', 'cloudfunctions/collectTick/config/keywords/fde.json'],
  ['config/discovery.json', 'cloudfunctions/collectTick/config/discovery.json'],
  ['cloudfunctions/collectTick/lib/store.js', 'cloudfunctions/catalog/lib/store.js'],
  ['cloudfunctions/collectTick/lib/context.js', 'cloudfunctions/catalog/lib/context.js'],
  ['cloudfunctions/collectTick/lib/store.js', 'cloudfunctions/account/lib/store.js'],
  ['cloudfunctions/collectTick/lib/context.js', 'cloudfunctions/account/lib/context.js'],
  ['cloudfunctions/account/lib/users.js', 'cloudfunctions/catalog/lib/users.js'],
  ['cloudfunctions/account/lib/access.js', 'cloudfunctions/catalog/lib/access.js']
];
for (const [source, target] of copies) {
  const bytes = fs.readFileSync(path.join(root, source));
  const destination = path.join(root, target);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
}
console.log(`Prepared ${copies.length} deployment copies.`);
