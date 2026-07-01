# Per-key merge for `properties_json`

> **Status: exploration on hold (2026-05-27).** We're scoping a structural alternative — properties as child blocks (Tana-style) — that would retire most of the merge plumbing in this doc rather than implement it. Each reviewer round on this plan surfaced another corner where per-key merge semantics don't compose with the row-LWW + cache-acceptance + invalidation pipeline (latest example: P2 on the clamp-bypass scope below); accumulating those fixes is paying interest on a model mismatch. See `docs/properties-as-blocks-migration.html` for the alternative's design doc (rev 2, 2026-07-01; prototyped in PR #285). This doc stays as the record of where the merge-extension path got to and what it would cost; pick it back up only if the structural alternative is rejected.

Plan for closing the per-key last-write-wins gap on `blocks.properties_json`. After #52, the upload pipeline is column-narrow via `apply_block_patches` — a content edit no longer wipes a concurrent property edit. The remaining LWW failure mode lives *inside* `properties_json` itself: two clients editing different keys (A sets `foo`, B sets `bar`) both PATCH the same column under column-LWW, so one key silently disappears.

Fix: extend `apply_block_patches` with a per-key merge branch for `properties_json`, plumb the upload trigger to carry `old.properties_json` so the client can compute the diff, and close the derived `references_json` staleness window that server-side merge introduces.

Written 2026-05-27. Scope: `src/data/internals/clientSchema.ts` (trigger envelope), `src/services/powersync.ts` (uploader diff), `src/data/internals/rowEventsTail.ts` (sync-side parseReferences dispatch), one Supabase migration extending the existing RPC. No schema reset; no on-disk data migration; no Postgres column-type changes.

**Rollout assumption: coordinated upgrade with queue drain.** Fleet is small (2 users, 5 devices). Hold each device on the old code until `ps_crud` is empty, then swap. No mixed-version queue entries; no legacy envelope shapes to support post-upgrade.

## What's already in place (#52)

- `applyBlockPatches` ships `entry.opData` straight through the `apply_block_patches(patches jsonb)` RPC — no full-row re-load, no cross-column clobber.
- The RPC iterates the patches array in order (`WITH ORDINALITY ORDER BY ordinality`) and does column-LWW per row.
- Batching: N PATCHes ship as one HTTP call.
- Atomicity: any 0-rows-affected patch raises `P0002` (`no_data_found`), which rolls back the function's transaction so partial sibling UPDATEs never commit. The classifier (`uploadErrorClassifier.isPermanentSqlState`) recognises `P0002` as permanent → orchestrator quarantines.
- v4 local-ephemeral upload backfill deleted.

## What's left

- **Per-key clobber within `properties_json`.** A sets `foo`, B sets `bar`. Both PATCH the `properties_json` column under column-LWW. Whichever lands second silently strips the other's key. This is the motivating failure mode.
- **Derived `references_json` will go stale once merge lands.** `parseReferences` is a post-commit processor that runs only on local `repo.tx` outcomes. After Layer B merges `properties_json` server-side across clients, the loser's locally-computed `references_json` survives in its (still column-LWW) column — backlinks and typed-ref queries lag indefinitely on cold blocks until the user re-edits.
- **Cache-acceptance invariant breaks under merge.** `BlockCache.applyIfNewer` (`blockCache.ts:144`) rejects on `updatedAt <= existing.updatedAt`, AND `rowEventsTail` (`rowEventsTail.ts:200-214`) deliberately suppresses handle invalidation for rejected rows (`if (!accepted) continue` — the LWW gate acts on consumers too, not just the cache snapshot). That's correct under pure column-LWW — a snapshot with non-newer `updated_at` is strictly older content and consumers should keep their pre-flicker result. Once the server merges or applies derived writes, a row can be content-newer (contains keys from concurrent clients, or has recomputed derived columns) without a newer client-supplied `updated_at` — the cache rejects the genuinely-new state, the invalidation drops, and the row stalls on peer clients indefinitely until a metadata-bumping user edit.
- **No-op writes still upload.** `block.set(key, sameValue)` produces a metadata-only PATCH. Independent cheap win; not blocked on the merge work.

## Architecture decisions

