#!/usr/bin/env node
// CC3.8 prefab three-way merge prototype
// Usage: node test/merge.js
// Reads  test/00_prefab/{base,mine,theirs}.prefab
// Writes test/00_prefab/merged.prefab

'use strict';
const fs   = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '00_prefab');

// ══════════════════════════════════════════════════════════════════════════════
// STEP 1 — Stable ID map
// Every object in the flat array gets a stable string UUID so it can be tracked
// across BASE / MINE / THEIRS regardless of its array index.
// Priority:
//   1. _id  (non-empty)          — CC3.8 scene objects and scene-file prefab nodes
//   2. cc.PrefabInfo.fileId      — CC2.4 + CC3.8 prefab nodes
//   3. cc.CompPrefabInfo.fileId  — CC3.8 prefab components
//   4. singleton:__type__        — objects that appear once (cc.Prefab, cc.SceneGlobals …)
//   5. __type__[index]           — fallback for duplicated types
// ══════════════════════════════════════════════════════════════════════════════
function buildIDMap(arr) {
  const i2id = new Map(); // index  → stableID
  const id2i = new Map(); // stableID → index

  const reg = (idx, id) => { i2id.set(idx, id); id2i.set(id, idx); };

  // Pass 1 – real _id fields
  for (let i = 0; i < arr.length; i++) {
    const o = arr[i];
    if (!o) continue;
    if (o._id && typeof o._id === 'string' && o._id.length > 0) reg(i, o._id);
  }

  // Pass 2 – PrefabInfo / CompPrefabInfo → give ID to owner and to itself
  for (let i = 0; i < arr.length; i++) {
    const o = arr[i];
    if (!o) continue;
    const t = o.__type__;
    if (t !== 'cc.PrefabInfo' && t !== 'cc.CompPrefabInfo') continue;
    const fid = o.fileId;
    if (!fid) continue; // root node's PrefabInfo has fileId: ""

    for (let j = 0; j < arr.length; j++) {
      if (i2id.has(j)) continue;
      const owner = arr[j];
      if (!owner) continue;
      const ref = owner._prefab || owner.__prefab;
      if (ref && ref.__id__ === i) {
        reg(j, fid);           // owner gets fileId as its ID
        reg(i, `pi:${fid}`);   // PrefabInfo itself gets pi: prefix
        break;
      }
    }
  }

  // Pass 3 – cc.PrefabInstance has its own fileId
  for (let i = 0; i < arr.length; i++) {
    if (i2id.has(i)) continue;
    const o = arr[i];
    if (!o || o.__type__ !== 'cc.PrefabInstance') continue;
    if (o.fileId) reg(i, `inst:${o.fileId}`);
  }

  // Pass 4 – cc.TargetInfo identified by localID path
  for (let i = 0; i < arr.length; i++) {
    if (i2id.has(i)) continue;
    const o = arr[i];
    if (!o || o.__type__ !== 'cc.TargetInfo') continue;
    if (Array.isArray(o.localID) && o.localID.length > 0) reg(i, `ti:${o.localID.join('|')}`);
  }

  // Pass 5 – CCPropertyOverrideInfo: targetInfo localID + propertyPath
  for (let i = 0; i < arr.length; i++) {
    if (i2id.has(i)) continue;
    const o = arr[i];
    if (!o || o.__type__ !== 'CCPropertyOverrideInfo') continue;
    const tiIdx = o.targetInfo?.__id__;
    if (tiIdx === undefined) continue;
    const tiID = i2id.get(tiIdx);
    if (tiID && Array.isArray(o.propertyPath)) reg(i, `po:${tiID}:${o.propertyPath.join('.')}`);
  }

  // Pass 6 – cc.TargetOverrideInfo: source node ID + propertyPath
  for (let i = 0; i < arr.length; i++) {
    if (i2id.has(i)) continue;
    const o = arr[i];
    if (!o || o.__type__ !== 'cc.TargetOverrideInfo') continue;
    const srcIdx = o.source?.__id__;
    const srcID = srcIdx !== undefined ? i2id.get(srcIdx) : null;
    if (srcID && Array.isArray(o.propertyPath)) reg(i, `to:${srcID}:${o.propertyPath.join('.')}`);
  }

  // Pass 7 – stub nodes referenced as target/source in cc.TargetOverrideInfo
  // These are bare {__type__, __editorExtras__} nodes with no _id or _prefab;
  // they get a stable ID derived from the owning TargetOverrideInfo.
  for (let i = 0; i < arr.length; i++) {
    if (!i2id.has(i)) continue;                           // already resolved
    const o = arr[i];
    if (!o || o.__type__ !== 'cc.TargetOverrideInfo') continue;
    const toID = i2id.get(i);
    const targetIdx = o.target?.__id__;
    if (targetIdx !== undefined && !i2id.has(targetIdx)) reg(targetIdx, `target_of:${toID}`);
    const sourceIdx = o.source?.__id__;
    if (sourceIdx !== undefined && !i2id.has(sourceIdx)) reg(sourceIdx, `source_of:${toID}`);
  }

  // Pass 8 – cc.ClickEvent by target node stable ID + _componentId + handler
  for (let i = 0; i < arr.length; i++) {
    if (i2id.has(i)) continue;
    const o = arr[i];
    if (!o || o.__type__ !== 'cc.ClickEvent') continue;
    if (typeof o.target?.__id__ !== 'number') continue;
    const targetID = i2id.get(o.target.__id__);
    if (!targetID || !o._componentId || !o.handler) continue;
    reg(i, `click:${targetID}:${o._componentId}:${o.handler}`);
  }

  // Pass 9 – singletons / fallback
  const typeCounts = {};
  for (const o of arr) if (o && o.__type__) typeCounts[o.__type__] = (typeCounts[o.__type__] || 0) + 1;

  for (let i = 0; i < arr.length; i++) {
    if (i2id.has(i)) continue;
    const o = arr[i];
    if (!o || typeof o !== 'object') continue;
    const t = o.__type__;
    if (!t) continue;
    const id = typeCounts[t] === 1 ? `singleton:${t}` : `${t}[${i}]`;
    reg(i, id);
  }

  return { i2id, id2i };
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 2 — Convert {__id__: N} ↔ {__id__: "uuid"}
// We walk every value in the array and swap integer indices for UUID strings.
// ══════════════════════════════════════════════════════════════════════════════
function deepTransform(val, fn) {
  val = fn(val);
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(v => deepTransform(v, fn));
  const r = {};
  for (const k of Object.keys(val)) r[k] = deepTransform(val[k], fn);
  return r;
}

function isIdRef(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val) &&
         Object.keys(val).length === 1 && '__id__' in val;
}

