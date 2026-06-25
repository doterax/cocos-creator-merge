#!/usr/bin/env node
// Show first N objects of a given __type__ from a prefab file
// Usage: node test/inspect-types.js base.prefab cc.PrefabInstance 3

const fs   = require('fs');
const path = require('path');

const [,, file, type, count] = process.argv;
const n = parseInt(count) || 3;

const arr = JSON.parse(fs.readFileSync(path.join(__dirname, '00_prefab', file), 'utf8'));

let shown = 0;
for (let i = 0; i < arr.length && shown < n; i++) {
  const o = arr[i];
  if (!o || o.__type__ !== type) continue;
  console.log(`\n[${i}] ${type}:`);
  console.log(JSON.stringify(o, null, 2));
  shown++;
}
if (!shown) console.log(`No objects of type "${type}" found`);