- **Server-side merge as an extension of `apply_block_patches`, not a new RPC.** The function exists; add a branch that recognises `properties_set` / `properties_unset` keys in a patch and applies `(properties_json::jsonb || $set - $unset_array)::text`. Other columns keep their existing column-LWW behavior. Patches that don't touch properties hit the same code path as today.
- **Trigger emits `old.properties_json` so the client can compute the diff.** PowerSync's `Table.trackPrevious` schema flag doesn't apply — we use `RawTable` and our own `blocks_upload_update` trigger (`clientSchema.ts:435-453`). Extend the trigger's JSON envelope to also emit `old.properties_json` when `properties_json` actually changed. `CrudEntry.fromRow` parses this into `entry.previousValues.properties_json`; the uploader diffs new vs prev to produce set/unset.
- **RPC bumps `updated_at` and bypasses the clamp trigger for UPDATEs that opt in via an explicit marker.** Sync arrivals representing real content changes must be strictly-newer than any client's pre-merge view, or `BlockCache.applyIfNewer` rejects them on `updatedAt <= existing.updatedAt` *and* `rowEventsTail` suppresses handle invalidation for the rejected row (`rowEventsTail.ts:214`, `if (!accepted) continue`). That suppression is intentional under the existing LWW model but means the bump has to apply to every write whose content changed, not just merge writes — Layer C's derived-refs recompute (which is a column-LWW write to `references_json`, not a merge) would otherwise echo back with unchanged `updated_at` and stall on peer clients indefinitely until a metadata-bumping user edit. **Opt-in via a `_bypass_clamp: true` marker on the patch (or equivalent — e.g. presence of `properties_set`/`properties_unset` always implies it).** New-client merge and Layer C derived writes set it; legacy literal patches from old clients during the rollout window don't, and keep getting clamped by `blocks_clamp_updated_at`. Without this scoping, an old-client write with a clock-skewed `updated_at` would persist into the future where the trigger today would clamp it — i.e., the server migration stops being invisible to old clients. The existing `blocks_clamp_updated_at` BEFORE trigger clamps `NEW.updated_at` down to `server_now_ms`, which collapses the +1 bump for back-to-back same-ms writes — the RPC sets a transaction-local GUC (`set_config('app.skip_blocks_clamp', 'true', true)`) immediately before each opted-in UPDATE and resets it immediately after. Per-UPDATE set/reset is load-bearing because `set_config(..., true)` persists for the rest of the function transaction. Patches without `updated_at` (skipMetadata writes from post-commit `parseReferences` on local edits) don't bump at all.
- **`skipMetadata` writes preserve metadata for *local* post-commit derived-state writers, but Layer C dispatches *without* `skipMetadata`.** Today's post-commit `parseReferences` on a local edit writes `references_json` with `skipMetadata: true` so the derived write doesn't pile a second metadata bump on top of the user's already-bumped row — same `updated_at` for the user edit and the derived refs. Layer C is different: it's invoked from `rowEventsTail` in response to a sync arrival, with no surrounding user tx, so there's no metadata bump already in flight to preserve. If Layer C used `skipMetadata: true`, its `references_json` write would echo to peer clients with unchanged `updated_at` and the tail's `if (!accepted) continue` would drop the invalidation — exactly the failure mode the layer exists to prevent. Layer C therefore opens its `tx.update(..., {references})` without `skipMetadata`, so the write carries a metadata bump, the trigger envelope includes `updated_at`, the RPC's bump+bypass kicks in, and peer caches accept. `updated_by` becomes the user running the dispatching client — same attribution wart you'd already get under column-LWW from a user editing references directly. The post-commit `parseReferences` path on local edits keeps `skipMetadata: true` unchanged.
- **`blocks_history` needs no changes.** It already records per-column diffs and skips no-op UPDATEs (`20260522062437_add_blocks_history.sql:115-125`). Merged writes produce one history row per server-side UPDATE just like today.
- **Pull-down replay unchanged.** Server pushes full rows back; local `BLOCKS_RAW_TABLE.put` continues `ON CONFLICT(id) DO UPDATE SET <all columns>`. Server holds the merged truth.
- **Postgres column stays `text`.** Migrating `properties_json` / `references_json` to `jsonb` is a separate problem with its own rollout-compat surface (old clients send `JSON.stringify(...)` strings that land as JSONB string scalars, not objects). The merge RPC parses `text` to `jsonb` per-write — microseconds. See `docs/follow-ups.md` for the JSONB migration plan.

