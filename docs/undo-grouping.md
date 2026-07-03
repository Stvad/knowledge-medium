# Undo grouping — merge-at-record for multi-tx composite operations

> **Status:** current — last verified against code 2026-07-03 (issue #306 implementation commit).

## Problem

A single user-perceived action can span several `repo.tx` calls. The
canonical case is the SRS reschedule: `applySrsReschedulePlan` calls
`getOrCreateDailyNote` twice (next-review date + reviewed date) before its
own property write, and on a fresh workspace day each of those can open its
own tx (daily note, journal block). One "Good" tap = 2–4 undo entries;
cmd-Z (or the toast's Undo) reverted only the property write and left the
freshly created daily notes behind.

The rejected alternative (docs/follow-ups.md, superseded entry): thread an
optional `Tx` through `getOrCreateDailyNote` / `getOrCreateJournalBlock` so
the whole action runs in ONE tx. That forces every composite-capable helper
to grow an in-tx variant and couples callers to helper internals.
Merge-at-record leaves helpers untouched — they join a group by being
handed a `Repo`-shaped facade.

## Design

### Merge-at-record (`UndoManager.record`)

`UndoEntry` carries an optional `groupId` and a lazily-materialized
`steps: {txId, description?}[]`. When `record` receives an entry whose
`groupId` matches the **top-of-stack** entry of the same scope, it merges
instead of pushing:

- **snapshots** fold per block with the same rule `recordWrite` uses
  within a tx: keep the earliest `before`, take the latest `after`
  (`mergeSnapshotsInto` in `txSnapshots.ts`). So create-then-update folds
  to `(null → latest)` and undo takes the inverse-of-create path.
- **steps** append (a lone entry is implicitly its own single step;
  `steps` materializes on first merge).
- **description** takes the incoming tx's — the last step of a composite
  names the user-perceived action (`'srs reschedule'`, not
  `'create daily note'`).
- the **redo stack clears** and subscribers are notified exactly once,
  after the clear — same ordering contract as a plain record.

Merging only ever targets the top entry. A foreign tx landing mid-group
therefore **splits** the group into two entries — undo never reorders
history and can never revert the foreign write as part of the group.

### `repo.undoGroup(fn)`

Mints a `groupId` and passes `fn` a `Repo`-shaped facade
(`Object.create(repo)` + four overrides — `tx`, `run`, `mutate`,
`undoGroup`). Each override closes over the real repo and injects the
token into `RepoTxOptions.groupId`, so repo internals never execute with
the facade as `this`. Everything else (reads, `block()`, `load`,
`addTypeInTx`, …) delegates via the prototype chain. Nested
`undoGroup` on the facade joins the outer group.

Grouping is **not** atomicity: each tx still commits independently. If a
later tx throws, the committed prefix stays applied, remains covered by
the single group entry, and the error propagates to the `undoGroup`
caller.

### Persistence (`tx_context.group_id` → `row_events.group_id`)

`group_id TEXT` columns on `tx_context` and `row_events`. The commit
pipeline stamps `tx_context.group_id` in step 1 and clears it in step 5;
the three row_events triggers project it with the same source gate as
`tx_id` (NULL for sync-applied writes, stale-value belt-and-suspenders
included). In-memory undo doesn't read these back — they exist so the
events log records composite-operation identity for the future
events-derived undo (§16.6) and for debugging.

Migration: `ensureUndoGroupIdColumns` (PRAGMA table_info + additive
`ALTER TABLE`) runs in `repoProvider` **before** `CLIENT_SCHEMA_STATEMENTS`
— the force-recreated trigger bodies reference the column. Fresh DBs skip
it; the CREATE statements carry the column (appended last, so fresh and
ALTER-upgraded layouts match). No backfill: NULL means "ungrouped", which
is correct for all pre-existing history. `row_events` is never dropped.

### Reschedule rollout

`applySrsReschedulePlan` wraps its whole body in `block.repo.undoGroup`
(covering both the review-button path and the date-scrub commit path).
`RescheduleToast` matches the top entry by `groupId` instead of `txId`,
so a trailing same-group merge keeps the Undo button live while any
foreign entry disables it.

## Invariants (test coverage)

| # | Invariant | Test |
|---|---|---|
| 1 | N grouped txs → one entry; undo reverts all, redo re-applies | `repoUndoGroup.test.ts` |
| 2 | Fold: earliest `before`, latest `after` | `undoManager.test.ts` |
| 3 | Create-then-update → undo removes the block | both |
| 4 | Foreign tx splits the group; undo can't touch it via the group | both |
| 5 | Merge clears redo; `depths()` reports 1 | both |
| 6 | `grouped.mutate.X` / `grouped.run` join the group | `repoUndoGroup.test.ts` |
| 7 | Ungrouped txs unchanged | `repoUndoGroup.test.ts` |
| 8 | Partial failure → one entry covering committed prefix | `repoUndoGroup.test.ts` |
| 9 | Nested `undoGroup` joins the outer group | `repoUndoGroup.test.ts` |
| 10 | `row_events.group_id` under group; NULL for sync/ungrouped | `repoUndoGroup.test.ts`, `clientSchema.test.ts` |
| 11 | Pre-existing DBs get the column without data loss | `clientSchema.test.ts` |

End-to-end: `srs-rescheduling/test/actions.test.ts` pins "fresh-workspace
reschedule = exactly one undo entry, and one undo removes the daily notes".

## Out of scope (deliberately)

- Auto-grouping at action dispatch (every action handler silently
  grouped) — needs its own design pass on action boundaries.
- Per-step snapshots / "step into a group" UI — `steps` records the
  txIds so this stays possible.
- Events-derived persistent undo (§16.6) — `group_id` in `row_events` is
  the hook.
- Migrating other composite actions (duplicate-with-schedule, calendar
  drag-to-reschedule, …) — mechanical follow-ups on this seam.
- Typing/checkpoint coalescing (§16.4) — different problem; group merge
  only folds txs that explicitly share a minted token.
