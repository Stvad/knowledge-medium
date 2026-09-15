# row_events: storage + retention

> **Status:** superseded — absorbed into `docs/row-events-optimization.html`
> (compact events + sampled anchors; history is KEPT, the prune design below is
> dead). Also stale against code: `src/data/internals/rowEventsTail.ts` and the
> `local-ephemeral` source no longer exist (the Layout-B sync observer replaced
> the tail; nothing reads `row_events` at runtime), and the file path cited
> below is `src/data/internals/clientSchema.ts`. Kept for the problem framing
> and the scale numbers (§Problem) only. **Last verified against code:**
> 2026-07-15 (master `b581e60b`).

## Problem

`row_events` on ff-vlad-dev: ~1.17M rows, ~2 KB JSON per event, grows monotonically. The hot path it lives on is every block write — the trigger inlines a full domain-shape snapshot of the block in both `before_json` AND `after_json` (`blockJsonObjectSql`, [clientSchema.ts:238](src/data/internals/clientSchema.ts:238)), so write-tx tail latency tracks the JSON-build + insert cost.

Pruning alone treats the symptom (storage) but not the cause (per-write cost). Adopt the server-side `blocks_history` shape first; prune second.

## Reads we must preserve

- **Tail drain**: `WHERE id > ? AND id <= ? AND source = 'sync'` ([rowEventsTail.ts:148-154](src/data/internals/rowEventsTail.ts:148)). Watermark is in-memory; on cold start it's set to `MAX(id)` ([rowEventsTail.ts:383-388](src/data/internals/rowEventsTail.ts:383)). **No row needs to survive a restart for replay.**
- **Local-ephemeral backfill**: `BACKFILL_LOCAL_EPHEMERAL_UPLOADS_SQL` ([clientSchema.ts:912](src/data/internals/clientSchema.ts:912)) scans for `source='local-ephemeral'` rows without a later `'sync'` row. One-shot, gated by `client_schema_state.local_ephemeral_upload_backfill_v4`. After the marker lands on a device, the query never runs again.
- **Plugin invalidation rules** (`collectFromRowEvent`) — references rule reads `before.references` / `after.references` ([plugins/references/invalidation.ts:59](src/plugins/references/invalidation.ts:59)); kernel rule reads several fields ([kernelInvalidation.ts:423](src/data/internals/kernelInvalidation.ts:423)).
- **`cache.applySyncSnapshot(after)`** ([rowEventsTail.ts:261](src/data/internals/rowEventsTail.ts:261)) needs a full snapshot to feed the cache.

`cycleScanSql` and `sameTxProcessors` do NOT touch `row_events`.

## Approach

### 1. Shrink the write — adopt server's Option B

Mirror the shape already shipped in [supabase/migrations/20260522062437_add_blocks_history.sql](supabase/migrations/20260522062437_add_blocks_history.sql:18):

- **I**: `before_diff = NULL`, `after_diff = full row`.
- **U**: `before_diff` / `after_diff` = JSON object of **changed columns only**; identical-row UPDATEs skip entirely.
- **D**: `before_diff = full row`, `after_diff = NULL`.

Add a `changed_columns TEXT` column (JSON array) so consumers can distinguish "unchanged" from "missing". Rename `before_json`/`after_json` → `before_diff`/`after_diff` for parity with server.

Typical UPDATE in this codebase touches `updated_at` plus one of `content` / `properties_json` / `references_json` — diffed payload is a small fraction of today's "two full snapshots" cost.

### 2. Drain reads `blocks` for the full snapshot

`cache.applySyncSnapshot` needs the live row, not the at-trigger-time row. Replace `safeParseBlockData(r.after_json)` with a single bulk `SELECT * FROM blocks WHERE id IN (?, …)` per drain pass. Side benefit: eliminates the "trigger fired, then row mutated again before drain" stale-snapshot concern.

### 3. Plugin rule API gets `changedColumns`

Extend `InvalidationRowEvent` ([data/invalidation.ts:31](src/data/invalidation.ts:31)) with `changedColumns: ReadonlySet<string>`. Rules check membership before diffing — e.g. references rule short-circuits unless `'references_json' ∈ changedColumns`. `before` / `after` remain `BlockData | null` but are partial: missing keys = unchanged. Only two in-tree consumers to migrate.

### 4. Prune, idle-bootstrap pattern

Mirror `runAnalyzeIfDue` ([clientSchema.ts:1077](src/data/internals/clientSchema.ts:1077), scheduled at [repoProvider.ts:272](src/data/repoProvider.ts:272)). Marker key `row_events_prune_v1` in `client_schema_state`, interval 24 h. Per-pass query:

```sql
DELETE FROM row_events
 WHERE id < (SELECT MAX(id) FROM row_events) - :keep_recent
   AND created_at < :grace_cutoff
   AND NOT (
     source = 'local-ephemeral'
     AND NOT EXISTS (SELECT 1 FROM client_schema_state
                     WHERE key = 'local_ephemeral_upload_backfill_v4')
   );
```

`keep_recent` = 50 k (safety against pathological drain stalls); `grace_cutoff` = 7 days (debugging window). Single statement, no chunking — DELETE on a `(created_at)`-indexed range is fine at this scale; revisit if a real run lingers.

### Alternatives ruled out

- **Time-only pruning, keep full snapshots** — doesn't reduce per-write tail latency; the original complaint.
- **Drop both JSON cols, reconstruct everything from `blocks`** — breaks `before`-dependent rules (references can't compute target diff without the prior list).
- **Truncate just `properties_json` from snapshots** — half-measure; trigger still builds + inserts a fat blob on every write.
- **Prune on every Nth write** — puts cleanup back on the write-tx tail.

## TDD plan

1. **`clientSchema.test.ts` — trigger shape (TDD-first).** Insert/update/delete one block via the public path; assert `(op, changed_columns, before_diff, after_diff)`: full row for I, diff-only for U, full row for D. Cover the "identical UPDATE skipped" case.
2. **`rowEventsTail.test.ts` — drain over new shape.** Existing sync-write tests pass after switching the snapshot source from `after_json` to a `blocks` lookup. Add: rule receives populated `changedColumns`; rule that watches an unchanged field does NOT fire.
3. **`pruneRowEvents.test.ts` — new file.** Seed mixed rows (recent, old, local-ephemeral, with/without v4 marker); call `pruneRowEventsIfDue`; assert grace-window survival, marker gating, `keep_recent` floor, marker bookkeeping.
4. **Migration coexistence test.** Pre-insert one row in old shape (full `before_json`/`after_json`, `changed_columns IS NULL`); confirm tail still produces correct invalidation by treating `changed_columns IS NULL` as "full snapshot, all-fields-changed".
5. **Bench delta — manual.** Run `scripts/bench/bench-tail.ts` before/after on a seeded workspace; record write-tx tail latency + row_events bytes/event.

Verification gate: `pnpm run check` per [AGENTS.md](AGENTS.md).