## The layers

### Layer A — trigger emits `old.properties_json`

Extend `CREATE_BLOCKS_UPLOAD_UPDATE_TRIGGER_SQL` (`clientSchema.ts:435-453`) to add an `old` field alongside `data`, populated only when `properties_json` actually changed. Mirror the `__noop`-strip pattern in `blockUploadPatchJsonSql`:

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

`blockUploadOldJsonSql` emits `OLD.properties_json` keyed under `$.properties_json` only when `OLD.properties_json IS NOT NEW.properties_json`, and the whole `old` field is stripped via `__noop` when nothing in the tracked set changed.

Result: `CrudEntry.fromRow` parses the envelope. `entry.previousValues.properties_json` is present iff `properties_json` actually changed; `entry.previousValues` itself is undefined for PATCHes that didn't touch any tracked column.

**Trigger migration via DROP+CREATE.** `CLIENT_SCHEMA_STATEMENTS` runs `CREATE TRIGGER IF NOT EXISTS` (`repoProvider.ts:237-239`), so an upgraded local DB keeps its pre-change trigger unless dropped. Prepend `DROP TRIGGER IF EXISTS blocks_upload_update;` immediately before the `CREATE TRIGGER`. Cheap, idempotent, runs every bootstrap.

Scope of columns in `old`: just `properties_json` for v1. Adding more later is mechanical (same pattern per column).

### Layer B — RPC merge branch for `properties_json`

Extend `apply_block_patches`. When a patch carries `properties_set` (a jsonb object of keys to set) or `properties_unset` (a jsonb array of keys to remove), apply:

```sql
properties_json = (
  (COALESCE(properties_json, '{}')::jsonb || COALESCE(patch->'properties_set', '{}'::jsonb))
  - COALESCE(ARRAY(SELECT jsonb_array_elements_text(patch->'properties_unset')), '{}'::text[])
)::text
```

`||` is shallow jsonb merge; `-` with a `text[]` removes keys. `properties_json` is a flat `Record<string, unknown>` (`src/data/api/blockData.ts`, `properties.ts:112-116`), so shallow merge is the right semantic. The `text::jsonb` parse and re-cast happen per-write inside the RPC — microseconds.

If a patch carries neither `properties_set` nor `properties_unset`, the RPC's existing column-LWW path runs unchanged. The literal `properties_json` patch key is no longer used for UPDATEs (the trigger emits set/unset for properties); CREATEs go through `applyBlockCreates` (PostgREST `.upsert()`), unrelated to this RPC.

**`updated_at` bump and clamp bypass — for opted-in UPDATEs only.** A patch opts in via `_bypass_clamp: true` (or implicitly via `properties_set`/`properties_unset`, which always require it). New-client merge writes and Layer C derived-refs writes set the marker; legacy literal patches from pre-upgrade clients don't, and continue to be clamped by `blocks_clamp_updated_at`. The cache-acceptance contract still holds: any sync arrival that needs peer caches to accept it sets the marker, gets the strictly-newer `updated_at`, and avoids the `if (!accepted) continue` invalidation drop.

```sql
-- inside the per-patch loop, around each UPDATE that opted in:
IF (patch->>'_bypass_clamp')::bool IS TRUE
   OR patch ? 'properties_set'
   OR patch ? 'properties_unset' THEN
  PERFORM set_config('app.skip_blocks_clamp', 'true', true);
  UPDATE blocks
  SET ...,                                                 -- merge or column-LWW columns
      updated_at = greatest(blocks.updated_at, (patch->>'updated_at')::bigint) + 1
  WHERE id = patch_id;
  PERFORM set_config('app.skip_blocks_clamp', 'false', true);
ELSE
  UPDATE blocks SET ... WHERE id = patch_id;              -- legacy path: trigger clamps
END IF;
```

`set_config(..., true)` is transaction-local: without the explicit reset, an earlier patch's bypass would silently apply to every later patch in the same RPC call. The set/reset pair keeps the bypass scoped to the opted-in UPDATE.

The clamp trigger gains a fast path:

```sql
IF current_setting('app.skip_blocks_clamp', true) = 'true' THEN
  RETURN NEW;
END IF;
-- existing server_now_ms clamp logic
```

