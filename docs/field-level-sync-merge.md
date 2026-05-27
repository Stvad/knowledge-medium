# Field-level sync merge for blocks

Plan for ending row-level last-write-wins on `blocks`. Currently every block edit ships as a full-row upsert, so a collapse-only edit on one client clobbers any concurrent content/property/refs edit from another. And because `properties_json` is a single JSON blob, two edits to *different* property keys on the same block also clobber each other. This doc plans the fix.

Written 2026-05-27. Scope: `src/data/internals/txEngine.ts`, `src/services/powersync.ts`, `src/data/blockSchema.ts`, one Supabase migration adding an RPC. No schema reset; no on-disk data migration.

## Why today is broken

Every block write goes through `tx.update` in `src/data/internals/txEngine.ts:284`, which always sets `content`, `references_json`, `properties_json`, `updated_at`, `updated_by` regardless of what the patch actually contains. The CRUD entry PowerSync captures therefore lists all five columns. The uploader in `applyBlockPatches` (`src/services/powersync.ts:330`) then re-loads the full local row and ships a full-row UPSERT to Supabase. The server's PostgREST `.update()` does a straight column overwrite. Net result: whichever client's row reaches the server last wins all columns, not just the columns it semantically changed.

The user-visible failures this produces:

- **Cross-field clobber:** A toggles `system:collapsed`; B edits the block's content. Whichever lands second silently reverts the other's column.
- **Cross-key clobber:** A sets property `foo`; B sets property `bar`. Same row, same column (`properties_json`), so whichever lands second silently strips the other's key.
- **No-op writes upload anyway:** Toggling collapse to its current value still emits a full-row UPSERT.

`docs/data-layer-redesign.md:210` acknowledged row-LWW as a deliberate v1 trade-off; the cross-key case is the part that's stopped being tolerable.

## Architecture decisions worth pinning

- **Three layers, all required.** Narrowing the local UPDATE alone (Layer 1) doesn't help if the uploader re-fattens (Layer 2). Narrowing the wire payload doesn't help for `properties_json` cross-key conflicts without a per-key merge on the server (Layer 3). Ship all three.
- **PowerSync `trackPrevious` for the property diff, not a staging table.** PowerSync 1.20.1+ exposes `CrudEntry.previousValues` via a `trackPrevious: { columns, onlyWhenChanged }` table option. We diff old vs new `properties_json` in the uploader to derive the per-key patch. This catches any write path that mutates the column — including ones a staging-table-and-discipline approach would silently miss (admin scripts, ad-hoc `tx.update({properties: ...})` calls, future code, refactors that forget to use the choke point). Silent-clobber bugs are the worst shape; we want a mechanism that doesn't depend on every writer remembering to opt in.
- **`ignoreEmptyUpdates: true` on the blocks table.** Free correctness/perf win — no-op writes don't queue.
- **Content and references stay column-LWW for now.** With Layer 1 + 2, a property write no longer drags `content` or `references_json` along, so the remaining failure mode is "two clients edit the same column concurrently." For `content` that means character-level conflicts (needs a text CRDT — bigger project, out of scope). For `references_json` it means concurrent array edits (separate question; out of scope). Both are *strictly* improved by this work even without further changes.
- **Server-side merge via a Postgres RPC, not PostgREST PATCH.** PostgREST `.update()` lost the "did the row exist?" signal (silently 0-rows-affected when the row is missing — the original footgun `applyBlockPatches` papered over). An RPC `apply_block_patches(patches jsonb)` does the merge in SQL, returns rowcount per id, and centralizes the conflict rules in one auditable place.
- **`blocks_history` trigger needs no changes.** It already records per-column diffs and skips no-op UPDATEs (`supabase/migrations/20260522062437_add_blocks_history.sql:115-125`). Narrower writes just produce narrower history rows.
- **Pull-down replay unchanged.** Server still pushes full rows back; local `BLOCKS_RAW_TABLE.put` continues to do `ON CONFLICT(id) DO UPDATE SET <all columns>`. That's correct because the server holds the merged truth.
- **Postgres column type stays `text` for this work.** Considered migrating `properties_json` / `references_json` to `jsonb` for cleaner merge SQL, but the rollout compat is bad: old in-the-wild clients call `JSON.stringify(properties)` in `blockToRowParams` (`blockSchema.ts:222-228`) and the uploader forwards that stringified value to PostgREST. Sending a string body to a `jsonb` column stores it as a JSONB string scalar (`'"{...}"'::jsonb`), not as the object — and `||` against a string scalar fails. The RPC parses `text` to `jsonb`, merges, and casts back to `text` on assignment; the parse + serialize is microseconds against a network round-trip, paid only on writes that the RPC handles, and zero-impact for old clients still going through `.update()`. Local SQLite + Postgres JSONB conversion is a separate perf project — see follow-ups (the real win is the 29 `json_extract` / `json_each` callsites and per-write triggers in `clientSchema.ts`, all local).