function toUUID(arr, i2id) {
  return arr.map(obj => deepTransform(obj, val => {
    if (isIdRef(val) && typeof val.__id__ === 'number') {
      return { __id__: i2id.get(val.__id__) ?? `@idx:${val.__id__}` };
    }
    return val;
  }));
}

function toIndex(arr, uuidToIdx, verbose = false) {
  let dangling = 0;
  const danglingRefs = new Set();
  const out = arr.map(obj => deepTransform(obj, val => {
    if (isIdRef(val) && typeof val.__id__ === 'string') {
      const idx = uuidToIdx.get(val.__id__);
      if (idx !== undefined) return { __id__: idx };
      dangling++;
      danglingRefs.add(val.__id__);
      return { __id__: -1 };
    }
    return val;
  }));
  if (verbose && danglingRefs.size > 0) {
    console.log('  Dangling UUIDs:');
    for (const u of danglingRefs) console.log(`    ${u}`);
  }
  return { out, dangling };
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 3 — Three-way merge
// ══════════════════════════════════════════════════════════════════════════════

// Collect all UUID string refs from an object (recursively)
function collectUUIDRefs(val, fn) {
  if (val === null || typeof val !== 'object') return;
  if (Array.isArray(val)) { val.forEach(v => collectUUIDRefs(v, fn)); return; }
  if (isIdRef(val) && typeof val.__id__ === 'string') { fn(val.__id__); return; }
  Object.values(val).forEach(v => collectUUIDRefs(v, fn));
}

// Fields whose values are arrays of {__id__: uuid} refs — need set-merge
const REF_ARRAY_FIELDS = new Set([
  '_children', '_components', '_clips',
  'clickEvents', 'propertyOverrides', 'mountedChildren', 'mountedComponents', 'removedComponents',
  'targetOverrides',
]);

// Merge two ref-arrays using 3-way set semantics (order: mine first, then theirs additions)
function mergeRefArray(base, mine, theirs) {
  if (!Array.isArray(base))   base   = [];
  if (!Array.isArray(mine))   mine   = [];
  if (!Array.isArray(theirs)) theirs = [];

  const bSet = new Set(base.map(r => r?.__id__).filter(Boolean));
  const mSet = new Set(mine.map(r => r?.__id__).filter(Boolean));
  const tSet = new Set(theirs.map(r => r?.__id__).filter(Boolean));

  const seen   = new Set();
  const result = [];

  for (const ref of mine) {
    const id = ref?.__id__;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // Include if: mine added it (!bSet) OR both sides kept it (tSet)
    if (!bSet.has(id) || tSet.has(id)) result.push(ref);
    // else: in base, but theirs deleted → omit
  }

  for (const ref of theirs) {
    const id = ref?.__id__;
    if (!id || seen.has(id)) continue;
    if (!bSet.has(id) && !mSet.has(id)) {    // theirs added, mine didn't have it
      seen.add(id);
      result.push(ref);
    }
  }

  return result;
}

function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// Property-level 3-way merge of a single object (all values are UUID-ified)
// Returns { obj, conflicts: [{id, key, mine, theirs}] }
function mergeObject(id, base, mine, theirs) {
  base = base ?? {};
  const allKeys = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
  const obj      = {};
  const conflicts = [];

  for (const k of allKeys) {
    const bv = base[k];
    const mv = mine[k];
    const tv = theirs[k];

    if (REF_ARRAY_FIELDS.has(k)) {
      obj[k] = mergeRefArray(
        Array.isArray(bv) ? bv : [],
        Array.isArray(mv) ? mv : [],
        Array.isArray(tv) ? tv : [],
      );
      continue;
    }

    const mc = !deepEqual(mv, bv);
    const tc = !deepEqual(tv, bv);

    if      (!mc && !tc)           obj[k] = bv !== undefined ? bv : mv;
    else if ( mc && !tc)           obj[k] = mv;
    else if (!mc &&  tc)           obj[k] = tv;
    else if (deepEqual(mv, tv))    obj[k] = mv;
    else {
      obj[k] = mv; // take mine, flag conflict
      conflicts.push({ id, key: k, mine: mv, theirs: tv });
    }
  }

  return { obj, conflicts };
}

// Full three-way merge across all objects
function merge(baseArr, mineArr, theirsArr) {
  const baseMap   = buildIDMap(baseArr);
  const mineMap   = buildIDMap(mineArr);
  const theirsMap = buildIDMap(theirsArr);

  // Convert integer refs → UUID strings
  const baseU   = toUUID(baseArr,   baseMap.i2id);
  const mineU   = toUUID(mineArr,   mineMap.i2id);
  const theirsU = toUUID(theirsArr, theirsMap.i2id);

  // Build lookup: id → object (UUID version)
  const byID = {
    base:   new Map([...baseMap.i2id].map(([i, id]) => [id, baseU[i]])),
    mine:   new Map([...mineMap.i2id].map(([i, id]) => [id, mineU[i]])),
    theirs: new Map([...theirsMap.i2id].map(([i, id]) => [id, theirsU[i]])),
  };

  const allIDs     = new Set([...byID.base.keys(), ...byID.mine.keys(), ...byID.theirs.keys()]);
  const result     = new Map(); // id → merged object
  const conflicts  = [];
  const stats      = { added_mine: 0, added_theirs: 0, merged: 0, deleted: 0, conflict_delete: 0 };

  for (const id of allIDs) {
    const inB = byID.base.has(id);
    const inM = byID.mine.has(id);
    const inT = byID.theirs.has(id);

    if (inM && inT) {
      // Present in both output branches — property-level merge
      const { obj, conflicts: cs } = mergeObject(id, byID.base.get(id), byID.mine.get(id), byID.theirs.get(id));
      result.set(id, obj);
      conflicts.push(...cs);
      stats.merged++;
    } else if (inM && !inT) {
      if (!inB) {
        result.set(id, byID.mine.get(id)); // mine added
        stats.added_mine++;
      } else {
        // theirs deleted
        const unchanged = deepEqual(byID.mine.get(id), byID.base.get(id));
        if (!unchanged) {
          // mine modified + theirs deleted → conflict: keep mine
          conflicts.push({ id, key: '__deleted_by_theirs__', mine: byID.mine.get(id), theirs: null });
          result.set(id, byID.mine.get(id));
          stats.conflict_delete++;
        } else {
          stats.deleted++; // theirs deleted, mine unchanged → accept delete
        }
      }
    } else if (!inM && inT) {
      if (!inB) {
        result.set(id, byID.theirs.get(id)); // theirs added
        stats.added_theirs++;
      } else {
        // mine deleted
        const unchanged = deepEqual(byID.theirs.get(id), byID.base.get(id));
        if (!unchanged) {
          // theirs modified + mine deleted → conflict: keep theirs
          conflicts.push({ id, key: '__deleted_by_mine__', mine: null, theirs: byID.theirs.get(id) });
          result.set(id, byID.theirs.get(id));
          stats.conflict_delete++;
        } else {
          stats.deleted++; // mine deleted, theirs unchanged → accept delete
        }
      }
    }
    // in base only (both deleted) → omit
  }

  // ── Cascade include ───────────────────────────────────────────────────────
  // An object in the output may ref a deleted object (e.g. CCPropertyOverrideInfo → cc.TargetInfo).
  // Pull those deleted objects back in, preferring mine > theirs > base version.
  let cascadeAdded = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [, obj] of result) {
      collectUUIDRefs(obj, refID => {
        if (result.has(refID)) return;
        const pulled = byID.mine.get(refID) ?? byID.theirs.get(refID) ?? byID.base.get(refID);
        if (pulled) { result.set(refID, pulled); changed = true; cascadeAdded++; }
      });
    }
  }
  if (cascadeAdded) stats.cascade_added = cascadeAdded;

  // ── Output array ordering ─────────────────────────────────────────────────
  // Primary: mine's original order (for all surviving mine objects)
  // Appended: objects that came only from theirs, preserving theirs order
  const outputIDs = [];
  const seen      = new Set();

  for (const [i] of [...mineMap.i2id].sort((a, b) => a[0] - b[0])) {
    const id = mineMap.i2id.get(i);
    if (result.has(id) && !seen.has(id)) { outputIDs.push(id); seen.add(id); }
  }
  for (const [i] of [...theirsMap.i2id].sort((a, b) => a[0] - b[0])) {
    const id = theirsMap.i2id.get(i);
    if (result.has(id) && !seen.has(id)) { outputIDs.push(id); seen.add(id); }
  }
  // Catch any stragglers (shouldn't happen but be safe)
  for (const [id] of result) {
    if (!seen.has(id)) { outputIDs.push(id); seen.add(id); }
  }

  const outputObjs = outputIDs.map(id => result.get(id));

  // ── Convert UUID refs back to integer indices ─────────────────────────────
  const uuidToIdx = new Map(outputIDs.map((id, i) => [id, i]));
  const { out: final, dangling } = toIndex(outputObjs, uuidToIdx, true);

  return { final, conflicts, stats, dangling };
}

