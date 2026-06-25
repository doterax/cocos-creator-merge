# Remaining work

## `_trs` TypedArray (CC2.4 only)

CC2.4 stores all transforms in a single `_trs` field:
```json
{"__type__": "TypedArray", "ctor": "Float64Array", "array": [posX,posY,posZ, qX,qY,qZ,qW, sX,sY,sZ]}
```

For correct property-level merge this must be unpacked into logical sub-properties before comparison:
- indices [0,1,2] → position
- indices [3,4,5,6] → rotation
- indices [7,8,9] → scale

If branch A moved a node and branch B scaled it, they touch different sub-ranges and should auto-merge. Currently the whole `_trs` array is compared as a scalar, producing a false conflict whenever position and scale are changed on separate branches.

After merging, reassemble back into the TypedArray format. This only affects CC2.4; CC3.8 already uses separate `_lpos` / `_lrot` / `_lscale` fields.

---

## Inline conflict markers

Currently conflicts are reported to stderr and the tool takes mine's value. A better output would embed structured markers in the JSON so the developer sees exactly which field needs a decision:

```json
{
  "__type__": "cc.Node",
  "_id": "834f1BEjTBPUZb6xY6a58Mr",
  "_name": {
    "__conflict__": true,
    "mine": "ConfirmButton",
    "base": "Button",
    "theirs": "SubmitButton"
  }
}
```

This scopes the conflict to one field instead of the whole node. Requires a companion tool or VS Code extension to resolve the markers and write clean JSON back.

---

## Test suite

Zero automated tests. Needed before the tool can be trusted on new file formats.

Structure: for each scenario, three JSON files (`base.json`, `mine.json`, `theirs.json`) and an expected output. Run the binary and compare output (semantic JSON equality, ignoring key order).

Essential cases:
1. MINE changes `_active`, THEIRS changes `_name` on same node → both changes in result, no conflict
2. Both branches change `_opacity` to different values → conflict reported, mine's value kept
3. MINE adds a node, THEIRS doesn't → new node present
4. Both add different nodes → both present
5. THEIRS deletes a node MINE didn't touch → node absent
6. Both add to `_children` → both additions present, base children preserved
7. CC2.4 prefab: verify `cc.PrefabInfo.fileId` routing
8. CC3.8 prefab: two components with same `__type__` on same node get distinct IDs via `cc.CompPrefabInfo`
9. `_trs` TypedArray: MINE moves node, THEIRS scales it → auto-merged (requires `_trs` unpacking above)

---

## Phase 3 — VS Code extension

A VS Code extension that detects `__conflict__` markers in open `.scene`/`.prefab`/`.fire` files, shows inline decorations for each unresolved field with BASE/MINE/THEIRS values, and lets the developer click to accept one side. Requires the inline conflict markers above to be implemented first.

---

## Phase 4 — LCS-based child ordering

When both branches add children to the same node the current output appends mine's additions first, then theirs. In practice this is fine. A future improvement is to use Longest Common Subsequence to interleave insertions by their context (what they were inserted next to in the base), producing a more natural ordering. Low priority.