## The three layers

### Layer 1 — local SQL: only touch the columns the patch named

`tx.update` should build its `SET` clause from the keys present in `BlockDataPatch`, not always write all five. Same surgery on `tx.restore` (`txEngine.ts:267`). `tx.move` already only touches `parent_id`/`order_key`; keep them written together (a half-applied move is worse than a clobbered one).

`updated_at` and `updated_by` are always bumped on a real write — that's metadata, column-LWW is fine.

Subtle requirement: the local snapshot Block subscribers read must stay coherent. It is — we still merge the patch onto `before` in memory and record `(before, after)` to `snapshots`. Only the persisted SQL narrows.

### Layer 2 — wire: stop re-fattening in the uploader

Replace the "load full row, ship UPSERT" path in `applyBlockPatches` (`powersync.ts:330-354`) with a single Supabase RPC call. Each entry carries only the columns that the CRUD entry actually contains, plus `id`, `updated_at`, `updated_by`. CREATEs and full UPSERTs (`applyBlockCreates`, `applyBlockUpserts`) stay as they are — they're by definition full-row.

The "row missing on the server" case the current code worries about: the RPC returns per-id rowcount. If 0, the orchestrator quarantines the entry the same way the current UPSERT-via-FK-trigger path does. We preserve the signal that the original bare `.update()` discarded.

`compactBlockCrudEntries` (`powersync.ts:112`) keeps fusing same-tx PUT+PATCH and PATCH+PATCH. The fusion direction stays right: later PATCH columns override earlier, and the fused entry carries the union of touched columns.

### Layer 3 — properties: per-key merge via `trackPrevious`

On the blocks raw table in `src/data/blockSchema.ts`:

```ts
{
  trackPrevious: { columns: ['properties_json'], onlyWhenChanged: true },
  ignoreEmptyUpdates: true,
}
```

(The exact wiring depends on the raw-table API — `RawTable` vs `Table` — verify before coding. Same flags exist on both per the SDK source.)

In the uploader, when a PATCH entry includes `opData.properties_json` and `previousValues.properties_json`, parse both and compute:

- `set`: keys whose value differs in `new` vs `prev`, mapped to the new value.
- `unset`: keys present in `prev` but absent in `new`.

Ship `{set, unset}` to the RPC. Server applies:

```sql
UPDATE blocks
SET properties_json = (
  (COALESCE(properties_json, '{}')::jsonb || $set::jsonb) - $unset_array
)::text
WHERE id = $id
```

`||` is shallow jsonb merge; `-` with a `text[]` removes keys. `properties_json` is a flat `Record<string, unknown>` (`src/data/api/blockData.ts`, `properties.ts:112-116`), so shallow merge is the right semantics — keys don't nest. The `::jsonb` parse and `::text` re-serialize are paid per-write inside the RPC; this is fine — the cost is microseconds, the call is already on a network round-trip path, and keeping the column as `text` avoids the rollout-compat problem of old clients writing stringified JSON to a `jsonb` column (which would be stored as a JSONB string scalar, breaking subsequent merges).

