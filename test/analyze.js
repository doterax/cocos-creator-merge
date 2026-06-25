#!/usr/bin/env node
// Analyze BASE/MINE/THEIRS prefab files and show object-level diffs
// Usage: node analyze.js

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '00_prefab');
const BASE = JSON.parse(fs.readFileSync(path.join(DIR, 'base.prefab'), 'utf8'));
const MINE = JSON.parse(fs.readFileSync(path.join(DIR, 'mine.prefab'), 'utf8'));
const THEIRS = JSON.parse(fs.readFileSync(path.join(DIR, 'theirs.prefab'), 'utf8'));

// ── version detection ──────────────────────────────────────────────────────
function detectVersion(arr) {
  const root = arr[0];
  if (!root) return 'unknown';
  const t = root.__type__ || '';
  if (t === 'cc.SceneAsset') return 'CC2.x';
  if (t === 'cc.Prefab') {
    // CC3.8 prefabs have __editorExtras__ on objects
    const hasEditorExtras = arr.some(o => o && '__editorExtras__' in o);
    return hasEditorExtras ? 'CC3.8' : 'CC2.4';
  }
  return 'unknown';
}

// ── stable ID resolution ───────────────────────────────────────────────────
// Returns a stable string ID for each array entry, or null if unresolvable
function buildIDMap(arr) {
  const indexToID = new Map();  // index → stableID
  const idToIndex = new Map();  // stableID → index

  // Pass 1: objects with non-empty _id (scenes: nodes and components)
  for (let i = 0; i < arr.length; i++) {
    const obj = arr[i];
    if (!obj || typeof obj !== 'object') continue;
    const id = obj._id;
    if (id && typeof id === 'string' && id.length > 0) {
      indexToID.set(i, id);
      idToIndex.set(id, i);
    }
  }

  // Pass 2: cc.PrefabInfo / cc.CompPrefabInfo → gives fileId to their owner
  for (let i = 0; i < arr.length; i++) {
    const obj = arr[i];
    if (!obj) continue;
    const t = obj.__type__;

    if (t === 'cc.PrefabInfo' || t === 'cc.CompPrefabInfo') {
      const fileId = obj.fileId;
      if (!fileId) continue; // root node's PrefabInfo has fileId: ""

      // Find who points to this PrefabInfo
      for (let j = 0; j < arr.length; j++) {
        if (indexToID.has(j)) continue; // already resolved
        const owner = arr[j];
        if (!owner) continue;
        // Node pointing via _prefab.__id__ (CC2.4/CC3.8 nodes in prefabs)
        if (owner._prefab && owner._prefab.__id__ === i) {
          indexToID.set(j, fileId);
          idToIndex.set(fileId, j);
          break;
        }
        // Component pointing via __prefab.__id__ (CC3.8 components in prefabs)
        if (owner.__prefab && owner.__prefab.__id__ === i) {
          const nodeIdx = resolveNodeOfComponent(arr, j);
          const nodeID = nodeIdx !== null ? indexToID.get(nodeIdx) : null;
          const compID = nodeID
            ? `${fileId}`  // cc.CompPrefabInfo.fileId is already unique
            : `comp_${fileId}`;
          indexToID.set(j, compID);
          idToIndex.set(compID, j);
          break;
        }
      }
      // Also give the PrefabInfo itself an ID so it's trackable
      const ownerID = [...indexToID.entries()].find(([idx]) => {
        const o = arr[idx];
        return o && (
          (o._prefab && o._prefab.__id__ === i) ||
          (o.__prefab && o.__prefab.__id__ === i)
        );
      });
      if (ownerID) {
        indexToID.set(i, `prefabinfo_${ownerID[1]}`);
      }
    }
  }

  // Pass 3: CC2.4 components with empty _id — derive from node + __type__
  for (let i = 0; i < arr.length; i++) {
    if (indexToID.has(i)) continue;
    const obj = arr[i];
    if (!obj || typeof obj !== 'object') continue;
    const t = obj.__type__;
    if (!t) continue;

    // Find node that has this component in _components
    const nodeIdx = resolveNodeOfComponent(arr, i);
    if (nodeIdx !== null) {
      const nodeID = indexToID.get(nodeIdx);
      if (nodeID) {
        const derived = `${nodeID}#${t}`;
        indexToID.set(i, derived);
        idToIndex.set(derived, i);
      }
    }
  }

  // Pass 4: singletons by __type__ (cc.SceneGlobals, cc.Prefab root, etc.)
  for (let i = 0; i < arr.length; i++) {
    if (indexToID.has(i)) continue;
    const obj = arr[i];
    if (!obj || typeof obj !== 'object') continue;
    const t = obj.__type__;
    if (t) {
      // Use type as ID only if unique in the array
      const sameType = arr.filter(o => o && o.__type__ === t);
      if (sameType.length === 1) {
        indexToID.set(i, `singleton_${t}`);
        idToIndex.set(`singleton_${t}`, i);
      } else {
        indexToID.set(i, `${t}[${i}]`);
      }
    }
  }

  return { indexToID, idToIndex };
}