// ══════════════════════════════════════════════════════════════════════════════
// Validation: all __id__ refs must be in-range and non-negative
// ══════════════════════════════════════════════════════════════════════════════
function validateRefs(arr) {
  let bad = 0;
  function walk(val) {
    if (val === null || typeof val !== 'object') return;
    if (Array.isArray(val)) { val.forEach(walk); return; }
    if (isIdRef(val) && typeof val.__id__ === 'number') {
      if (val.__id__ < 0 || val.__id__ >= arr.length) bad++;
      return;
    }
    Object.values(val).forEach(walk);
  }
  arr.forEach(walk);
  return bad;
}

// ══════════════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════════════
function main() {
  console.log('Loading…');
  const BASE   = JSON.parse(fs.readFileSync(path.join(DIR, 'base.prefab'),   'utf8'));
  const MINE   = JSON.parse(fs.readFileSync(path.join(DIR, 'mine.prefab'),   'utf8'));
  const THEIRS = JSON.parse(fs.readFileSync(path.join(DIR, 'theirs.prefab'), 'utf8'));
  console.log(`  BASE ${BASE.length}  MINE ${MINE.length}  THEIRS ${THEIRS.length}`);

  console.log('Merging…');
  const { final, conflicts, stats, dangling } = merge(BASE, MINE, THEIRS);

  const outPath = path.join(DIR, 'merged.prefab');
  fs.writeFileSync(outPath, JSON.stringify(final, null, 2));

  console.log(`\nOutput: ${final.length} objects → ${path.basename(outPath)}`);
  console.log(`Stats:  added_mine=${stats.added_mine}  added_theirs=${stats.added_theirs}  merged=${stats.merged}  deleted=${stats.deleted}  conflict_delete=${stats.conflict_delete}`);

  const badRefs = validateRefs(final);
  console.log(`Refs:   dangling=${dangling}  out-of-range=${badRefs}  ${badRefs === 0 && dangling === 0 ? '✓ all valid' : '✗ INVALID'}`);

  console.log(`\nContent conflicts: ${conflicts.filter(c => !c.key.startsWith('__deleted')).length}`);
  console.log(`Delete conflicts:   ${conflicts.filter(c => c.key.startsWith('__deleted')).length}`);

  if (conflicts.length > 0) {
    console.log('\n── Conflict details ──');
    for (const c of conflicts) {
      if (c.key.startsWith('__deleted')) {
        console.log(`  [${c.key}] id=${c.id}`);
      } else {
        const obj = final.find((o, i) => o && o._id === c.id); // rough lookup
        console.log(`  CONFLICT key="${c.key}" id=${c.id}`);
        console.log(`    MINE:   ${JSON.stringify(c.mine).slice(0, 120)}`);
        console.log(`    THEIRS: ${JSON.stringify(c.theirs).slice(0, 120)}`);
      }
    }
  }
}

main();
