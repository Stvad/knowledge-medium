# Media byte GC (§16) — the reference-counted, quiescent-time sweep

> **Status:** current (intent + v1 build). Last verified against code 2026-07-01.
> The **orphaned-workspace purge** (Branch A) is the v1 build landed with this doc — it
> gives `byteStore.purgeWorkspace` its first live caller. The **per-content-key selective
> reap** (Branch B) and the remote-object / quota / retention-horizon items are DESIGNED
> here but NOT yet built; they are called out as deferred. When you rely on a claim that
> matters, confirm it against the code — CODE + TESTS are authoritative.

This is the concrete design for the deferred `design.html` §16 reference-GC — the keystone
that owns byte reclamation for the media-attachments plugin. It supersedes nothing; it
fills in the "open question" §16 records and the deferral the revert of the eager purger
(`b3ce6f7e`) pointed at.

## Problem

Media bytes live in two monotonically-growing stores and **nothing reclaims either** today:

- the **local OPFS byte store** (`byteStore.ts`), keyed `assets/<user>/<ws>/<content-key>`;
- the **remote Supabase `attachments` bucket**, keyed `<ws>/<content-key>`.

Leaks accrue from four sources:

1. **revoked / left / deleted-workspace bytes** — on revoke/leave PowerSync drops the
   workspace's rows; the out-of-band OPFS bytes have no claw-back;
2. **replaced / deleted-media objects** — a block delete does *not* delete the object
   (one content-addressed object can back several blocks, §11);
3. **never-promoted `staged` capture orphans** — `uploadReconcile.ts` deliberately never
   reaps them, leaving their bytes for §16;
4. **quota-evictable bytes** — the store is `persist()`-backed but a real quota contest
   needs an evictor (§8).

`byteStore.purgeWorkspace` already exists as the intended primitive but had **no live
caller**. This job is that caller.

## The model: one quiescent reference sweep, not an eager reactive purge

Reclamation is **content-reference-counted** and runs as a **background sweep when the byte
lanes are quiescent**, never as an eager per-event deleter. The eager reactive
`MediaRevocationPurger` (a `workspace_members`-removal subscriber calling `purgeWorkspace`)
was prototyped (`e7fe0cf4`) and reverted (`b3ce6f7e`): deleting user media on a transient
membership signal is the wrong altitude — the signal can glitch (a momentary membership
query would delete bytes for a workspace you are *still* in), and to be correct it kept
needing escalating machinery (retry-on-failure, then cancel/epoch coordination with
in-flight down-lane `put`s). The agreed model, recorded on that revert, is this
quiescent-time reference-GC, which subsumes **revoke/leave + replacement + quota** under one
job that observes the *settled* truth instead of a transient event.

Four invariants, straight from §16's open-question:

- **Client-side only.** The content hash lives in encrypted `properties_json`; the server
  can't evaluate the refcount. The sweep runs locally against one device's view.
- **Count every reference.** Live blocks **and** soft-deleted tombstones (still carry the
  hash, undoable) **and** the history substrate. There is no soft-delete-retention horizon
  or history pruning today, so the refcount is effectively **reference-permanent in v1** —
  GC errs toward **retention** (a stranded live image is worse than wasted bytes).
- **Never a live zero-crossing.** Run only on a **settled-synced** workspace, behind a
  **grace window**, so a transient absence never triggers a reap.
- **Recoverable by re-upload.** From any device still holding the bytes — the
  cross-device-unsynced race can't be fully closed from one view, so reclamation must be
  reversible.

## What counts as a reference (the local view)

The reference set is built from the **local `blocks` table**, which after the sync
observer materializes is authoritative for this device:

| source | in local `blocks`? | carries hash? | counts as a reference? |
|---|---|---|---|
| live media block (`deleted=0`) | yes | yes (`properties_json.$."media:hash"`) | **yes** |
| soft-deleted tombstone (`deleted=1`) | yes (row stays) | yes | **yes** (undo-restorable) |
| revoked / left / workspace-deleted block | **no** (physically `DELETE`d) | — | **no** → reclaimable |
| `staged` capture orphan (block never committed) | no | — | **no** → reclaimable |

This falls out of how the observer applies each change (verified in
`src/data/internals/syncObserver/materialize.ts`):

- a peer's **soft-delete** arrives as an upsert with `deleted=1` → `UPSERT_BLOCK_SQL` flips
  the row to a **tombstone that stays in `blocks`** (`materialize.ts:61-65`); the hash is
  still in `properties_json`, so it counts.
- a **bucket removal** (membership revoke / workspace delete / stream-exit) →
  `DELETE_BLOCK_SQL` **physically removes the row** (`materialize.ts:67,395`); the hash
  survives only in the local-only `row_events` audit log's `before_json`.