When the patch lacks `updated_at` (post-commit `parseReferences` on a local user edit writes with `skipMetadata: true` → trigger strips `updated_at` from the envelope), neither bump nor clamp-bypass applies — `updated_at = blocks.updated_at`, same preservation behavior as #52. That write's invalidation is dropped on peer clients per the existing `if (!accepted) continue`, but it's already a redundant-state arrival in that case (the same property edit that triggered the local recompute is in flight as a separate patch, and Layer C on the receiving side recomputes refs from the merged properties locally — see Layer C below).

**Client uploader.** In `applyBlockPatchesRpc` (`powersync.ts:238-259`), when an entry has `entry.opData.properties_json` AND `entry.previousValues?.properties_json`, parse both and compute:

- `set`: keys whose value differs between new and prev, mapped to the new value.
- `unset`: keys present in prev but absent in new.

Replace the literal `properties_json` in the outgoing patch payload with `properties_set` and `properties_unset` (omit unset if empty to keep envelopes small). Entries that don't touch `properties_json` are unchanged. Assert that whenever `properties_json` is in `opData`, `previousValues.properties_json` is also defined — the trigger emits both or neither, so missing prev is a programming bug.

**Compaction.** `compactBlockCrudEntries` (`powersync.ts:112`) keeps fusing same-tx PUT+PATCH (PUT carries the full row; PATCH overlays — still correct). **PATCH+PATCH fusion is disabled when either side carries `previousValues`** — emit them as separate compacted operations instead. Same-tx multi-property writes ship as N RPC entries instead of 1; wire cost is negligible. Avoids the cross-PATCH diff-base reconciliation problem (the second PATCH's `old` is the first's `new`; fusing would silently drop intermediate keys). `CompactedBlockOperation` (`powersync.ts:25-42`) extends with `previousValues?: { properties_json?: string }` — passes through from the source `CrudEntry`, no fusion logic.

**Patches still apply in array order.** Already true from #52 (`WITH ORDINALITY ORDER BY ordinality`). A key edited across multiple PATCHes in the same batch applies the second `set` last.

### Layer C — sync-side `parseReferences` dispatch

After Layer B, `properties_json` merges correctly across clients, but `references_json` is still column-LWW. `parseReferences` is a post-commit processor — it runs only on local `repo.tx` outcomes, never on sync arrivals (`rowEventsTail` is explicitly an invalidation/cache-update path). So without Layer C, after a concurrent ref-property merge, the local `references_json` lags **indefinitely** for cold blocks until the user re-edits.

Fix: hook `rowEventsTail` to invoke `parseReferences` on sync-arrived `properties_json` changes.

Implementation shape:

- In `rowEventsTail` (`src/data/internals/rowEventsTail.ts`), when processing a sync-arrived row whose `before_json.properties` differs from `after_json.properties` (key is `properties`, not `properties_json` — `row_events.{before,after}_json` is produced in domain shape by `blockJsonObjectSql` in `clientSchema.ts:270`, parsed into `BlockData` by the tail), enqueue a sync-side parseReferences invocation for that block id.
- **Gate on cache acceptance.** Dispatch only when `cache.applyIfNewer` returns `true` for the snapshot. Stale rejections (clock-skew echoes, in-flight query replay) are already counted in `metrics.applyIfNewerRejected`; suppressing dispatch on rejection is one extra read of that boolean. The gate is meaningful **because** Layer B's `updated_at` bump guarantees merged sync arrivals are strictly-newer than any client's pre-merge view — cache acceptance and content freshness coincide.
- **Throttle.** Within-tick coalescing using the tail's existing window so a workspace cold-sync becomes one dispatch per affected block, not one per arrival.
- **Need a sync-side reparse entry point, separate from the existing post-commit processor.** Today's `parseReferencesProcessor` (`src/plugins/references/referencesProcessor.ts:213`) hard-codes `tx.update(plan.sourceId, {references: plan.references}, {skipMetadata: true})` — there's no parameter to flip it. Layer C needs the same planning logic (read current row, run the parser, `planNeedsWrite` check) but without `skipMetadata`. Smallest change: extract the planning/write step into a shared helper that takes a `{skipMetadata: boolean}` flag, and expose a `reparseReferencesFromSync(blockId)` entry point that calls it with `skipMetadata: false`. The post-commit processor keeps calling it with `skipMetadata: true`; the tail calls the sync entry point. Don't change the processor's call site directly — local edits should keep the existing "don't pile a second metadata bump on the user's already-bumped row" behavior.
- **Why the sync path drops `skipMetadata`.** Local `tx.update(id, {references})` without `skipMetadata` bumps `updated_at`/`updated_by` via `metadataPatch()`, the trigger envelope includes `updated_at`, the RPC's bump+bypass kicks in, and the sync echo to peer clients is strictly-newer than what their caches hold. Without this, the recompute write would echo back with unchanged `updated_at`, peer caches would reject via `applyIfNewer` on `<=`, and `rowEventsTail` would suppress handle invalidation for the rejected row (`rowEventsTail.ts:214`) — derived refs would stall on peer clients until a metadata-bumping user edit.
- The shared write helper reads the current local row at write time, computes refs from current `properties`, and writes only if `planNeedsWrite` says the refs differ from what's stored. Already idempotent — most peer-client dispatches that fire after another client's recompute already landed will planNeedsWrite-skip without writing.

