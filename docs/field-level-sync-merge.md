# Field-level sync merge for blocks

Plan for ending row-level last-write-wins on `blocks`. Currently every block edit ships as a full-row upsert, so a collapse-only edit on one client clobbers any concurrent content/property/refs edit from another. And because `properties_json` is a single JSON blob, two edits to *different* property keys on the same block also clobber each other. This doc plans the fix.

Written 2026-05-27. Scope: `src/data/internals/clientSchema.ts` (custom upload trigger), `src/services/powersync.ts` (uploader), `src/data/internals/txEngine.ts` (semantic-no-op guard), one Supabase migration adding an RPC. No schema reset; no on-disk data migration; no Postgres column-type changes.

**Rollout assumption: coordinated upgrade with queue drain.** Fleet is small (2 users, 5 devices). We hold each device on the old code until its local `ps_crud` queue is empty, then swap to the new bundle. No mixed-version state; no legacy `ps_crud` entries to handle post-upgrade.

**Cleanup assumption: the v4 local-ephemeral backfill (`clientSchema.ts:822-935`) has run on every active client; it gets deleted in phase 0 of this sequence before any other change lands.**

## Why today is broken

The CRUD pipeline is custom-built (this repo uses `RawTable`, not the standard `Table` PowerSync triggers — see `src/data/blockSchema.ts:144` and `src/data/internals/clientSchema.ts:435`). The local trigger already emits a per-column-diffed patch envelope into `ps_crud` (`blockUploadPatchJsonSql` at `clientSchema.ts:399` strips unchanged columns via a `$.__noop` sentinel). But the uploader throws that away: `applyBlockPatches` (`src/services/powersync.ts:330`) re-loads the full current local row and ships a full-row UPSERT to Supabase. The server's PostgREST `.update()` does a straight column overwrite. Net result: whichever client's row reaches the server last wins all columns, not just the columns it semantically changed.

The user-visible failures this produces:

- **Cross-field clobber:** A toggles `system:collapsed`; B edits the block's content. Whichever lands second silently reverts the other's column.
- **Cross-key clobber:** A sets property `foo`; B sets property `bar`. Same row, same column (`properties_json`), so whichever lands second silently strips the other's key.
- **No-op writes upload anyway:** Toggling collapse to its current value still emits a full-row UPSERT.

`docs/data-layer-redesign.md:210` acknowledged row-LWW as a deliberate v1 trade-off; the cross-key case is the part that's stopped being tolerable.

## Architecture decisions worth pinning