**We deliberately do NOT count `row_events` (nor the server's `blocks_history`).** Two
reasons: (a) counting `row_events` would make revoke/leave *un-reclaimable* — the physical
`DELETE` writes a `row_events 'delete'` row that retains the hash forever (`row_events` is
unbounded and never trimmed, `clientSchema.ts:66-68`), so the whole revoke/leave branch
would never fire; (b) the client cannot read the server's encrypted `blocks_history` anyway.
The consequence is that the **local** refcount is weaker than the *global* one the design's
§16(c) describes — that is intentional and is exactly why reclamation must be
**recoverable-by-reupload** and why the **remote object** is retained reference-permanently
(below): the local sweep reclaims local bytes it can prove unreferenced *from this device*,
and re-download re-materializes anything a not-yet-synced peer still needs.

### Querying tombstones

`repo.queryBlocks` / the typed-block-query compiler hard-filter `deleted = 0`
(`typedBlockQuery.ts:447,454`), so live blocks come through the normal query but **tombstones
need raw SQL**. `media:hash` is not a column — extract it with the colon-safe JSON path the
codebase already uses (`typedBlockQuery.ts:18-19`):

```sql
SELECT DISTINCT json_extract(properties_json, '$."media:hash"') AS hash
FROM blocks
WHERE workspace_id = ?
  AND json_extract(properties_json, '$."media:hash"') IS NOT NULL
```

(no `deleted` filter → live + tombstoned). There is no partial index over `deleted=1`, so
this is a workspace-partition scan — fine for a slow background sweep. Run it via the public
`repo.db.getAll<T>(sql, params)` surface (`repo.ts:274`).

## Two reclamation branches, one sweep

The membership axis — is the workspace still in the local synced `workspaces` list
(`SELECT id FROM workspaces`; revoke drops the row) — splits reclamation into two branches:

### Branch A — orphaned-workspace purge (v1, built here)

A byte-store workspace prefix whose id is **not** in the accessible `workspaces` set is a
**revoked / left / deleted** workspace. Its blocks are gone from `blocks`, so its reference
set is empty and **the entire prefix is reclaimable** — no content-key derivation needed
(which matters: a revoked E2EE workspace no longer has its WK / `K_id`, so per-key
derivation would be impossible; the empty-set whole-prefix purge sidesteps that entirely).

```
for ws in byteStore.listWorkspaceIds(user):
  if accessible.has(ws): clear marker; continue      # still a member (Branch B territory)
  marker = markers.get(user, ws)
  if !marker:            markers.set(user, ws, now);  continue   # first sighting → grace starts
  if now - marker < GRACE: continue                              # still within grace
  if hasUnUploadedBytes(user, ws): continue                      # sole-copy guard (below)
  runSingleOwner(downLaneLock(user, ws), () => byteStore.purgeWorkspace(user, ws))
  markers.clear(user, ws)
```

This is the headline v1 deliverable: `purgeWorkspace`'s first live caller, reclaiming the
largest leak source (whole workspaces you left) with no crypto and the smallest risk surface.

### Branch B — per-content-key selective reap (designed, deferred)

For an **accessible** workspace (still a member), reclaim the *individual* objects that went
unreferenced (replaced media, hard-deleted media, `staged` orphans) while keeping the ones
that are still referenced:

```
referenced = { deriveContentKey(hash) for hash in live+softDeleted media blocks of ws }
stored     = byteStore.listWorkspaceKeys(user, ws)
for key in stored \ referenced:
  grace-window per (user, ws, key), then byteStore.delete(user, ws, key) under the lock
```

Deferred from v1 because it carries the real added surface: it must
`deriveContentKey(contentHash, mode, K_id)` (`sync/crypto/contentKey.ts`), which needs the
workspace **materializable / unlocked** — so a **locked E2EE** workspace must be *skipped*
(err toward retention), not treated as "empty set → reap all". It also needs the
tombstone-inclusive raw scan above and a per-key grace map. It reuses this doc's sweep
skeleton, grace-marker store, and lock; it is a clean fast-follow.

## The grace window (and why it is load-bearing, not a nicety)

A candidate (an orphaned workspace in Branch A; an unreferenced key in Branch B) is only
reclaimed after it has been **continuously** a candidate for `GRACE`, observed across **≥2
sweeps**. The first sweep only records a `firstSeen…` marker; a later sweep past `GRACE`
does the reclaim; **any sweep that sees the candidate become referenced/accessible again
clears the marker**, so the clock restarts. This is precisely "never a live zero-crossing".

It is load-bearing because of a real transient: the **checksum-wipe bug**
(`docs/powersync-bucket-wipe-bug-report.md`) — a `deleteBucket` full re-download takes the
same removal code path, so a live media block can *transiently vanish* from `blocks` (and a
whole workspace can transiently drop) before it re-materializes seconds-to-minutes later. A
grace window comfortably longer than that transient (and the marker's cross-session
persistence) means a wipe never causes a reap: the block/workspace reappears, the marker is
cleared. Revocation, by contrast, is permanent — the candidate persists past `GRACE` and is
reclaimed.

`GRACE` is set retention-biased (order of a day) and the sweep cadence such that ≥2
observations accrue; both are exported constants, tunable.

## Coordination, gating, recoverability

- **Under the down-lane lock.** The purge/delete runs inside
  `runSingleOwner(downLaneLockName(user, ws), …)` — the same per-(user,workspace) Web Lock
  the down-lane holds. This closes the coordination caveat already documented on
  `purgeWorkspace`: `byteStore.put`'s retry re-creates a just-purged dir, so a purge racing
  an in-flight `put` would lose. Holding the lock guarantees the workspace is quiescent.
- **Settled-synced gate.** Reclamation trusts "no local reference" only when the local view
  is authoritative: require `isRemoteSyncActive()` (a remote session, not local-only —
  else `workspaces`/`blocks` are empty for an unrelated reason) **and** `hasSynced` (initial
  download complete, via `onFirstSync`). There is no per-workspace settled predicate today
  (`hasSynced` is global); the grace window covers the residual imprecision.
- **Sole-copy guard (Branch A).** Before purging an orphaned prefix, skip it if the upload
  store still holds *any* un-uploaded record — `staged`, `pending`, **or** `failed` — for
  that workspace: those bytes may be the only copy anywhere (never reached remote, and a
  `failed` record has no §9 recovery actor yet). Retention-biased: a rare edge, deferred
  rather than risked (a stuck `failed` record pins its workspace until that record is
  cleared/recovered).
- **Recoverable by re-upload / re-download.** Local reclamation is graceful degradation, not
  data loss: if a purged workspace is re-joined, the down-lane re-replicates its bytes from
  the retained remote object; the remote object itself is retained (below), so the bytes are
  never gone globally.
- **Per-user scope.** The byte store is shared across the profile's accounts
  (`assets/<user_id>/…`); a sweep runs for the **active** user and only ever enumerates /
  purges under that user's prefix. Another account's bytes are never touched.

## Explicitly deferred (with the reason, so they aren't assumed covered)

- **Remote object (Supabase bucket) GC.** The remote object is retained
  **reference-permanently** in v1 — the client cannot prove the server's `blocks_history`
  (or a not-yet-synced peer) doesn't reference a hash, and a cross-device remote delete is
  irreversible from one view. This is the design's *stated accepted cost*: per-workspace
  remote Storage grows monotonically over v1's life (also an adversarial lever — a member
  can pin unreclaimable storage with distinct-content garbage — bounded only by the deferred
  history horizon). v1 therefore reclaims **local** bytes only; the remote bucket is not
  touched.
