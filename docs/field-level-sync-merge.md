# Field-level sync merge for blocks

Plan for ending row-level last-write-wins on `blocks`. Currently every block edit ships as a full-row upsert, so a collapse-only edit on one client clobbers any concurrent content/property/refs edit from another. And because `properties_json` is a single JSON blob, two edits to *different* property keys on the same block also clobber each other. This doc plans the fix.

Written 2026-05-27. Scope: `src/data/internals/clientSchema.ts` (custom upload trigger), `src/services/powersync.ts` (uploader), one Supabase migration adding an RPC. No schema reset; no on-disk data migration; no Postgres column-type changes.

## Why today is broken

The CRUD pipeline is custom-built (this repo uses `RawTable`, not the standard `Table` PowerSync triggers — see `src/data/blockSchema.ts:144` and `src/data/internals/clientSchema.ts:435`). The local trigger already emits a per-column-diffed patch envelope into `ps_crud` (`blockUploadPatchJsonSql` at `clientSchema.ts:399` strips unchanged columns via a `$.__noop` sentinel). But the uploader throws that away: `applyBlockPatches` (`src/services/powersync.ts:330`) re-loads the full current local row and ships a full-row UPSERT to Supabase. The server's PostgREST `.update()` does a straight column overwrite. Net result: whichever client's row reaches the server last wins all columns, not just the columns it semantically changed.

The user-visible failures this produces:

- **Cross-field clobber:** A toggles `system:collapsed`; B edits the block's content. Whichever lands second silently reverts the other's column.
- **Cross-key clobber:** A sets property `foo`; B sets property `bar`. Same row, same column (`properties_json`), so whichever lands second silently strips the other's key.
- **No-op writes upload anyway:** Toggling collapse to its current value still emits a full-row UPSERT.

`docs/data-layer-redesign.md:210` acknowledged row-LWW as a deliberate v1 trade-off; the cross-key case is the part that's stopped being tolerable.

## Architecture decisions worth pinning

