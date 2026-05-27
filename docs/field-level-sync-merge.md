# Field-level sync merge for blocks

Plan for ending row-level last-write-wins on `blocks`. Currently every block edit ships as a full-row upsert, so a collapse-only edit on one client clobbers any concurrent content/property/refs edit from another. And because `properties_json` is a single JSON blob, two edits to *different* property keys on the same block also clobber each other. This doc plans the fix.

Written 2026-05-27. Scope: `src/data/internals/clientSchema.ts` (custom upload trigger), `src/services/powersync.ts` (uploader), `src/data/internals/txEngine.ts` (semantic-no-op guard), one Supabase migration adding an RPC. No schema reset; no on-disk data migration; no Postgres column-type changes. **Rollout assumption: all clients upgrade in one go (no long-lived mixed-version state).** **Prerequisite: the v4 local-ephemeral backfill (`clientSchema.ts:822-935`) is removed in a separate cleanup PR before this lands** — the v4 marker on every active client confirms the backfill is done. Removing it keeps this doc focused on the merge fix and avoids having to plan for a second "full-row PATCH" emitter shape that would need to coexist with the new trigger.

## Why today is broken

The CRUD pipeline is custom-built (this repo uses `RawTable`, not the standard `Table` PowerSync triggers — see `src/data/blockSchema.ts:144` and `src/data/internals/clientSchema.ts:435`). The local trigger already emits a per-column-diffed patch envelope into `ps_crud` (`blockUploadPatchJsonSql` at `clientSchema.ts:399` strips unchanged columns via a `$.__noop` sentinel). But the uploader throws that away: `applyBlockPatches` (`src/services/powersync.ts:330`) re-loads the full current local row and ships a full-row UPSERT to Supabase. The server's PostgREST `.update()` does a straight column overwrite. Net result: whichever client's row reaches the server last wins all columns, not just the columns it semantically changed.

The user-visible failures this produces:

- **Cross-field clobber:** A toggles `system:collapsed`; B edits the block's content. Whichever lands second silently reverts the other's column.
- **Cross-key clobber:** A sets property `foo`; B sets property `bar`. Same row, same column (`properties_json`), so whichever lands second silently strips the other's key.
- **No-op writes upload anyway:** Toggling collapse to its current value still emits a full-row UPSERT.

`docs/data-layer-redesign.md:210` acknowledged row-LWW as a deliberate v1 trade-off; the cross-key case is the part that's stopped being tolerable.

## Architecture decisions worth pinning

