cocos-creator-merge is a git merge driver for Cocos Creator scene and prefab files. It performs a three-way property-level merge that eliminates false conflicts caused by `__id__` index shifting.

Supports CC1.x, CC2.4, and CC3.8 `.fire`, `.prefab`, and `.scene` files.

Forked from https://github.com/DavidDeSimone/FireMerge

**Building**:

Requires a C++17 compiler and `make`.

```
git clone https://github.com/doterax/cocos-creator-merge
cd cocos-creator-merge/
make
sudo make install
```

To build a debug binary:

```
make debug
```

To override the compiler:

```
make CC=g++
```

Binaries are placed in `build/release/` and `build/debug/`.

**Setup**:

Add to your `.gitattributes`:

```
**.fire   merge=CocosCreatorMerge
**.prefab merge=CocosCreatorMerge
**.scene  merge=CocosCreatorMerge
```

Add to your git config (`~/.gitconfig` or `.git/config`):

```
[merge "CocosCreatorMerge"]
  name = CocosCreatorMerge
  driver = /usr/local/bin/cocos-creator-merge %A %O %B
```

Or run:

```
git config merge.CocosCreatorMerge.driver "/usr/local/bin/cocos-creator-merge %A %O %B"
```

**How it works**:

Cocos Creator files are flat JSON arrays where objects reference each other by integer index (`__id__`). Those indices shift whenever nodes are added or removed, causing git to report conflicts on every reference even when the actual content is unchanged.

Cocos Creator Merge converts all `__id__` integer refs to stable UUID strings before comparing (using each object's `_id`, `fileId`, or a derived composite key), performs a property-level three-way merge, then converts back to integer indices.

Result: branches that touched different parts of the scene merge cleanly with no manual intervention.

**Conflicts**:

If both branches changed the same property to different values, Cocos Creator Merge takes the local (`%A`) value, reports the conflict to stderr, and exits with code 1 — the same signal git uses to indicate a merge driver left unresolved conflicts.

```
CONFLICTS (1):
  _name  id=834f1BEjTBPUZb6xY6a58Mr
    MINE:   "ConfirmButton"
    THEIRS: "SubmitButton"
```

Open the file in a text editor to find the conflicting node by its `_id` and resolve manually.