- **Quota-pressure eviction.** Evicting *referenced-but-plentiful* bytes under real
  origin-quota pressure (LRU, `DB > bytes` priority, the un-uploaded-sole-copy exemption of
  §8) is a separate *policy* from reference-GC. It rides the *same* content-refcount
  infrastructure but is not this job; deferred.
- **Retention-horizon gating.** If a soft-delete-retention horizon or `blocks_history`
  pruning is ever introduced, Branch B must gate on it — and a decision is then owed on
  whether a history / PITR **restore** recovers media bytes (else media is an explicit PITR
  carve-out). There is no horizon to gate on today; decide *when* one is introduced.

## Open sub-question (unchanged from §16)

If the retention horizon above lands, does a PITR restore re-materialize media bytes, or is
media a PITR carve-out? Decide with the horizon, not before.

## Testing plan

- **Reference model (pure):** revoked workspace (absent from `workspaces`) → candidate;
  still-member → not; a candidate that reappears before `GRACE` → marker cleared, no purge;
  a candidate past `GRACE` across ≥2 sweeps → purged; first sweep only marks (single-sweep
  transient never reaps).
- **Gating:** local-only / not-yet-`hasSynced` → no-op; sole-copy guard defers a prefix with
  `staged`/`pending` records.
- **Lock:** purge runs inside `runSingleOwner`; a non-owner tab does no work.
- **`byteStore.listWorkspaceIds`:** enumerates + `decodeSegment`s workspace dirs;
  empty when nothing stored; isolates by user.
- **Marker store:** durable across instances (fake-indexeddb), per-user isolation,
  `clearForUser`.

Follow the repo TDD loop: one test file at a time (`yarn vitest run <path>`), then
`yarn run check` before commit.