**Why this doesn't ping-pong.** `core.normalizeReferences` (same-tx, `normalizeReferencesProcessor.ts`) canonicalises the refs output. All clients computing parseReferences from identical merged properties produce identical canonical refs. After one client's recompute write lands and echoes to peers, peer caches accept (strictly-newer `updated_at`), peer SQL rows update via PowerSync put, and any concurrent peer-side Layer C dispatch sees `parseReferences(merged_props) === currently_stored_refs` via `planNeedsWrite` and skips the upload. Convergence in one round trip with at most N redundant writes (one per client that raced) — and column-LWW just picks one since the content is identical anyway.

**Scope intentionally narrow.** This is "tail invokes one specific processor on one specific column change," not "tail dispatches the general post-commit processor framework based on watcher metadata." ~50-100 lines in `rowEventsTail.ts` plus a hook the references plugin registers. Generalize if a second use case shows up.

**Spec note.** `rowEventsTail`'s header comment will need a paragraph: "in addition to invalidation, the tail dispatches `parseReferences` on sync-arrived property changes because the canonical refs are derived from properties; without this, the server's merged properties leave clients with stale derived refs." Real change to the tail's contract — minor but worth being explicit.

### Layer 0 (optional, independent) — semantic-no-op guard

Independent of the merge work, shippable on its own. `tx.update` (`txEngine.ts:284`), `tx.setProperty` (`txEngine.ts:354`), and `tx.move` (`txEngine.ts:312`) all call `metadataPatch` and bump `updated_at`/`updated_by` even when the user-visible payload is identical to before. Result: `block.set(key, sameValue)` produces a metadata-only PATCH that uploads.

Fix: in each entry point, compare the proposed `after` shape against `before` (excluding metadata) and early-return if nothing user-meaningful changed. Drops the SQL UPDATE; the trigger doesn't fire; no `ps_crud` row queued; no upload.

Subtle: the guard must run before `metadataPatch` is merged into `after`. Current code merges unconditionally — reorder.

For `tx.setProperty`, the comparison is value-only on the single key (encoded via the codec, then JSON-stringified for stable equality). For `tx.update`, compare `content`, `references` (deep), and `properties` (deep). For `tx.move`, compare `parent_id` and `order_key`.

## What gets sent over the wire (example)