If `previousValues.properties_json` is missing (shouldn't happen with `onlyWhenChanged: true`, but defensively), fall back to overwriting the column. This degrades that one entry to today's behavior, no worse.

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

- **Same-tx fusion with `previousValues`.** When `compactBlockCrudEntries` fuses two PATCH entries for properties, the fused entry's `previousValues.properties_json` must reflect the state *before either write*, not the intermediate. Verify PowerSync's built-in CRUD pipeline preserves this for same-tx writes; if it doesn't, skip fusion for entries that carry `previousValues` and let the server apply them in order.
- **Compaction across txs.** Two separate txs that both touch properties get separate CRUD entries with their own `previousValues`. The uploader can either ship them as two RPC entries or fuse them: fusion is `set' = (set1 \ unset2) ∪ set2`, `unset' = (unset1 \ keys(set2)) ∪ unset2`. Cheap, but only worth doing if backlog size becomes a problem.
- **Soft delete vs property edit.** A delete and a concurrent property edit race: the delete wins (it writes `deleted = 1`, column-LWW). The property edit lands and merges into a tombstoned row; subsequent restore should preserve those merged property values. Acceptable; no special handling.
- **CREATE in the same batch as a property PATCH.** Same-tx fusion already merges PATCH columns into the CREATE payload. After this change, a fused CREATE-with-property-patch ships as a full-row CREATE with the merged `properties_json` — no diff needed. The PATCH branch with `previousValues` only matters for cross-tx PATCHes.
- **No `previousValues` on the very first write to a row.** First-ever PATCH to a row has no prior `properties_json`. PowerSync should still populate `previousValues.properties_json` with the row's value at PATCH time (which is the post-CREATE state). Verify with a unit test before relying on it; if not, fall back to "overwrite" for that entry.
- **Schema migration.** The raw-table options change is client-side only. The server migration adds the RPC function — no table changes, no column-type changes. Old clients keep working unchanged (they go through PostgREST `.update()` against the same `text` columns).
- **Mixed-client versions during rollout.** Old client ships full-row UPSERT → server overwrites everything for that block, including any concurrent partial-patch state from a new client. Same blast radius as today, no worse. New client ships partial RPC → server merges, preserving concurrent edits from any client. Forward-only migration; no data conversion.

## Phasing

1. **Layer 1** (small, contained). Narrow `tx.update`/`tx.restore` SQL. Add tests asserting that an update with only `{properties}` doesn't bump `content` in `row_events`/`blocks_history`. Land independently — it's a strict improvement and unblocks measuring the win.
2. **Layer 3 schema flags + uploader diff** (medium). Add `trackPrevious` + `ignoreEmptyUpdates` to the blocks table. In the uploader, compute the property diff but *still* ship full-row UPSERT for now (validate that `previousValues` shape is what we expect, end-to-end). Add unit tests for the diff logic in isolation.
3. **Layer 2 + RPC** (medium). Write `apply_block_patches(patches jsonb)` — parses `properties_json` text as jsonb in-flight, merges, casts back to text on assignment. Switch `applyBlockPatches` to call it with the partial payload (including the property `{set, unset}`). Keep the "row missing → quarantine" path. Integration test: two-client conflict on different property keys converges to both keys present.
4. **Remove the old fallback** once telemetry shows the new path is healthy. Drop `loadCurrentBlockUploadRows` from the PATCH path; it stays in the codebase only for the missing-local-row edge.

Each phase ships independently. Stages 1–2 are pure correctness improvements with no behavior change at the user level; stage 3 is the one that fixes the cross-key clobber.

## Open questions to settle before stage 3

- **Confirm `previousValues` semantics under same-tx fusion** (above). The shape question is load-bearing — if it returns the intermediate state we have to disable fusion for property PATCHes.
- **Delete-key encoding.** Sentinel-in-`set` (`{key: __DELETED}`) vs separate `unset: string[]`. Voting for separate field — cleaner types, server can validate independently.
- **RPC error shape.** Per-id success/failure array, or first-error-aborts-batch. Match whatever the existing orchestrator's quarantine path expects.
- **What other "fields" are device-local hiding in `properties_json`?** Even with per-key merge, anything that's truly UI-only (scroll position, focus, transient zoom) should still come out of synced properties. Quick audit while we're in there is cheap insurance.

## Out of scope (intentionally)

- **Character-level content CRDT** (Yjs / Automerge / Loro). Separate project; column-LWW on `content` is acceptable for now.
- **Array-CRDT for `references_json`.** Same reasoning.
- **Per-property `updated_at` for true per-key LWW with causal ordering.** Today we get "server transaction order is the tiebreak," which is fine for the conflicts that actually occur. Revisit if telemetry shows simultaneous-key conflicts becoming common.
- **Schema split (`block_properties` table, row per key).** Larger change; this design buys us most of the value without it. Revisit if the JSON blob becomes a scaling problem.
- **JSONB across the data layer** (both Postgres column type and SQLite local storage). Real perf project — the 29 `json_extract` / `json_each` callsites and per-write triggers in `src/data/internals/clientSchema.ts` would benefit, plus Postgres GIN indexability if we ever want it. Deferred to its own scoped PR with: a smoke test for PowerSync sync-stream serialization of `jsonb`, a wa-sqlite version confirmation for SQLite JSONB support, a benchmark on representative blocks, and a compat plan for the "old client sends stringified JSON to a `jsonb` column" issue. See `docs/follow-ups.md`.
