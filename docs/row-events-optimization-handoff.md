# row_events optimization — implementation handoff

> **Status:** working notes for the implementing session(s) of
> `docs/row-events-optimization.html` (the design; read it first — this file is
> the grounding shortcut, not the spec). **Last verified against code:**
> 2026-07-15 (master `b581e60b`).

## What this is

The design doc carries the argued decisions. This file carries what the next
session needs to start working without re-doing the code archaeology: the
verified anchor points, the slice plan with gates, the traps discovered while
grounding, and the open items that need a user call.

## First tasks for the implementing session

1. Triage any Codex/PR review findings on the design PR itself (the authoring
   session did not stay subscribed) — fix valid P1/P2s in the doc before
   building against it.
2. Get user calls on the design doc's §16 open questions — especially **O1**
   (drop plaintext sync events before a `blocks_history` read RPC exists?) and
   **O2** (auto deep-idle VACUUM vs manual-first). Slice A is unaffected by
   both; slice B's sync-policy half depends on O1.
3. Implement slice A (see plan below). PR #288's slice C is gated on A+B —
   check that project's state before sequencing.

## Verified anchor points (master `b581e60b`)

All in `src/data/internals/clientSchema.ts` unless noted:

| What | Where |
|---|---|
| `row_events` table + indexes | `:70-97` (doc comment `:55-69` — update it in slice B) |
| Snapshot serializer `blockJsonObjectSql` (13 domain fields) | `:386-402` |
| Source gate + `COALESCE(...,'sync')` | `:404-425` |
| The 3 row_events triggers (create/update+soft-delete/delete) | `:427-488` |
| Changed-cols-only JSON in pure trigger SQL (the pattern to reuse) | `blockUploadPatchJsonSql` `:552-563`; diff predicate `:542-544`; column spec `BLOCK_UPLOAD_COLUMNS` `:518-534` |
| Trigger recreation on every boot (fleet-wide body upgrades) | `withTriggerRecreate` `:1151-1172` |
| Bootstrap-only trigger suspension (bulk backfill precedent) | `withTriggerSuspended` `:1174-1197`, used `:1361-1370` |
| ALTER-add precedent **with ordering footgun** (column add must precede trigger recreation) | `ensureUndoGroupIdColumns` `:1373-1407`; call site `src/data/repoProvider.ts` (before the `CLIENT_SCHEMA_STATEMENTS` loop `:383-385`) |
| `client_schema_state` markers / idle jobs | `:182-187`; `src/data/internals/idleMarkerJobs.ts`; `src/utils/scheduleIdle.ts` |
| tx_context set/clear per tx; `command_events` insert | `src/data/internals/commitPipeline.ts:261-264`, `:339-357`, `:365-367` |
| `RepoTxOptions` (gets `historyMode`) | `src/data/api/tx.ts:269-277` |
| `TxSource = 'user'` only; `'sync'` is trigger output | `src/data/api/changeScope.ts:37-42` |
| Sync-apply writes `blocks` with `source = NULL` | `src/data/internals/syncObserver/materialize.ts:344` (upsert `:365`, delete `:395`, per-workspace materializability `:284-291` — the hook for `workspace_history_policy` writes) |
| PowerSync CRUD-apply touches only `blocks_synced` | `src/data/blockSchema.ts:112-131` |
| No WAL; `temp_store = MEMORY` (the VACUUM hazard); 256 MiB cache | `src/data/repoProvider.ts:312-316`, `:338-339` |
| ANALYZE drift check keys on `blocks` only (explicit ANALYZE after index swap) | `analyzeIsWarranted` `:1436-1453` |
| Manual-maintenance command precedent | `src/plugins/db-maintenance/plugin.ts` |
| Server `blocks_history` (shape, skip-identical, RLS, no read RPC yet) | `supabase/migrations/20260522062437_add_blocks_history.sql` (`:18-24`, `:115-125`, `:167-170`, `:177-192`, `:2-3`) |
| Upload compaction (server-history granularity caveat) | `src/services/powersync.ts:211` (used `:638`, `:672`) |
| Mode pin (per-(user,workspace), immutable) | `src/sync/keys/modePin.ts:2-16`, `:104-124` |
| Scale numbers (~1.17M × ~2 KB) | `docs/row-events-retention.md:4` (doc otherwise superseded) |
| PR #288 constraints (§12 bullet, "every chain starts full" invariant, slice-C gate) | `docs/properties-as-blocks-migration.html` on branch `claude/properties-as-blocks-migration-4b60xg` (verified at `a6407ed4`) |