Today (after #52), `block.set(isCollapsedProp, true)` ships:

```json
{
  "id": "abc",
  "properties_json": "{...whole properties object with collapsed:true...}",
  "updated_at": 1, "updated_by": "u"
}
```

After this work:

```json
{
  "id": "abc",
  "properties_set": { "system:collapsed": true },
  "updated_at": 1, "updated_by": "u"
}
```

(`properties_unset` omitted when empty.)

## Edge cases

- **CREATE + property PATCH in the same tx.** Same-tx PUT+PATCH fusion still applies: a fused CREATE-with-property-patch ships as a full-row CREATE with the merged `properties_json` — no diff needed, the create defines the full state. The diff path applies only to PATCHes against existing server rows.
- **First-ever PATCH to a row.** `OLD.properties_json` is populated with the post-CREATE state by the SQLite trigger (OLD = current row state). The diff is well-defined.
- **Soft delete vs property edit.** Delete is column-LWW (`deleted = 1`); a concurrent property edit that lands after the delete merges into the tombstoned row. Subsequent restore preserves the merged values.
- **Patch with no property change.** Neither `properties_set` nor `properties_unset` present — the RPC's existing column-LWW path runs unchanged. Same wire as today for content-only or move-only edits.
- **Schema migration.** Client: DROP+CREATE trigger in `CLIENT_SCHEMA_STATEMENTS`. Server: a new Supabase migration extending `apply_block_patches`. Coordinated rollout ensures no client is in a half-upgraded state with mixed envelope shapes in its queue.

## Phasing

1. **Layer A: trigger emits `old.properties_json`** (small). DROP+CREATE in `CLIENT_SCHEMA_STATEMENTS`. Test the envelope shape against a `tx.update({properties})` and a content-only update. Uploader doesn't read `previousValues` yet — strict no-op for end users; lands as plumbing.
2. **Layer B: RPC merge branch + uploader diff** (medium). New Supabase migration extending `apply_block_patches` with the `properties_set`/`properties_unset` branch, the clamp-bypass GUC, and the `updated_at` bump. Update `applyBlockPatchesRpc` to compute the diff from `previousValues` when present. Disable PATCH+PATCH fusion in the compactor for entries carrying `previousValues`. pgTAP coverage for the merge SQL; Vitest coverage for the diff-compute path. Integration test: two-client conflict on different property keys converges to both keys present.
3. **Layer C: sync-side `parseReferences` dispatch** (small-medium). Tail-side narrow dispatch on sync-arrived property changes. Test: two clients concurrently set different ref-typed properties → both clients eventually have `references_json` containing both refs without re-editing.

Layer 0 (no-op guard) is independent and can land before, between, or after — no ordering dependency on the merge work.

## Rollout

Two artifacts: the Supabase migration (extending the RPC) and the client bundle (new trigger envelope, new uploader diff path).

1. **Deploy the Supabase migration.** The extension adds `properties_set`/`properties_unset` recognition while leaving the existing column-LWW path untouched. Old client patches (no `properties_set` key) go through the old path. Invisible to old clients; safe to ship any time before the client bundle.
2. **Prepare each device for upgrade.** For every device: open the app on the old bundle online, confirm `ps_crud` is empty. The app drains continuously when online; a moment on a fresh tab is usually enough.
3. **Ship the client bundle.** Service worker promotes new versions on next navigation via `SKIP_WAITING` (`registerServiceWorker.ts:15-30`). With queues drained, every PATCH the new uploader sees has the new envelope (`previousValues` populated when properties changed).
4. **Mixed-version window** (minutes, bounded by reload speed):
   - Old tabs still send literal `properties_json` patches through the RPC's column-LWW path. Exact today behavior — no regression.
   - New tabs use the merge path.
   - Concurrent edits between old and new tabs: the old tab's literal-column-write can clobber the new tab's merge in the column-LWW direction. Blast radius equals today's, not worse.

## Open questions

- **Delete-key encoding.** Going with separate `properties_set` + `properties_unset` rather than a sentinel-in-set form. Cleaner types; server can validate independently.
- **Audit of UI-only state still in `properties_json`.** Even with per-key merge, anything truly device-local (scroll position, focus, transient zoom) shouldn't be in synced properties. Quick audit while in the area is cheap insurance.

## Out of scope (intentionally)

- **Character-level content CRDT** (Yjs / Automerge / Loro). Separate project; column-LWW on `content` is fine for now.
- **Array-CRDT for `references_json`.** Same reasoning.
- **Per-property `updated_at` for true per-key LWW with causal ordering.** Today we get "server transaction order is the tiebreak," which is fine for the conflicts that actually occur. Revisit if telemetry shows simultaneous-key conflicts becoming common.
- **Schema split** (`block_properties` table, row per key — possibly Tana-style "properties are child blocks"). The clean architectural answer: each property is its own row, per-row LWW is free, no JSON-merge plumbing. Larger project; this design buys most of the value without it. Worth a serious look once this work ships.
- **JSONB across the data layer** (Postgres column + local SQLite). Real perf project — deferred to its own scoped PR, see `docs/follow-ups.md`.