- **Three layers.** Two load-bearing for correctness — (A) extend the custom upload trigger to emit `old.properties_json` so the uploader has the previous value, and (B) update the uploader to ship a partial patch + per-key property diff to a Supabase RPC instead of re-fattening into a full-row UPSERT. Plus one small contained change in the tx engine — (0) early-return on semantic no-ops before bumping metadata, so `block.set(prop, sameValue)` doesn't generate a PATCH.
- **Extend the custom upload trigger to carry `old`, not the `trackPrevious` raw-table option.** PowerSync's `Table.trackPrevious` schema option only works when PowerSync's auto-generated CRUD trigger is in play. We use `RawTable` and define our own `blocks_upload_update` trigger (`clientSchema.ts:435-453`) — so the `trackPrevious` flag doesn't reach the trigger, and `CrudEntry.previousValues` reads from `data.old`, which our trigger doesn't emit today. The fix is to extend the trigger's JSON envelope to also emit `'old', json_object(...)` carrying the previous value of `properties_json` when it changed. Same pattern as the existing `__noop`-strip in the data branch.
- **The trigger is the right choke point for writes that *do* upload.** The upload trigger gates on `tx_context.source IS NOT NULL` (`clientSchema.ts:438`), so it only fires for writes made through `repo.tx`. Raw out-of-band writes leave `source = NULL` and bypass the trigger entirely — they don't enqueue, so they don't upload at all (same as today; raw writes are forbidden by §4.2's discipline rule). For the writes that *do* upload, putting `old` in the envelope catches every property mutation automatically — including ad-hoc `tx.update({properties: ...})` calls, future code, and refactors that forget the original choke point. Compared to a staging table that requires every property writer to opt in even within `repo.tx`, this is harder to get wrong by omission.
- **Add a semantic-no-op guard in the tx engine.** The trigger's `WHEN` clause only filters SQL-level no-ops. But `tx.update`, `tx.setProperty`, and `tx.move` all call `metadataPatch` and always bump `updated_at`/`updated_by` — both columns are in `BLOCK_UPLOAD_COLUMNS` / `blockUploadDiffPredicateSql`, so the trigger fires on any metadata bump. Consequence: `block.set(prop, sameValue)` still produces a metadata-only PATCH and uploads. Fix: in `tx.update` / `tx.setProperty` / `tx.move`, compare against `before` *before* applying `metadataPatch`; if no user-meaningful field would change, return early without writing.
- **Coordinated rollout means no legacy-queue handling in code.** With every device on the new bundle and a drained `ps_crud` at swap time, the uploader can assume every PATCH carries the new envelope shape (`old` field present when `properties_json` changed). One path through Layer B, no fallback, no envelope-shape discriminators, no mixed-fusion rules.
- **Content and references stay column-LWW for now.** With the uploader sending a partial patch, a property write no longer drags `content` or `references_json` along the wire, so the remaining failure mode is "two clients edit the same column concurrently." For `content` that means character-level conflicts (needs a text CRDT — bigger project, out of scope). For `references_json` it means concurrent array edits (separate question; out of scope). Both are *strictly* improved by this work even without further changes.
- **Server-side merge via a Postgres RPC, not PostgREST PATCH.** PostgREST `.update()` silently returns 0-rows-affected when the row is missing — the original footgun `applyBlockPatches` papered over with a full-row UPSERT. An RPC `apply_block_patches(patches jsonb)` does the merge in SQL, returns rowcount per id, and centralizes the conflict rules in one auditable place.
- **`blocks_history` trigger needs no changes.** It already records per-column diffs and skips no-op UPDATEs (`supabase/migrations/20260522062437_add_blocks_history.sql:115-125`). Narrower writes just produce narrower history rows.
- **Pull-down replay unchanged.** Server still pushes full rows back; local `BLOCKS_RAW_TABLE.put` continues to do `ON CONFLICT(id) DO UPDATE SET <all columns>`. That's correct because the server holds the merged truth.
- **Postgres column type stays `text` for this work.** Migrating `properties_json` / `references_json` to `jsonb` would let the RPC use native `||`/`-` without per-write casts, but its rollout-compat (old clients sending stringified JSON to a `jsonb` column → string scalar, breaks merges) is a separate problem worth handling in isolation. The RPC parses `text` to `jsonb`, merges, and casts back to `text` on assignment; microseconds per write, fine. JSONB across the data layer is a P2 follow-up — see `docs/follow-ups.md`.
- **Delete the v4 local-ephemeral backfill as phase 0.** `BACKFILL_LOCAL_EPHEMERAL_UPLOADS_SQL`, `LOCAL_EPHEMERAL_BACKFILL_MARKER_KEY`, `COUNT_LOCAL_EPHEMERAL_BACKFILL_PENDING_SQL`, and their bootstrap call sites (`clientSchema.ts:822-935`) come out in their own commit/PR ahead of the merge work. Lands first so later phases never have to plan for a second "full-row PATCH" emitter shape.

## The layers

### Layer 0 — tx engine: semantic-no-op guard

`tx.update` (`txEngine.ts:284`), `tx.setProperty` (`txEngine.ts:354`), and `tx.move` (`txEngine.ts:312`) should compare the proposed `after` shape against `before` (excluding metadata) and early-return if nothing user-meaningful changed. Drops the SQL UPDATE entirely; the trigger never fires; no `ps_crud` row queued; no upload.

For `tx.setProperty` the comparison is value-only on the single key (encoded via the codec, then JSON-stringified for stable equality). For `tx.update`, compare `content`, `references` (deep), and `properties` (deep). For `tx.move`, compare `parent_id` and `order_key`. References and properties are flat enough that a `JSON.stringify` equality check is fine; if it gets hot, switch to a structural comparison.

Subtle: the guard must run before `metadataPatch` is applied, so it sees the pre-metadata `after`. The current code merges `metadataPatch` into `after` unconditionally; reorder.

### Layer A — trigger: emit `old`

Extend `CREATE_BLOCKS_UPLOAD_UPDATE_TRIGGER_SQL` (`clientSchema.ts:435-453`) to add an `old` field alongside `data` in the envelope, but only when `properties_json` actually changed. Mirror the existing `__noop`-strip pattern used in `blockUploadPatchJsonSql`:

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

`blockUploadOldJsonSql` emits `OLD.properties_json` keyed under `$.properties_json` only when `OLD.properties_json IS NOT NEW.properties_json`, and the whole `old` field is stripped via `__noop` when no tracked columns changed.

Result: PowerSync's `CrudEntry.fromRow` parses the envelope. `entry.previousValues.properties_json` is present iff `properties_json` actually changed; `entry.previousValues` itself is undefined for PATCHes that didn't touch any tracked column.

**Trigger migration via DROP+CREATE.** `CLIENT_SCHEMA_STATEMENTS` runs `CREATE TRIGGER IF NOT EXISTS` (`repoProvider.ts:237-239`), so an upgraded local DB keeps its pre-change `blocks_upload_update` trigger unless we explicitly drop it. Prepend `DROP TRIGGER IF EXISTS blocks_upload_update;` immediately before the `CREATE TRIGGER` in `CLIENT_SCHEMA_STATEMENTS`. Cheap, idempotent, runs every bootstrap.

Scope of columns in `old`: just `properties_json` for v1 — that's the only column needing per-key merge. Adding more later is mechanical (same pattern per column). Keeping the set narrow keeps the envelope small.

### Layer B — uploader: ship a partial patch + property diff to an RPC

Replace the "load full row, ship UPSERT" path in `applyBlockPatches` (`powersync.ts:330-354`) with a single Supabase RPC call. Each entry carries `id` plus only the columns from `entry.opData` (already narrow — the trigger stripped unchanged columns), plus per-key property diff when applicable. Metadata columns (`updated_at`/`updated_by`) are ordinary optional `opData` columns: `metadataPatch()` returns `{}` when callers pass `{skipMetadata: true}` (e.g. `parseReferences` writing `tx.update(..., {references}, {skipMetadata: true})`), so the trigger envelope can validly omit them. Pass through whatever the entry has, don't fabricate missing ones. CREATEs (`applyBlockCreates`) stay as they are — PUT envelopes carry full rows by definition and use `ignoreDuplicates: true` for deterministic-id bootstrap collisions.

When a PATCH entry has `entry.opData.properties_json`, expect `entry.previousValues.properties_json` to also be set (the trigger always emits both or neither — if not, that's a programming bug; assert and throw). Parse both and compute:

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

If `entry.opData.properties_json` is absent, the RPC just applies the other columns; no property work needed.

**Compaction.** `compactBlockCrudEntries` (`powersync.ts:112`) keeps fusing same-tx PUT+PATCH (still safe — PUT carries the full row, PATCH overlays). **PATCH+PATCH fusion is disabled when either side carries `previousValues`** — emit them as separate compacted operations instead. Avoids the cross-PATCH diff-base reconciliation problem (the second PATCH's `old` is the first's `new`; fusing would silently drop intermediate keys). Same-tx multi-property writes ship as N RPC entries instead of 1; wire cost is a few hundred bytes per extra entry, negligible. **`CompactedBlockOperation` (`powersync.ts:25-42`) extends with `previousValues?: { properties_json?: string }`** so the trigger's `old.properties_json` survives into the uploader; the slot just passes through from the source `CrudEntry`, no fusion logic.

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

- **Soft delete vs property edit.** A delete and a concurrent property edit race: the delete wins (`deleted = 1`, column-LWW). A property edit that lands after merges into a tombstoned row; subsequent restore preserves the merged values.
- **CREATE in the same batch as a property PATCH.** Same-tx PUT+PATCH fusion still applies: a fused CREATE-with-property-patch ships as a full-row CREATE with the merged `properties_json` — no diff needed, the create defines the full state. The PATCH path with `previousValues` only matters for PATCHes against existing server rows.
- **First-ever PATCH to a row.** The very first PATCH after the CREATE has `OLD.properties_json` populated with the post-CREATE state (SQLite triggers always see OLD = current row). `old.properties_json` is always defined for a trigger-fired PATCH that changed `properties_json`.
- **Schema migration.** Client: DROP+CREATE the trigger in `CLIENT_SCHEMA_STATEMENTS` (idempotent). Server: add the `apply_block_patches` RPC. The coordinated rollout (Rollout section) ensures no client is in a half-upgraded state with mixed envelope shapes in its queue.
- **Derived `references_json` can be inconsistent after concurrent ref-property edits — potentially indefinitely.** `parseReferences` (post-commit processor in `src/plugins/references/`) watches property changes and writes the derived `references_json` column via its own `tx.update`. Each client's `references_json` write reflects only that client's local properties at the time. After Layer B merges properties_json across clients but leaves `references_json` as column-LWW, the server's references_json reflects only the last writer's view — backlinks/typed-ref queries for refs that didn't win the column race are missing. **`rowEventsTail` (`src/data/internals/rowEventsTail.ts`) updates cache and invalidates handles on sync arrival but does *not* dispatch post-commit processors** — `parseReferences` only runs on local `repo.tx` outcomes. So the stale `references_json` persists until the next *local* write to that block, which could be **seconds for hot blocks, indefinite for cold blocks** (a block whose only edits are remote ref-property changes never gets its refs recomputed locally). When a local edit does happen, `core.normalizeReferences` ensures the recompute is canonical and doesn't cause subsequent ping-pong. Still strictly better than today (today both props and refs get clobbered; new behavior loses only the derived refs). **Out of scope here as a deliberate triage decision** — the two real fixes (server-side recompute inside the RPC, requires porting `parseReferences` to PLpgSQL with full property-schema + ref-codec knowledge; or extending `rowEventsTail` to dispatch processors on sync-arrived field changes, requires non-trivial changes to the tail's sync-vs-tx separation) are both substantial work. Tracked as a P1 follow-up to revisit immediately after this ships, *not* a "telemetry-only" follow-up — for blocks that drive backlinks heavily, the indefinite-stale window is user-visible. Today's behavior is worse (full clobber on every concurrent edit), so net forward, but this is the next thing to fix.

## Phasing

0. **Phase 0: delete v4 local-ephemeral backfill** (small, mechanical). Remove `BACKFILL_LOCAL_EPHEMERAL_UPLOADS_SQL`, `LOCAL_EPHEMERAL_BACKFILL_MARKER_KEY`, `COUNT_LOCAL_EPHEMERAL_BACKFILL_PENDING_SQL`, `RECORD_LOCAL_EPHEMERAL_BACKFILL_DONE_SQL`, `SELECT_LOCAL_EPHEMERAL_BACKFILL_DONE_SQL`, and the bootstrap callers in `repoProvider.ts`. The per-client v4 marker confirms it ran. Lands first so later phases never have to plan for a second "full-row PATCH" emitter shape.
1. **Layer 0: semantic-no-op guard** (small, orthogonal). Add early-return in `tx.update`, `tx.setProperty`, `tx.move`. Test: `setProperty` to the current value produces no `ps_crud` row. Land independently.
2. **Layer A: trigger emits `old`** (small). Extend the trigger envelope with the `old` field (populated when `properties_json` changed; field stripped otherwise). DROP+CREATE in `CLIENT_SCHEMA_STATEMENTS`. Unit-test the envelope shape (introspect `ps_crud.data` after a `tx.update({properties})` and a content-only update). Uploader still ships full-row UPSERTs at this point — `entry.previousValues` is populated but unused. Strict no-op for end users; lands as plumbing.
3. **Layer B: uploader diff + RPC** (medium). Write `apply_block_patches(patches jsonb)` — parses `properties_json` text as jsonb in-flight, merges, casts back to text. Switch `applyBlockPatches` to call it. Disable PATCH+PATCH fusion in the compactor for entries carrying `previousValues`. Integration test: two-client conflict on different property keys converges to both keys present.

Phases 0–2 are no-op for users. Phase 3 is the one that fixes the cross-field and cross-key clobbers.

## Rollout

The work has two deployable artifacts: a Supabase migration (new RPC) and the client bundle (new trigger, new uploader). With a coordinated fleet (2 users, 5 devices), the legacy-queue compatibility surface is avoided entirely by draining each device's `ps_crud` before the swap.

1. **Deploy the Supabase migration.** Adds `apply_block_patches`. Old clients don't call it, so this is invisible to them. Deploy any time before the client bundle.
2. **Prepare each device for upgrade.** For every device:
   - Open the app on the old bundle, online.
   - Confirm `ps_crud` is empty (`SELECT count(*) FROM ps_crud` returns 0). The app already drains continuously when online; a fresh tab or a manual page reload after a moment online is usually enough.
   - At this point the device is safe to upgrade — no in-flight PATCHes that would carry the old envelope shape.
3. **Ship the client bundle.** Service worker promotes new versions on next navigation via `SKIP_WAITING` (`src/registerServiceWorker.ts:15-30`). With the queue drained on every device, every PATCH the new uploader sees has the new envelope.
4. **Operational gating** (optional but cheap): a tiny one-shot pre-upgrade check in the new bundle's bootstrap — if `ps_crud` is non-empty and contains any pre-upgrade `op='PATCH'` rows for `blocks`, refuse to enable the new uploader path on that session and surface a "Finish sync to upgrade" toast on the *old* tab if you have telemetry visibility. For a 5-device fleet this is overkill; the manual confirmation in step 2 covers it.
5. **Mixed-version window during rollout** (typically minutes, bounded by how quickly tabs reload):
   - Old tabs keep using PostgREST `.update()` against the unchanged `text` columns — exact today behavior. No regression.
   - New tabs use the RPC with per-key merge.
   - If an old tab and a new tab edit the same block concurrently, the old tab's full-row UPSERT can clobber the new tab's merged state. Blast radius equals today's, not worse.

## Open questions to settle before phase 3

- **Delete-key encoding.** Sentinel-in-`set` (`{key: __DELETED}`) vs separate `unset: string[]`. Voting for separate field — cleaner types, server can validate independently.
- **RPC error shape.** Per-id success/failure array, or first-error-aborts-batch. Match whatever the existing orchestrator's quarantine path expects.
- **What other "fields" are device-local hiding in `properties_json`?** Even with per-key merge, anything that's truly UI-only (scroll position, focus, transient zoom) should still come out of synced properties. Quick audit while we're in there is cheap insurance.

## Out of scope (intentionally)

- **Character-level content CRDT** (Yjs / Automerge / Loro). Separate project; column-LWW on `content` is acceptable for now.
- **Array-CRDT for `references_json`.** Same reasoning.
- **Per-property `updated_at` for true per-key LWW with causal ordering.** Today we get "server transaction order is the tiebreak," which is fine for the conflicts that actually occur. Revisit if telemetry shows simultaneous-key conflicts becoming common.
- **Schema split (`block_properties` table, row per key — possibly Tana-style "properties are child blocks").** The clean architectural answer to per-key merge: each property is its own row, per-row LWW is free, no JSON-merge plumbing. Larger project; this design buys most of the value without it. Worth a serious look once this work ships.
- **JSONB across the data layer** (both Postgres column type and SQLite local storage). Real perf project — the 29 `json_extract` / `json_each` callsites and per-write triggers in `clientSchema.ts` would benefit, plus Postgres GIN indexability. Deferred to its own scoped PR — see `docs/follow-ups.md`.