## Slice plan (each lands green; details in design §13)

- **A — format.** ALTER-add `v`, `chain_pos` (mirror `ensureUndoGroupIdColumns`
  incl. its ordering constraint); regenerate the three trigger bodies from a
  shared column spec (compact updates keyed on `OLD.x IS NOT NEW.x`,
  identical-update skip, anchor cadence W=50 via last-event probe, promotion on
  missing/v1 predecessor); `stateAt` reader utility; tests pin I1/I2/I4/I6.
- **B — provenance + sync policy.** `tx_context.history_mode` +
  `RepoTxOptions.historyMode` ('skip'); `workspace_history_policy` table,
  written at the top of materialize Phase 2 per workspace in batch; trigger
  WHEN gates; update the `:55-69` comment. **This unblocks #288 slice C.**
- **C — stock migration.** Per-block idle rewriter (`WHERE v IS NULL` is the
  work queue + partial index; anchors at cadence AND at before≠reconstructed
  discontinuities — that rule is what makes it reconstruction-lossless, test
  it); then swap `idx_row_events_block` → `(block_id, id)`; explicit ANALYZE.
- **D — reclaim.** One-time full VACUUM: manual command first (O2), deep-idle
  one-shot behind markers + `navigator.storage.estimate()` check; bracket
  `temp_store = FILE` and verify OPFS temp-file behavior — fallback is
  `VACUUM INTO` + boot-time swap (machinery in `src/utils/exportSqliteDb.ts`).

## Traps found while grounding (don't rediscover these)

- **Trigger bodies referencing a column that doesn't exist yet fail at fire
  time, not create time** — the ALTER-before-recreation ordering is invisible
  until a concurrent old-tab write explodes (`clientSchema.ts:1381-1394`).
- **v2 chains must never count a v1 event as base** (trigger promotes on v1
  predecessor). Without this the slice-C rewriter would have to preserve
  arbitrary v1 events as full to avoid breaking live chains — with it, the
  rewriter needs zero coordination.
- **Migration must anchor at discontinuities** (event.before ≠ reconstructed
  prev state): v1 `before` is usually redundant but NOT where the log has gaps
  (trigger-suspended backfills, pre-log block life). Dropping those befores
  silently splices history.
- **`stateAt` walk order:** per-block order is `id`, not `created_at`
  (same-tx events tie on the ms timestamp) — hence the index swap.
- **Test idiom:** proving "this write logged nothing" — poll with `vi.waitFor`
  on a control write (FIFO fence is sound for raw table reads), never
  `setTimeout`; share one DB per test file (`createTestDb` once,
  `resetTestDb` per test). See AGENTS.md testing section.
- **`yarn run check` before commit; iterate per-file with `yarn vitest run
  <path>`.** Bench slice A's write-tail delta (I6) informally via the timing
  metrics in `src/data/internals/timingMetrics.ts`.

## Numbers to re-measure before slice C/D on a real instance

- Event-kind mix (the §12 arithmetic assumes ~30/65/5 create/update/delete —
  stated, not measured): `yarn agent sql all "select kind, source, count(*)
  from row_events group by 1, 2"`.
- Mean payload sizes per kind: `avg(length(before_json)+length(after_json))`.
- DB file size + `navigator.storage.estimate()` before/after slice D.