function resolveNodeOfComponent(arr, compIdx) {
  for (let j = 0; j < arr.length; j++) {
    const o = arr[j];
    if (!o || !Array.isArray(o._components)) continue;
    for (const ref of o._components) {
      if (ref && ref.__id__ === compIdx) return j;
    }
  }
  return null;
}

// ── diff ───────────────────────────────────────────────────────────────────
function diffRevisions(baseArr, otherArr, otherName) {
  const baseMap = buildIDMap(baseArr);
  const otherMap = buildIDMap(otherArr);

  const added = [];
  const removed = [];
  const changed = [];
  const unresolved = [];

  // Objects in other not in base → added
  for (const [idx, id] of otherMap.indexToID) {
    if (!baseMap.idToIndex.has(id)) {
      added.push({ id, idx, type: otherArr[idx].__type__ });
    }
  }

  // Objects in base not in other → removed
  for (const [idx, id] of baseMap.indexToID) {
    if (!otherMap.idToIndex.has(id)) {
      removed.push({ id, idx, type: baseArr[idx].__type__ });
    }
  }

  // Objects in both → check for changes (shallow key diff, skip __id__ refs)
  for (const [baseIdx, id] of baseMap.indexToID) {
    const otherIdx = otherMap.idToIndex.get(id);
    if (otherIdx === undefined) continue;
    const baseObj = baseArr[baseIdx];
    const otherObj = otherArr[otherIdx];
    const changedKeys = getChangedKeys(baseObj, otherObj);
    if (changedKeys.length > 0) {
      changed.push({ id, type: baseObj.__type__, keys: changedKeys });
    }
  }

  // Unresolved (no stable ID)
  for (let i = 0; i < otherArr.length; i++) {
    if (!otherMap.indexToID.has(i)) {
      const obj = otherArr[i];
      unresolved.push({ idx: i, type: obj ? obj.__type__ : '(null)' });
    }
  }

  return { added, removed, changed, unresolved };
}

function getChangedKeys(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [];
  for (const k of keys) {
    if (k === '__id__') continue; // index refs change legitimately
    const av = JSON.stringify(a[k]);
    const bv = JSON.stringify(b[k]);
    if (av !== bv) changed.push(k);
  }
  return changed;
}

// ── report ─────────────────────────────────────────────────────────────────
function report(label, diff) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`BASE vs ${label}`);
  console.log('═'.repeat(60));
  console.log(`  Added:     ${diff.added.length} objects`);
  console.log(`  Removed:   ${diff.removed.length} objects`);
  console.log(`  Changed:   ${diff.changed.length} objects`);
  console.log(`  Unresolved (no stable ID): ${diff.unresolved.length} objects`);

  if (diff.added.length) {
    console.log('\n── Added ──');
    for (const e of diff.added.slice(0, 30)) {
      console.log(`  [${e.idx}] ${e.type}  id=${truncate(e.id, 40)}`);
    }
    if (diff.added.length > 30) console.log(`  ... and ${diff.added.length - 30} more`);
  }

  if (diff.removed.length) {
    console.log('\n── Removed ──');
    for (const e of diff.removed.slice(0, 30)) {
      console.log(`  [${e.idx}] ${e.type}  id=${truncate(e.id, 40)}`);
    }
    if (diff.removed.length > 30) console.log(`  ... and ${diff.removed.length - 30} more`);
  }

  if (diff.changed.length) {
    console.log('\n── Changed ──');
    for (const e of diff.changed.slice(0, 50)) {
      console.log(`  ${e.type}  id=${truncate(e.id, 36)}  keys=[${e.keys.join(', ')}]`);
    }
    if (diff.changed.length > 50) console.log(`  ... and ${diff.changed.length - 50} more`);
  }

  if (diff.unresolved.length) {
    console.log('\n── Unresolved (ID resolution gap) ──');
    for (const e of diff.unresolved.slice(0, 20)) {
      console.log(`  [${e.idx}] ${e.type}`);
    }
    if (diff.unresolved.length > 20) console.log(`  ... and ${diff.unresolved.length - 20} more`);
  }
}

