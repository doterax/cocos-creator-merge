#!/usr/bin/env node
// Show ONLY real content conflicts (not __id__ reference fields)
// and display actual values for manual inspection

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '00_prefab');
const BASE = JSON.parse(fs.readFileSync(path.join(DIR, 'base.prefab'), 'utf8'));
const MINE = JSON.parse(fs.readFileSync(path.join(DIR, 'mine.prefab'), 'utf8'));
const THEIRS = JSON.parse(fs.readFileSync(path.join(DIR, 'theirs.prefab'), 'utf8'));

// Fields that are purely __id__ index references — changes are false positives
const ID_REF_FIELDS = new Set([
  'node', '__prefab', '_prefab', '_parent', '_children', '_components',
  'data', 'scene', 'root', 'target', 'customDataOverride',
  '_globals', '_content', '_scrollBar', '_horizontalScrollBar',
]);

function isIdRefValue(v) {
  if (v === null) return true;
  if (typeof v === 'object' && !Array.isArray(v) && '__id__' in v) return true;
  // Array of __id__ refs
  if (Array.isArray(v) && v.every(e => e && typeof e === 'object' && '__id__' in e)) return true;
  return false;
}

function isIdRefField(key, val) {
  return ID_REF_FIELDS.has(key) || isIdRefValue(val);
}

// ── stable ID map (same as analyze.js) ────────────────────────────────────
function buildIDMap(arr) {
  const indexToID = new Map();
  const idToIndex = new Map();

  for (let i = 0; i < arr.length; i++) {
    const obj = arr[i];
    if (!obj || typeof obj !== 'object') continue;
    const id = obj._id;
    if (id && typeof id === 'string' && id.length > 0) {
      indexToID.set(i, id);
      idToIndex.set(id, i);
    }
  }

  for (let i = 0; i < arr.length; i++) {
    const obj = arr[i];
    if (!obj) continue;
    const t = obj.__type__;
    if (t === 'cc.PrefabInfo' || t === 'cc.CompPrefabInfo') {
      const fileId = obj.fileId;
      if (!fileId) continue;
      for (let j = 0; j < arr.length; j++) {
        if (indexToID.has(j)) continue;
        const owner = arr[j];
        if (!owner) continue;
        if (owner._prefab && owner._prefab.__id__ === i) {
          indexToID.set(j, fileId);
          idToIndex.set(fileId, j);
          break;
        }
        if (owner.__prefab && owner.__prefab.__id__ === i) {
          indexToID.set(j, fileId);
          idToIndex.set(fileId, j);
          break;
        }
      }
    }
  }

  for (let i = 0; i < arr.length; i++) {
    if (indexToID.has(i)) continue;
    const obj = arr[i];
    if (!obj || typeof obj !== 'object') continue;
    const t = obj.__type__;
    if (!t) continue;
    const sameType = arr.filter(o => o && o.__type__ === t);
    if (sameType.length === 1) {
      indexToID.set(i, `singleton_${t}`);
      idToIndex.set(`singleton_${t}`, i);
    }
  }

  return { indexToID, idToIndex };
}

// ── find real conflicts ────────────────────────────────────────────────────
const baseMap = buildIDMap(BASE);
const mineMap = buildIDMap(MINE);
const theirsMap = buildIDMap(THEIRS);

const realConflicts = [];
const idRefOnlyConflicts = [];

for (const [baseIdx, id] of baseMap.indexToID) {
  const mineIdx = mineMap.idToIndex.get(id);
  const theirsIdx = theirsMap.idToIndex.get(id);
  if (mineIdx === undefined || theirsIdx === undefined) continue;

  const baseObj = BASE[baseIdx];
  const mineObj = MINE[mineIdx];
  const theirsObj = THEIRS[theirsIdx];

  const allKeys = new Set([...Object.keys(baseObj), ...Object.keys(mineObj), ...Object.keys(theirsObj)]);
  const trueConflictKeys = [];
  const idRefConflictKeys = [];

  for (const k of allKeys) {
    if (k === '__editorExtras__') continue;
    const bv = baseObj[k];
    const mv = mineObj[k];
    const tv = theirsObj[k];
    const mChanged = JSON.stringify(mv) !== JSON.stringify(bv);
    const tChanged = JSON.stringify(tv) !== JSON.stringify(bv);
    const bothChanged = mChanged && tChanged && JSON.stringify(mv) !== JSON.stringify(tv);
    if (!bothChanged) continue;

    if (isIdRefField(k, bv) || isIdRefField(k, mv) || isIdRefField(k, tv)) {
      idRefConflictKeys.push(k);
    } else {
      trueConflictKeys.push({ key: k, base: bv, mine: mv, theirs: tv });
    }
  }

  if (trueConflictKeys.length > 0) {
    realConflicts.push({ id, type: baseObj.__type__, keys: trueConflictKeys, idRefKeys: idRefConflictKeys });
  } else if (idRefConflictKeys.length > 0) {
    idRefOnlyConflicts.push({ id, type: baseObj.__type__, idRefKeys: idRefConflictKeys });
  }
}

console.log('Real Content Conflicts (excluding __id__ index reference fields)');
console.log('═'.repeat(70));
console.log(`True content conflicts: ${realConflicts.length}`);
console.log(`__id__-ref-only conflicts (false positives): ${idRefOnlyConflicts.length}`);

if (realConflicts.length === 0) {
  console.log('\nNo real content conflicts — all conflicts are __id__ index shifts!');
} else {
  console.log('\n── Real Conflicts ──\n');
  for (const c of realConflicts) {
    console.log(`${c.type}  id=${c.id}`);
    if (c.idRefKeys.length) console.log(`  (also has __id__-ref conflicts: [${c.idRefKeys.join(', ')}])`);
    for (const { key, base, mine, theirs } of c.keys) {
      console.log(`  key: "${key}"`);
      console.log(`    BASE:   ${JSON.stringify(base).slice(0, 200)}`);
      console.log(`    MINE:   ${JSON.stringify(mine).slice(0, 200)}`);
      console.log(`    THEIRS: ${JSON.stringify(theirs).slice(0, 200)}`);
    }
    console.log();
  }
}

console.log('\n── __id__-ref-only conflicts (will be resolved by UUID conversion) ──');
for (const c of idRefOnlyConflicts.slice(0, 20)) {
  console.log(`  ${c.type}  id=${c.id}  keys=[${c.idRefKeys.join(', ')}]`);
}
if (idRefOnlyConflicts.length > 20) console.log(`  ... and ${idRefOnlyConflicts.length - 20} more`);