- **Three layers.** Two load-bearing for correctness — (A) extend the custom upload trigger to emit `old.properties_json` so the uploader has the previous value, and (B) update the uploader to ship a partial patch + per-key property diff to a Supabase RPC instead of re-fattening into a full-row UPSERT. Plus one small contained change in the tx engine — (0) early-return on semantic no-ops before bumping metadata, so `block.set(prop, sameValue)` doesn't generate a PATCH. (An earlier draft included a "narrow `tx.update`'s SQL" layer; the trigger's existing per-column diff in `blockUploadPatchJsonSql` already produces the same wire output regardless of what columns `tx.update`'s SQL touches, so that change isn't load-bearing for correctness.)
- **Extend the custom upload trigger to carry `old`, not the `trackPrevious` raw-table option.** PowerSync's `Table.trackPrevious` schema option only works when PowerSync's auto-generated CRUD trigger is in play. We use `RawTable` and define our own `blocks_upload_update` trigger (`clientSchema.ts:435-453`) — so the `trackPrevious` flag doesn't reach the trigger, and `CrudEntry.previousValues` reads from `data.old`, which our trigger doesn't emit today. The fix is to extend the trigger's JSON envelope to also emit `'old', json_object(...)` carrying the previous value of `properties_json` when it changed. Same pattern as the existing `__noop`-strip in the data branch.
- **The trigger is the right choke point for writes that *do* upload.** The upload trigger gates on `tx_context.source IS NOT NULL` (`clientSchema.ts:438`), so it only fires for writes made through `repo.tx`. Raw out-of-band writes leave `source = NULL` and bypass the trigger entirely — they don't enqueue, so they don't upload at all (same as today; raw writes are forbidden by §4.2's discipline rule). For the writes that *do* upload, putting `old` in the envelope catches every property mutation automatically — including ad-hoc `tx.update({properties: ...})` calls, future code, and refactors that forget the original choke point. Compared to a staging table that requires every property writer to opt in even within `repo.tx`, this is harder to get wrong by omission.
- **Add a semantic-no-op guard in the tx engine.** The trigger's `WHEN` clause only filters SQL-level no-ops. But `tx.update`, `tx.setProperty`, and `tx.move` all call `metadataPatch` and always bump `updated_at`/`updated_by` — both columns are in `BLOCK_UPLOAD_COLUMNS` / `blockUploadDiffPredicateSql`, so the trigger fires on any metadata bump. Consequence: `block.set(prop, sameValue)` still produces a metadata-only PATCH and uploads. Fix: in `tx.update` / `tx.setProperty` / `tx.move`, compare against `before` *before* applying `metadataPatch`; if no user-meaningful field would change, return early without writing.
- **Always emit an `old` field on the new trigger** (even an empty `{}` when `properties_json` didn't change). The presence/absence of the `old` field is the discriminator between new-shape and legacy-shape envelopes — see the legacy-fallback section in Layer B. Inspecting whether `properties_json` is inside `old` answers "did the column actually change."
- **Content and references stay column-LWW for now.** With the uploader sending a partial patch, a property write no longer drags `content` or `references_json` along the wire, so the remaining failure mode is "two clients edit the same column concurrently." For `content` that means character-level conflicts (needs a text CRDT — bigger project, out of scope). For `references_json` it means concurrent array edits (separate question; out of scope). Both are *strictly* improved by this work even without further changes.
- **Server-side merge via a Postgres RPC, not PostgREST PATCH.** PostgREST `.update()` silently returns 0-rows-affected when the row is missing — the original footgun `applyBlockPatches` papered over with a full-row UPSERT. An RPC `apply_block_patches(patches jsonb)` does the merge in SQL, returns rowcount per id, and centralizes the conflict rules in one auditable place.
- **`blocks_history` trigger needs no changes.** It already records per-column diffs and skips no-op UPDATEs (`supabase/migrations/20260522062437_add_blocks_history.sql:115-125`). Narrower writes just produce narrower history rows.
- **Pull-down replay unchanged.** Server still pushes full rows back; local `BLOCKS_RAW_TABLE.put` continues to do `ON CONFLICT(id) DO UPDATE SET <all columns>`. That's correct because the server holds the merged truth.
- **Postgres column type stays `text` for this work.** Migrating `properties_json` / `references_json` to `jsonb` would let the RPC use native `||`/`-` without per-write casts, but its rollout-compat (old clients sending stringified JSON to a `jsonb` column → string scalar, breaks merges) is a separate problem worth handling in isolation. The RPC parses `text` to `jsonb`, merges, and casts back to `text` on assignment; microseconds per write, fine. JSONB across the data layer is a P2 follow-up — see `docs/follow-ups.md`.

## The layers

### Layer 0 — tx engine: semantic-no-op guard

`tx.update` (`txEngine.ts:284`), `tx.setProperty` (`txEngine.ts:354`), and `tx.move` (`txEngine.ts:312`) should compare the proposed `after` shape against `before` (excluding metadata) and early-return if nothing user-meaningful changed. Drops the SQL UPDATE entirely; the trigger never fires; no `ps_crud` row queued; no upload.

For `tx.setProperty` the comparison is value-only on the single key (encoded via the codec, then JSON-stringified for stable equality). For `tx.update`, compare `content`, `references` (deep), and `properties` (deep). For `tx.move`, compare `parent_id` and `order_key`. References and properties are flat enough that a `JSON.stringify` equality check is fine; if it gets hot, switch to a structural comparison.

Subtle: the guard must run before `metadataPatch` is applied, so it sees the pre-metadata `after`. The current code merges `metadataPatch` into `after` unconditionally; reorder.

### Layer A — trigger: emit `old`

Extend `CREATE_BLOCKS_UPLOAD_UPDATE_TRIGGER_SQL` (`clientSchema.ts:435-453`) to add an `old` field alongside `data` in the envelope. Mirror the existing `__noop`-strip pattern used in `blockUploadPatchJsonSql`:

```sql
INSERT INTO ps_crud (tx_id, data) VALUES (
  ${triggerTxSeqSql},
  json_object(
    'op', 'PATCH',
    'type', 'blocks',
    'id', NEW.id,
    'data', ${blockUploadPatchJsonSql()},
    'old',  ${blockUploadOldJsonSql()}    -- new
  )
);
```

`blockUploadOldJsonSql` emits `OLD.properties_json` keyed under `$.properties_json` only when `OLD.properties_json IS NOT NEW.properties_json`, and strips the `$.__noop` sentinel otherwise. **The `old` object itself is always present in the envelope, even if `{}`.** That presence is the new/legacy discriminator — see Layer B.

Result: PowerSync's `CrudEntry.fromRow` parses the envelope and exposes the old value as `entry.previousValues.properties_json` (or `undefined` if properties_json didn't change). `entry.previousValues` itself is always defined for entries from the new trigger.

**Trigger migration via DROP+CREATE.** `CLIENT_SCHEMA_STATEMENTS` runs `CREATE TRIGGER IF NOT EXISTS` (`repoProvider.ts:237-239`), so an upgraded local DB keeps its pre-change `blocks_upload_update` trigger unless we explicitly drop it. Prepend `DROP TRIGGER IF EXISTS blocks_upload_update;` immediately before the `CREATE TRIGGER` in `CLIENT_SCHEMA_STATEMENTS`. Cheap, idempotent, runs every bootstrap.

Scope of columns in `old`: just `properties_json` for v1 — that's the only column needing per-key merge. Adding more later is mechanical (same pattern per column). Keeping the set narrow keeps the envelope small.

### Layer B — uploader: ship a partial patch + property diff to an RPC

Replace the "load full row, ship UPSERT" path in `applyBlockPatches` (`powersync.ts:330-354`) with a single Supabase RPC call. Each entry carries only the columns from `entry.opData` (already narrow — the trigger stripped unchanged columns), plus per-key property diff when applicable, plus `id`, `updated_at`, `updated_by`. CREATEs (`applyBlockCreates`) stay as they are — PUT envelopes carry full rows by definition and use `ignoreDuplicates: true` for deterministic-id bootstrap collisions.

When a PATCH entry has both `entry.opData.properties_json` (the new value) and `entry.previousValues?.properties_json` (the old value), parse both and compute:

- `set`: keys whose value differs in `new` vs `prev`, mapped to the new value.
- `unset`: keys present in `prev` but absent in `new`.

Ship `{set, unset}` to the RPC. Server applies:

```sql
UPDATE blocks
SET properties_json = (
  (COALESCE(properties_json, '{}')::jsonb || $set::jsonb) - $unset_array
)::text
WHERE id = $id
RETURNING id;
```

`||` is shallow jsonb merge; `-` with a `text[]` removes keys. `properties_json` is a flat `Record<string, unknown>` (`src/data/api/blockData.ts`, `properties.ts:112-116`), so shallow merge is correct semantics. The `::jsonb` parse and `::text` re-serialize are paid per-write inside the RPC; the cost is microseconds.

Server returns rowcount per id; 0 → orchestrator quarantines (the row should already exist, since the corresponding CREATE was queued first within the same `repo.tx`).

**Single primary path, one small legacy fallback.** Discriminator: whether `entry.previousValues` is defined.

- **New-shape envelope** (`entry.previousValues` defined, since the new trigger always emits `old`): RPC path above. If `previousValues.properties_json` is set and `opData.properties_json` is set, do the per-key merge; otherwise just apply the columns in `opData` directly. Either way, this is the only path for steady-state operation.
- **Legacy-shape envelope** (`entry.previousValues` undefined, i.e., pre-upgrade ps_crud entry from the old trigger that hadn't drained at upgrade time): rehydrate full row via the existing `loadCurrentBlockUploadRows` + `applyBlockUpserts` code path. Same blast radius as today (full-blob overwrite, possible cross-key clobber on the unsent-queue window — finite, drains naturally). This branch is a small transient compatibility surface; remove once telemetry confirms no `entry.previousValues === undefined` PATCHes for `blocks` in flight.

No `metadata` discriminator. No three-path framing. The `CrudEntry.fromRow` codepath naturally distinguishes new from legacy by whether `data.old` was present in the envelope.

**Runtime invariants — fail loudly on envelope drift.** Before routing, validate:

- If `entry.previousValues` is defined and `previousValues.properties_json` is set: `opData.properties_json` must also be present (a trigger PATCH that changed `properties_json` must carry both old and new). Mismatch → quarantine.
- If `entry.previousValues` is defined but empty (`{}`): no `properties_json` in `opData` (column didn't change). RPC applies the other columns; no property work needed.
- If `entry.previousValues` is undefined: legacy fallback. No further invariants (this is the catch-all for pre-upgrade entries).

`compactBlockCrudEntries` (`powersync.ts:112`) keeps fusing same-tx PUT+PATCH and PATCH+PATCH. **`CompactedBlockOperation` (`powersync.ts:25-42`) currently carries only `{kind, id, payload, order}` — extend with `previousValues?: {properties_json?: string}`** so the trigger's `old.properties_json` survives into the uploader. Fusion is **per-column**, not per-entry: for each tracked column, take the value from the *earliest PATCH in the chain that actually carried that column in `old`*. With only `properties_json` tracked today, that simplifies to "first PATCH with `previousValues.properties_json` defined wins" — and crucially is **not** the same as "first PATCH wins outright." Concrete reason: same-tx writes can interleave column edits (e.g., `tx.update({content})` then `tx.setProperty(foo, …)`); the first PATCH's `old` is `{}` because it didn't touch properties_json, the second's `old.properties_json` is the true prior. Taking the first PATCH's `{}` would make the fused entry's `opData.properties_json` present with no matching `previousValues.properties_json`, which contradicts the invariant below and would either quarantine a valid tx or skip the merge.

`applyCompactedBlockOperations` reads the extended shape and dispatches as Layer B describes.

### What gets sent over the wire (example)

Today, after `block.set(isCollapsedProp, true)`:

```json
{
  "id": "abc",
  "content": "...whole block content...",
  "references_json": "[...whole refs array...]",
  "properties_json": "{...whole properties object with collapsed:true...}",
  "updated_at": 1, "updated_by": "u"
}
```

After this work:

```json
{
  "id": "abc",
  "properties": { "set": { "system:collapsed": true }, "unset": [] },
  "updated_at": 1, "updated_by": "u"
}
```

## Edge cases

- **Same-tx fusion with `old`.** Each AFTER UPDATE fires its own trigger, so each `ps_crud` row carries its own `OLD.properties_json` (the value just before that statement) — but only when properties_json actually changed in that statement. Fusion takes `previousValues.properties_json` from the *earliest PATCH in the chain that carried it*, not the earliest PATCH overall. Tests must cover (a) two-PATCH-same-tx-different-property-keys, (b) PATCH#1 touches another column only, PATCH#2 changes a property — the fused entry's `previousValues.properties_json` must come from PATCH#2.
- **Compaction across txs.** Two separate txs that both touch properties get separate CRUD entries with their own `previousValues`. Uploader can ship them as two RPC entries or fuse them: `set' = (set1 \ unset2) ∪ set2`, `unset' = (unset1 \ keys(set2)) ∪ unset2`. Cheap, but only worth doing if backlog size becomes a problem.
- **Soft delete vs property edit.** A delete and a concurrent property edit race: the delete wins (`deleted = 1`, column-LWW). A property edit that lands after merges into a tombstoned row; subsequent restore preserves the merged values.
- **CREATE in the same batch as a property PATCH.** Same-tx fusion already merges PATCH columns into the CREATE payload. A fused CREATE-with-property-patch ships as a full-row CREATE with the merged `properties_json` — no diff needed. The PATCH branch with `previousValues` only matters for cross-tx PATCHes.
- **First-ever PATCH to a row.** The very first PATCH after the CREATE has `OLD.properties_json` populated with the post-CREATE state (SQLite triggers always see OLD = current row). `old.properties_json` is always defined for a trigger-fired PATCH that changed `properties_json`.
- **Legacy PATCH (transient).** Pre-upgrade `ps_crud` entries lack `data.old` entirely; `entry.previousValues` is `undefined`. Uploader routes them to the existing `applyBlockUpserts` path (full-row rehydrate from current local state). Drains naturally on first online minute post-upgrade. Removable once telemetry confirms zero legacy entries fleet-wide.
- **Schema migration.** Client: DROP+CREATE the trigger in `CLIENT_SCHEMA_STATEMENTS` (idempotent). Server: add the `apply_block_patches` RPC. Old PostgREST `.update()` path still works (RPC and PostgREST coexist against the same `text` columns), so the rollout has a tolerable mixed-version window — see Rollout below.

## Phasing

1. **Layer 0: semantic-no-op guard** (small, orthogonal). Add early-return in `tx.update`, `tx.setProperty`, `tx.move`. Test: `setProperty` to the current value produces no `ps_crud` row. Land independently.
2. **Layer A: trigger emits `old`** (small). Extend the trigger envelope with the `old` field (always present, populated when `properties_json` changed). DROP+CREATE in `CLIENT_SCHEMA_STATEMENTS`. Unit-test the envelope shape (introspect `ps_crud.data` after a `tx.update({properties})`). Uploader still ships full-row UPSERTs at this point — `entry.previousValues` is populated but unused. Strict no-op for end users; lands as plumbing. **Prereq:** the v4 backfill cleanup PR has landed.
3. **Layer B: uploader diff + RPC** (medium). Write `apply_block_patches(patches jsonb)` — parses `properties_json` text as jsonb in-flight, merges, casts back to text. Switch `applyBlockPatches` to call it for new-shape entries (`entry.previousValues` defined). Keep the existing `loadCurrentBlockUploadRows` + `applyBlockUpserts` path as the legacy fallback for `entry.previousValues === undefined`. Integration test: two-client conflict on different property keys converges to both keys present. Same-tx fusion test: two property writes in the same tx on different keys both land.
4. **Remove the legacy fallback** once telemetry confirms no PATCH entries for `blocks` arrive with undefined `previousValues`. Drop the rehydrate/UPSERT branch and the unused helpers.

Phases 1–2 are no-op for users. Phase 3 is the one that fixes the cross-field and cross-key clobbers.

## Rollout

The work has two deployable artifacts: a Supabase migration (new RPC) and the client bundle (new trigger, new uploader, deleted v4 backfill). Order matters but the matrix of "old client + new server" / "new client + old server" is small.

1. **Deploy the Supabase migration first.** Adds `apply_block_patches` and any supporting types. Old clients don't call it, so this is invisible to them.
2. **Deploy the client bundle.** The service worker promotes new versions on next navigation via `SKIP_WAITING` (`src/registerServiceWorker.ts:15-30`). Open tabs adopt on next route change.
3. **Mixed-version window during rollout** (typically minutes, bounded by how quickly tabs reload):
   - Old tabs keep using PostgREST `.update()` against the unchanged `text` columns — exact today behavior, including today's clobber risk on concurrent writes. No regression.
   - New tabs use the RPC with per-key merge.
   - If an old tab and a new tab edit the same block concurrently, the old tab's full-row UPSERT can clobber the new tab's merged state. Blast radius equals today's, not worse.
4. **Force-refresh option** (if you want to compress the window). Add a one-shot postMessage from the active SW to all controlled clients telling them to reload — the SW already calls `SKIP_WAITING` on install, so the only thing missing is a `clients.matchAll(...).then(c => c.forEach(c => c.navigate(c.url)))` step. Risks disrupting users mid-edit, so usually not worth it for a non-emergency.
5. **Post-rollout cleanup.** After the legacy `ps_crud` queue has drained (one online session per client), the legacy fallback branch in the uploader becomes vestigial. Phase 4 removes it.

No `ps_crud` surgery on first boot of new code — the legacy fallback handles whatever's already in the queue with no migration step needed.

## Open questions to settle before phase 3

- **`compactBlockCrudEntries` `previousValues` preservation under fusion.** Concrete handling: extend `CompactedBlockOperation` with the slot, update fusion to keep the earliest-PATCH value. Unit-test the two-PATCH-same-tx case end-to-end.
- **Delete-key encoding.** Sentinel-in-`set` (`{key: __DELETED}`) vs separate `unset: string[]`. Voting for separate field — cleaner types, server can validate independently.
- **RPC error shape.** Per-id success/failure array, or first-error-aborts-batch. Match whatever the existing orchestrator's quarantine path expects.
- **What other "fields" are device-local hiding in `properties_json`?** Even with per-key merge, anything that's truly UI-only (scroll position, focus, transient zoom) should still come out of synced properties. Quick audit while we're in there is cheap insurance.

## Out of scope (intentionally)

- **Character-level content CRDT** (Yjs / Automerge / Loro). Separate project; column-LWW on `content` is acceptable for now.
- **Array-CRDT for `references_json`.** Same reasoning.
- **Per-property `updated_at` for true per-key LWW with causal ordering.** Today we get "server transaction order is the tiebreak," which is fine for the conflicts that actually occur. Revisit if telemetry shows simultaneous-key conflicts becoming common.
- **Schema split (`block_properties` table, row per key — possibly Tana-style "properties are child blocks").** The clean architectural answer to per-key merge: each property is its own row, per-row LWW is free, no JSON-merge plumbing. Larger project; this design buys most of the value without it. Worth a serious look once this work ships.
- **JSONB across the data layer** (both Postgres column type and SQLite local storage). Real perf project — the 29 `json_extract` / `json_each` callsites and per-write triggers in `clientSchema.ts` would benefit, plus Postgres GIN indexability. Deferred to its own scoped PR — see `docs/follow-ups.md`.
