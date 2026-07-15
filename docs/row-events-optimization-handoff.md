# row_events optimization — implementation handoff

> **Status:** working notes for the implementing session(s) of
> `docs/row-events-optimization.html` (the design; read it first — this file is
> the grounding shortcut, not the spec). **Last verified against code:**
> 2026-07-15 (master `b581e60b`; line refs refreshed at `10079dc1` after
> merging master into the PR branch).

## What this is

The design doc carries the argued decisions. This file carries what the next
session needs to start working without re-doing the code archaeology: the
verified anchor points, the slice plan with gates, the traps discovered while
grounding, and the open items that need a user call.

## First tasks for the implementing session

1. ~~Triage any Codex/PR review findings~~ — **DONE** (2026-07-15 takeover
   session): round-1 Codex P1 (probe-index timing → slice A marker-gated idle
   build) and all four P2s (delete-trigger OLD row ref, NULL-safe policy
   COALESCE, raw-write logging via a `tx_context.apply_kind` sync marker +
   three-way `source` tag, VACUUM gate sized at ~2× the *current* file) are
   folded into the design doc. Re-triage on new rounds.
2. Get user calls on the design doc's §16 open questions — especially **O1**
   (drop plaintext sync events before a `blocks_history` read RPC exists?) and
   **O2** (auto deep-idle VACUUM vs manual-first). Slice A is unaffected by
   both; slice B's sync-policy half depends on O1. **O5 (probe/deterministic
   cadence vs probabilistic anchors + invertible compact payloads) is now the
   biggest open call — it reshapes slice A and §3/§4/§8/§12.**
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
| Trigger recreation on every boot (fleet-wide body upgrades) | `withTriggerRecreate` `:1170-1175` |
| Bootstrap-only trigger suspension (bulk backfill precedent) | `withTriggerSuspended` `:1187-1200`, used `:1364-1373` |
| ALTER-add precedent **with ordering footgun** (column add must precede trigger recreation) | `ensureUndoGroupIdColumns` `:1375-1410`; call site `src/data/repoProvider.ts` (before the `CLIENT_SCHEMA_STATEMENTS` loop `:383-385`) |
| `client_schema_state` markers / idle jobs | `:182-187`; `src/data/internals/idleMarkerJobs.ts`; `src/utils/scheduleIdle.ts` |
| tx_context set/clear per tx; `command_events` insert | `src/data/internals/commitPipeline.ts:261-265`, `:348-368`, `:375-383` |
| `RepoTxOptions` (gets `historyMode`) | `src/data/api/tx.ts:269-277` |
| `TxSource = 'user'` only; `'sync'` is trigger output | `src/data/api/changeScope.ts:37-42` |
| Sync-apply writes `blocks` with `source = NULL` | `src/data/internals/syncObserver/materialize.ts:344` (upsert `:365`, delete `:395`, per-workspace materializability `:284-291` — the hook for `workspace_history_policy` writes) |
| PowerSync CRUD-apply touches only `blocks_synced` | `src/data/blockSchema.ts:112-131` |
| No WAL; `temp_store = MEMORY` (the VACUUM hazard); 256 MiB cache | `src/data/repoProvider.ts:312-316`, `:338-339` |
| ANALYZE drift check keys on `blocks` only (explicit ANALYZE after index changes) | `analyzeIsWarranted` `:1438-1455` |
| Raw-write path the drop policy must NOT catch (agent bridge `sql execute` → unguarded `repo.db.execute`; never uploads) | `src/plugins/agent-runtime/commands.ts:172`; guard scope `src/data/syncedTableWriteGuard.ts` wraps only the backfill execute (`repoProvider.ts:396`) |
| Manual-maintenance command precedent | `src/plugins/db-maintenance/plugin.ts` |
| Server `blocks_history` (shape, skip-identical, RLS, no read RPC yet) | `supabase/migrations/20260522062437_add_blocks_history.sql` (`:18-24`, `:115-125`, `:167-170`, `:177-192`, `:2-3`) |
| Upload compaction (server-history granularity caveat) | `src/services/powersync.ts:211` (used `:638`, `:672`) |
| Mode pin (per-(user,workspace), immutable) | `src/sync/keys/modePin.ts:2-16`, `:104-124` |
| Scale numbers (~1.17M × ~2 KB) | `docs/row-events-retention.md:4` (doc otherwise superseded) |
| PR #288 constraints (§12 bullet, "every chain starts full" invariant, slice-C gate) | `docs/properties-as-blocks-migration.html` on branch `claude/properties-as-blocks-migration-4b60xg` (verified at `a6407ed4`) |