function truncate(s, n) {
  return s && s.length > n ? s.slice(0, n) + '…' : s;
}

// ── also find true conflicts: changed in BOTH MINE and THEIRS ──────────────
function findConflicts(baseArr, mineArr, theirsArr) {
  const baseMap = buildIDMap(baseArr);
  const mineMap = buildIDMap(mineArr);
  const theirsMap = buildIDMap(theirsArr);

  const conflicts = [];

  for (const [baseIdx, id] of baseMap.indexToID) {
    const mineIdx = mineMap.idToIndex.get(id);
    const theirsIdx = theirsMap.idToIndex.get(id);
    if (mineIdx === undefined || theirsIdx === undefined) continue;

    const baseObj = baseArr[baseIdx];
    const mineObj = mineArr[mineIdx];
    const theirsObj = theirsArr[theirsIdx];

    const mineKeys = new Set(getChangedKeys(baseObj, mineObj));
    const theirsKeys = new Set(getChangedKeys(baseObj, theirsObj));

    const conflictKeys = [...mineKeys].filter(k => theirsKeys.has(k));
    const mineOnlyKeys = [...mineKeys].filter(k => !theirsKeys.has(k));
    const theirsOnlyKeys = [...theirsKeys].filter(k => !mineKeys.has(k));

    if (conflictKeys.length > 0 || mineOnlyKeys.length > 0 || theirsOnlyKeys.length > 0) {
      conflicts.push({
        id,
        type: baseObj.__type__,
        conflictKeys,
        mineOnlyKeys,
        theirsOnlyKeys,
      });
    }
  }
  return conflicts;
}

// ── main ───────────────────────────────────────────────────────────────────
console.log('Cocos Creator Prefab Conflict Analyzer');
console.log(`BASE:   ${BASE.length} objects`);
console.log(`MINE:   ${MINE.length} objects`);
console.log(`THEIRS: ${THEIRS.length} objects`);
console.log(`Version (BASE):   ${detectVersion(BASE)}`);
console.log(`Version (MINE):   ${detectVersion(MINE)}`);
console.log(`Version (THEIRS): ${detectVersion(THEIRS)}`);

report('MINE', diffRevisions(BASE, MINE, 'MINE'));
report('THEIRS', diffRevisions(BASE, THEIRS, 'THEIRS'));

console.log(`\n${'═'.repeat(60)}`);
console.log('TRUE CONFLICTS (changed in both MINE and THEIRS)');
console.log('═'.repeat(60));
const conflicts = findConflicts(BASE, MINE, THEIRS);
const trueConflicts = conflicts.filter(c => c.conflictKeys.length > 0);
const cleanMerge = conflicts.filter(c => c.conflictKeys.length === 0);

console.log(`  True conflicts (same key changed both sides): ${trueConflicts.length}`);
console.log(`  Auto-mergeable (different keys changed):      ${cleanMerge.length}`);

if (trueConflicts.length) {
  console.log('\n── True Conflicts ──');
  for (const c of trueConflicts) {
    console.log(`  ${c.type}  id=${truncate(c.id, 36)}`);
    console.log(`    conflict keys: [${c.conflictKeys.join(', ')}]`);
    if (c.mineOnlyKeys.length) console.log(`    mine only:     [${c.mineOnlyKeys.join(', ')}]`);
    if (c.theirsOnlyKeys.length) console.log(`    theirs only:   [${c.theirsOnlyKeys.join(', ')}]`);
  }
}

if (cleanMerge.length) {
  console.log('\n── Auto-mergeable (both changed but different keys) ──');
  for (const c of cleanMerge.slice(0, 30)) {
    console.log(`  ${c.type}  id=${truncate(c.id, 36)}`);
    if (c.mineOnlyKeys.length) console.log(`    mine:   [${c.mineOnlyKeys.join(', ')}]`);
    if (c.theirsOnlyKeys.length) console.log(`    theirs: [${c.theirsOnlyKeys.join(', ')}]`);
  }
  if (cleanMerge.length > 30) console.log(`  ... and ${cleanMerge.length - 30} more`);
}