- **Three layers.** Two load-bearing for correctness — (A) extend the custom upload trigger to emit `old` for the columns we want to diff, so the uploader has the previous value; (B) update the uploader to ship a partial patch + per-key property diff to a Supabase RPC instead of re-fattening into a full-row UPSERT. Plus one small contained change in the tx engine — (0) early-return on semantic no-ops before bumping metadata, so `block.set(prop, sameValue)` doesn't generate a PATCH. (An earlier draft included a "narrow `tx.update`'s SQL" layer; on closer reading, the trigger's existing per-column diff in `blockUploadPatchJsonSql` already produces the same wire output regardless of what columns `tx.update`'s SQL touches, so that change isn't load-bearing for correctness.)
- **Extend the custom upload trigger to carry `old`, not the `trackPrevious` raw-table option.** PowerSync's `Table.trackPrevious` schema option only works when PowerSync's auto-generated CRUD trigger is in play. We use `RawTable` and define our own `blocks_upload_update` trigger (`clientSchema.ts:435-453`) — so the `trackPrevious` flag doesn't reach the trigger, and `CrudEntry.previousValues` reads from `data.old`, which our trigger doesn't emit. The fix is to extend `blockUploadPatchJsonSql` (and the trigger's JSON envelope) to also emit `'old', json_object(...)` carrying the previous value of `properties_json` when it changed. Same pattern as the existing `__noop`-strip in the data branch.
- **The trigger is the right choke point for writes that *do* upload.** The upload trigger gates on `tx_context.source IS NOT NULL` (`clientSchema.ts:438`), so it only fires for writes made through `repo.tx`. Raw out-of-band writes leave `source = NULL` and bypass the trigger entirely — they don't enqueue, so they don't upload at all (same as today; raw writes are forbidden by §4.2's discipline rule for exactly this reason). For the writes that *do* upload (everything through `repo.tx`), putting `old` in the envelope catches every property mutation automatically — including ad-hoc `tx.update({properties: ...})` calls, future code, and refactors that forget the original choke point. Compared to a staging table that requires every property writer to opt in even within `repo.tx`, this is harder to get wrong by omission. (Compared to "all writes everywhere," neither approach catches raw writes; that's a separate discipline boundary.)
- **Add a semantic-no-op guard in the tx engine.** The trigger's `WHEN` clause only filters SQL-level no-ops. But `tx.update`, `tx.setProperty`, and `tx.move` all call `metadataPatch` and always bump `updated_at`/`updated_by` — both columns are in `BLOCK_UPLOAD_COLUMNS` / `blockUploadDiffPredicateSql`, so the trigger fires on any metadata bump. Consequence: `block.set(prop, sameValue)` still produces a PATCH whose `data` contains only `{updated_at, updated_by}` (other columns stripped by `__noop`), and it still uploads. Fix: in `tx.update` / `tx.setProperty` / `tx.move`, compare against `before` *before* applying the metadata patch; if no user-meaningful field would change, return early without writing. Doesn't affect cross-field/cross-key correctness (a metadata-only PATCH carries no `properties_json` in `opData`, so the server-side merge doesn't touch the column), but fixes the documented "no-op uploads" failure mode.
- **Content and references stay column-LWW for now.** With the uploader sending a partial patch, a property write no longer drags `content` or `references_json` along the wire, so the remaining failure mode is "two clients edit the same column concurrently." For `content` that means character-level conflicts (needs a text CRDT — bigger project, out of scope). For `references_json` it means concurrent array edits (separate question; out of scope). Both are *strictly* improved by this work even without further changes.
- **Server-side merge via a Postgres RPC, not PostgREST PATCH.** PostgREST `.update()` lost the "did the row exist?" signal (silently 0-rows-affected when the row is missing — the original footgun `applyBlockPatches` papered over). An RPC `apply_block_patches(patches jsonb)` does the merge in SQL, returns rowcount per id, and centralizes the conflict rules in one auditable place.
- **`blocks_history` trigger needs no changes.** It already records per-column diffs and skips no-op UPDATEs (`supabase/migrations/20260522062437_add_blocks_history.sql:115-125`). Narrower writes just produce narrower history rows.
- **Pull-down replay unchanged.** Server still pushes full rows back; local `BLOCKS_RAW_TABLE.put` continues to do `ON CONFLICT(id) DO UPDATE SET <all columns>`. That's correct because the server holds the merged truth.
- **Postgres column type stays `text` for this work.** Considered migrating `properties_json` / `references_json` to `jsonb` for cleaner merge SQL, but the rollout compat is bad: old in-the-wild clients call `JSON.stringify(properties)` in `blockToRowParams` (`blockSchema.ts:222-228`) and the uploader forwards that stringified value to PostgREST. Sending a string body to a `jsonb` column stores it as a JSONB string scalar (`'"{...}"'::jsonb`), not as the object — and `||` against a string scalar fails. The RPC parses `text` to `jsonb`, merges, and casts back to `text` on assignment; the parse + serialize is microseconds against a network round-trip, paid only on writes that the RPC handles, and zero-impact for old clients still going through `.update()`. Local SQLite + Postgres JSONB conversion is a separate perf project — see follow-ups (the real win is the 29 `json_extract` / `json_each` callsites and per-write triggers in `clientSchema.ts`, all local).

## The layers

### Layer 0 — tx engine: semantic-no-op guard

`tx.update` (`txEngine.ts:284`), `tx.setProperty` (`txEngine.ts:354`), and `tx.move` (`txEngine.ts:312`) should compare the proposed `after` shape against `before` (excluding metadata) and early-return if nothing user-meaningful changed. Drops the SQL UPDATE entirely; the trigger never fires; no `ps_crud` row queued; no upload.

For `tx.setProperty` the comparison is value-only on the single key (encoded via the codec, then JSON-stringified for stable equality). For `tx.update`, compare `content`, `references` (deep), and `properties` (deep). For `tx.move`, compare `parent_id` and `order_key`. References and properties are flat enough that a `JSON.stringify` equality check is fine; if it gets hot, switch to a structural comparison.

Subtle: the guard must run before `metadataPatch` is applied, so it sees the pre-metadata `after`. The current code merges `metadataPatch` into `after` unconditionally; reorder.

### Layer A — trigger: emit `old` for `properties_json`

Extend `CREATE_BLOCKS_UPLOAD_UPDATE_TRIGGER_SQL` (`clientSchema.ts:435-453`) to add an `old` field alongside `data` in the envelope, carrying the previous value of `properties_json` when it changed. Mirror the existing `__noop`-strip pattern used in `blockUploadPatchJsonSql`:

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

where `blockUploadOldJsonSql` emits `OLD.properties_json` keyed under `$.properties_json` only when `OLD.properties_json IS NOT NEW.properties_json`, and strips the `$.__noop` sentinel otherwise. Result: PowerSync's `CrudEntry.fromRow` parses the envelope and exposes the old value as `entry.previousValues.properties_json`.

**Local trigger migration is required, not optional.** `CLIENT_SCHEMA_STATEMENTS` runs every trigger with `CREATE TRIGGER IF NOT EXISTS` (`clientSchema.ts:436`, called at `repoProvider.ts:237-239`), so an existing local DB keeps its pre-change `blocks_upload_update` trigger and never starts emitting `old`. With Layer B treating "no `old.properties_json`" as the overwrite path, an upgraded client would silently keep clobbering. Fix: prepend `DROP TRIGGER IF EXISTS blocks_upload_update;` immediately before the `CREATE TRIGGER` in `CLIENT_SCHEMA_STATEMENTS`. Cheap (DROP is O(1)), idempotent, runs on every bootstrap. The codebase doesn't have prior DROP+CREATE precedent — the existing one-shot migration pattern uses `client_schema_state` markers (e.g., `local_ephemeral_upload_backfill_v4`) — but DROP+CREATE here is simpler than a marker because the trigger definition itself is the source of truth; no separate "have I run this migration" question.

Scope of columns in `old`: just `properties_json` for v1 — that's the only column needing per-key merge. Adding more later is mechanical (same pattern per column). Keeping the set narrow keeps the envelope small.

**The backfill emitter (`BACKFILL_LOCAL_EPHEMERAL_UPLOADS_SQL`, `clientSchema.ts:913`) must NOT add `old`.** It intentionally emits the full local row as canonical state ("local wins" recovery — see v4 backfill rationale at `clientSchema.ts:844-868`). Adding `old.properties_json = b.properties_json` would make `new == old`, the uploader's diff would be `{set:{}, unset:[]}`, and the RPC would skip the property update — leaving the server's stale row intact and reintroducing exactly the failure mode v4 was designed to fix.

Instead, the backfill envelope adds `'metadata', json_object('mode', 'upsert')` alongside the existing `{op:'PATCH', type, id, data}`. The uploader (Layer B) inspects `entry.metadata?.mode` and routes backfill entries to the existing full-row UPSERT path (`applyBlockUpserts`), bypassing the new RPC entirely. This preserves v4 backfill's INSERT-if-missing / replace-if-stale semantic — both halves of which are load-bearing for recovering never-uploaded local-ephemeral rows. See Layer B for the routing details.

### Layer B — uploader: ship a partial patch + property diff to an RPC

Replace the "load full row, ship UPSERT" path in `applyBlockPatches` (`powersync.ts:330-354`) with a single Supabase RPC call. Each entry carries only the columns from `entry.opData` (already narrow — the trigger stripped unchanged columns), plus per-key property diff when applicable, plus `id`, `updated_at`, `updated_by`. CREATEs and full UPSERTs (`applyBlockCreates`, `applyBlockUpserts`) stay as they are — they're by definition full-row.

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
```

`||` is shallow jsonb merge; `-` with a `text[]` removes keys. `properties_json` is a flat `Record<string, unknown>` (`src/data/api/blockData.ts`, `properties.ts:112-116`), so shallow merge is the right semantics — keys don't nest. The `::jsonb` parse and `::text` re-serialize are paid per-write inside the RPC; this is fine — the cost is microseconds, the call is already on a network round-trip path, and keeping the column as `text` avoids the rollout-compat problem of old clients writing stringified JSON to a `jsonb` column (which would be stored as a JSONB string scalar, breaking subsequent merges).

**Two intended paths through the uploader**, distinguished by an explicit envelope discriminator:

- **Trigger PATCH (per-column UPDATE with optional per-key merge).** Envelope: `{op:'PATCH', type, id, data:<changed cols>, old?:<prev cols>}`. Uploader calls the new RPC. If `data.properties_json` + `old.properties_json` both present → diff to `{set, unset}`, server does shallow JSONB merge. If `data.properties_json` present, `old.properties_json` absent → server overwrites the column verbatim. If neither present → RPC doesn't touch the column. Server returns rowcount; 0 → orchestrator quarantines (the row should already exist, since the corresponding CREATE was queued first within the same `repo.tx`).
- **Backfill PATCH (full-row INSERT-or-replace).** Envelope: `{op:'PATCH', type, id, data:<full row>, metadata:{mode:'upsert'}}`. Uploader routes via `entry.metadata?.mode === 'upsert'` to the existing full-row UPSERT path (`applyBlockUpserts` via Supabase `.upsert(..., {onConflict:'id'})`) — *not* the new RPC. This preserves v4 backfill's "INSERT if missing, replace if stale" semantic for never-uploaded local-ephemeral rows (`clientSchema.ts:858-861`). Crucially, missing-on-server is the expected case here (the entire point of backfill), so 0-row UPDATEs do *not* quarantine — they fall through to INSERT.

Keep the discriminator explicit (`metadata.mode = 'upsert'`) rather than implicit (e.g., "does `data` contain `created_at`?"). PowerSync's `CrudEntry` already exposes `entry.metadata` as a standard slot for upload-side discriminators, so we use it without inventing parallel infrastructure.

`compactBlockCrudEntries` (`powersync.ts:112`) keeps fusing same-tx PUT+PATCH and PATCH+PATCH. The fusion direction stays right: later PATCH columns override earlier, and the fused entry carries the union of touched columns. **`CompactedBlockOperation` (`powersync.ts:25-42`) currently carries only `{kind, id, payload, order}` — extend it to also carry `previousValues?: {properties_json?: string}` and `metadata?: {mode?: 'upsert'}`** so the discriminators from Layer A survive into the uploader. Fusion rules:

- `previousValues.properties_json` from PATCH fusion: keep the value from the *earliest* PATCH in the chain (since that's the true prior state on the server before any of these writes). Later PATCHes' `OLD.properties_json` is the previous PATCH's NEW; using it would silently drop intermediate keys.
- `metadata.mode = 'upsert'` from PATCH fusion: in practice backfill entries and trigger entries don't co-occur for the same id in the same batch (backfill is one-shot, fired once per row that hasn't synced; trigger fires on subsequent `repo.tx` writes), so a simple "any entry's metadata wins" is fine. Document the assumption with a test that fails loudly if the two paths ever overlap.

`applyCompactedBlockOperations` reads the extended shape and routes via `metadata.mode` and `previousValues.properties_json` exactly as Layer B describes.

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

- **Compaction must preserve discriminators.** `CompactedBlockOperation` (`powersync.ts:25-42`) is `{kind, id, payload, order}` — extend with `previousValues` and `metadata` slots so the trigger's `old.properties_json` and the backfill's `metadata.mode='upsert'` survive into the uploader. Same-tx PATCH fusion: each AFTER UPDATE fires its own trigger, so each `ps_crud` row carries its own `OLD.properties_json` (the value just before that statement). Fused entry must keep `previousValues.properties_json` from the *earliest* PATCH (the second's OLD is the first's NEW; using it silently drops intermediate keys). Tests must cover two-PATCH-same-tx-different-keys.
- **Compaction across txs.** Two separate txs that both touch properties get separate CRUD entries with their own `previousValues`. The uploader can either ship them as two RPC entries or fuse them: fusion is `set' = (set1 \ unset2) ∪ set2`, `unset' = (unset1 \ keys(set2)) ∪ unset2`. Cheap, but only worth doing if backlog size becomes a problem.
- **Soft delete vs property edit.** A delete and a concurrent property edit race: the delete wins (it writes `deleted = 1`, column-LWW). The property edit lands and merges into a tombstoned row; subsequent restore should preserve those merged property values. Acceptable; no special handling.
- **CREATE in the same batch as a property PATCH.** Same-tx fusion already merges PATCH columns into the CREATE payload. After this change, a fused CREATE-with-property-patch ships as a full-row CREATE with the merged `properties_json` — no diff needed. The PATCH branch with `previousValues` only matters for cross-tx PATCHes.
- **First-ever PATCH to a row.** The very first PATCH after the CREATE has `OLD.properties_json` populated with the post-CREATE state (SQLite triggers always see OLD = current row). So `old.properties_json` is always defined for a trigger-fired PATCH that changed `properties_json`.
- **Backfill PATCH (`BACKFILL_LOCAL_EPHEMERAL_UPLOADS_SQL`).** Emits `{op, type, id, data, metadata:{mode:'upsert'}}` with `data` being the full local row and no `old` field. Uploader routes via `entry.metadata?.mode === 'upsert'` to the existing `applyBlockUpserts` path (PostgREST `.upsert(..., {onConflict:'id'})`), *not* the new RPC. Two distinct recovery cases both work: (a) row missing on server → INSERT; (b) row exists but stale → full replace ("local wins"). Critically, the new RPC's "0 rows → quarantine" rule does *not* apply here — missing-on-server is the expected case for backfill, and the UPSERT handles it correctly. Code-comment this in both the backfill SQL and the uploader routing so a future "harmonize envelopes" refactor doesn't reintroduce the bug.
- **Schema migration.** Two parts. **Client-side:** Layer A requires a real local-DB migration — `CLIENT_SCHEMA_STATEMENTS` runs `CREATE TRIGGER IF NOT EXISTS` (`repoProvider.ts:237-239`), so upgrading clients keep the old `blocks_upload_update` definition unless we explicitly drop it. Plan adds `DROP TRIGGER IF EXISTS blocks_upload_update` before the CREATE in `CLIENT_SCHEMA_STATEMENTS`. Safe to run every bootstrap (DROP is O(1) and idempotent). **Server-side:** the migration adds the RPC function only — no table changes, no column-type changes. Old clients keep working unchanged (they go through PostgREST `.update()` against the same `text` columns).
- **Mixed-client versions during rollout.** Old client ships full-row UPSERT → server overwrites everything for that block, including any concurrent partial-patch state from a new client. Same blast radius as today, no worse. New client ships partial RPC → server merges, preserving concurrent edits from any client. Forward-only migration; no data conversion.

## Phasing

1. **Layer 0: semantic-no-op guard** (small, contained, orthogonal). Add early-return in `tx.update`, `tx.setProperty`, `tx.move`. Test: `setProperty` to the current value produces no `ps_crud` row. Land independently — strict improvement.
2. **Layer A: trigger emits `old`** (small). Extend `blockUploadPatchJsonSql` / the trigger envelope to also emit `old.properties_json` when changed. Update the local backfill emitter consistently. Unit-test the envelope shape (introspect `ps_crud.data` after a `tx.update({properties})`). The uploader still ships full-row UPSERTs at this point — `entry.previousValues` is populated but unused. Strict no-op for end users; lands as plumbing.
3. **Layer B: uploader diff + RPC** (medium). Write `apply_block_patches(patches jsonb)` — parses `properties_json` text as jsonb in-flight, merges, casts back to text on assignment. Switch `applyBlockPatches` to call it with the partial payload (column-level diff from `entry.opData` plus property `{set, unset}` from diffing `opData.properties_json` vs `previousValues.properties_json`). Keep the "row missing → quarantine" path. Integration test: two-client conflict on different property keys converges to both keys present. Same-tx fusion test: two property writes in the same tx on different keys both land.
4. **Remove the old fallback** once telemetry shows the new path is healthy. Drop `loadCurrentBlockUploadRows` from the PATCH path; it stays in the codebase only for the missing-local-row edge.

Phases 1–2 are no-op for users (perf cleanup + instrumentation). Phase 3 is the one that fixes the cross-field and cross-key clobbers.

## Open questions to settle before phase 2

- **`compactBlockCrudEntries` `old` preservation under fusion.** Confirm the fused entry preserves `old` from the earliest PATCH (the only correct semantic) — needs explicit handling, the current compaction merges `data` but doesn't know about `old`.
- **Delete-key encoding.** Sentinel-in-`set` (`{key: __DELETED}`) vs separate `unset: string[]`. Voting for separate field — cleaner types, server can validate independently.
- **RPC error shape.** Per-id success/failure array, or first-error-aborts-batch. Match whatever the existing orchestrator's quarantine path expects.
- **What other "fields" are device-local hiding in `properties_json`?** Even with per-key merge, anything that's truly UI-only (scroll position, focus, transient zoom) should still come out of synced properties. Quick audit while we're in there is cheap insurance.

## Out of scope (intentionally)

- **Character-level content CRDT** (Yjs / Automerge / Loro). Separate project; column-LWW on `content` is acceptable for now.
- **Array-CRDT for `references_json`.** Same reasoning.
- **Per-property `updated_at` for true per-key LWW with causal ordering.** Today we get "server transaction order is the tiebreak," which is fine for the conflicts that actually occur. Revisit if telemetry shows simultaneous-key conflicts becoming common.
- **Schema split (`block_properties` table, row per key).** Larger change; this design buys us most of the value without it. Revisit if the JSON blob becomes a scaling problem.
- **JSONB across the data layer** (both Postgres column type and SQLite local storage). Real perf project — the 29 `json_extract` / `json_each` callsites and per-write triggers in `src/data/internals/clientSchema.ts` would benefit, plus Postgres GIN indexability if we ever want it. Deferred to its own scoped PR with: a smoke test for PowerSync sync-stream serialization of `jsonb`, a wa-sqlite version confirmation for SQLite JSONB support, a benchmark on representative blocks, and a compat plan for the "old client sends stringified JSON to a `jsonb` column" issue. See `docs/follow-ups.md`.