## Slice plan (each lands green; details in design §13)

- **A — format.** ALTER-add `v`, `chain_pos` (mirror `ensureUndoGroupIdColumns`
  incl. its ordering constraint); build `(block_id, id)` as a marker-gated idle
  job BEFORE any v2 trigger body installs (the probe needs it — design §3);
  regenerate the three trigger bodies from a shared column spec (compact
  updates keyed on `OLD.x IS NOT NEW.x`, identical-update skip, anchor cadence
  W=50 via last-event probe, promotion on missing/v1 predecessor); `stateAt`
  reader utility; tests pin I1/I2/I4/I6. **Shape depends on the O5 call** —
  the probabilistic/invertible variant deletes the probe, `chain_pos`, and the
  index-timing dependency.
- **B — provenance + sync policy.** `tx_context.history_mode` +
  `RepoTxOptions.historyMode` ('skip'); `tx_context.apply_kind = 'sync'`
  marker in the materializer bracket + three-way `source` tag
  ('user'/'sync'/'raw' — raw always logs); `workspace_history_policy` table,
  written at the top of materialize Phase 2 per workspace in batch; NULL-safe
  trigger WHEN gates (`IS 'sync'`, `COALESCE(..., 'log')`; NEW for
  insert/update, OLD for delete); update the `:55-69` comment. **This
  unblocks #288 slice C.**
- **C — stock migration.** Per-block idle rewriter (`WHERE v IS NULL` is the
  work queue + partial index; anchors at cadence AND at before≠reconstructed
  discontinuities — that rule is what makes it reconstruction-lossless, test
  it); then decide retire-vs-retain for `idx_row_events_block
  (block_id, created_at DESC)` (per-block time-seek wants it — design §10
  subtree reader); explicit ANALYZE.
- **D — reclaim.** One-time full VACUUM: manual command first (O2), deep-idle
  one-shot behind markers + `navigator.storage.estimate()` check; bracket
  `temp_store = FILE` and verify OPFS temp-file behavior — fallback is
  `VACUUM INTO` + boot-time swap (machinery in `src/utils/exportSqliteDb.ts`).

## Traps found while grounding (don't rediscover these)

- **Trigger bodies referencing a column that doesn't exist yet fail at fire
  time, not create time** — the ALTER-before-recreation ordering is invisible
  until a concurrent old-tab write explodes (`clientSchema.ts:1384-1391`).
- **SQLite three-valued logic eats trigger WHEN gates**: a missing policy row
  makes `(subquery) = 'drop'` NULL, `NOT (TRUE AND NULL)` is NULL, and a NULL
  WHEN silently skips the INSERT — i.e. the fail-safe default silently drops.
  Every gate must be NULL-safe (`IS`, `COALESCE`). Same family: the delete
  trigger has no NEW row — row refs are per-trigger.
- **v2 chains must never count a v1 event as base** (trigger promotes on v1
  predecessor). Without this the slice-C rewriter would have to preserve
  arbitrary v1 events as full to avoid breaking live chains — with it, the
  rewriter needs zero coordination.
- **Migration must anchor at discontinuities** (event.before ≠ reconstructed
  prev state): v1 `before` is usually redundant but NOT where the log has gaps
  (trigger-suspended backfills, pre-log block life). Dropping those befores
  silently splices history.
- **`stateAt` walk order:** per-block order is `id`, not `created_at`
  (same-tx events tie on the ms timestamp) — hence the `(block_id, id)` index
  (now added in slice A; retire-vs-retain of the created_at one is slice C).
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
