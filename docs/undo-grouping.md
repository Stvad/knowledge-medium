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
(`Object.create(repo)` with overrides that close over the real repo).
`tx` / `run` / `mutate` inject the token into `RepoTxOptions.groupId`;
nested `undoGroup` joins the outer group. Everything else delegates via
the prototype chain and so runs with the facade as `this` — safe for
reads and shared-object mutation, but three hazard classes need (and
have) explicit overrides:

- **shared-state minting** — `block()` caches `new Block(this, id)` in
  the repo-wide identity map; unfixed, a facade-bound Block would live
  there forever and every later ordinary edit through it would carry
  the dead group's token and merge into the stale entry. The override
  mints through the real repo.
- **construction-captured collaborators** — `addType` / `removeType` /
  `toggleType` / `setBlockTypes` go through `TypeTagger`, whose host was
  captured at Repo construction; they would open UNGROUPED txs mid-group
  and split it. The facade hosts its own `TypeTagger` (stateless
  wrapper; the facade satisfies `TypeTaggerHost` structurally).
- **field-assigning members** — `setActiveWorkspaceId` / `setReadOnly`
  (and `undo` / `redo`, whose metrics bookkeeping assigns fields) would
  shadow the write onto the facade. Delegated explicitly.

- **shared-closure minting** (same class as `block`) — `runQuery` would
  store a LoaderHandle whose resolver context captures the facade into
  the shared handle store (every future re-resolve would see the dead
  facade), and the `schedule*` job enqueuers would capture it into job
  queues that fire minutes later, opening GROUPED txs long after the
  group died. All delegate to the real repo — query resolution and
  deferred jobs are never group-bound.

What deliberately does NOT join a group (both land as foreign txs and
split it — use `grouped.tx` / `grouped.mutate` instead):

- **Block-facade sugar** — `grouped.block(id).setContent(...)` routes
  through `block.repo` = the real repo. A group-bound Block would be
  exactly the identity-map leak the `block` override closes (and Blocks
  escape callbacks routinely — helpers return them), so splitting is
  the safe behavior.
- **Stateful service writes** — `userSchemas` / `userTypes` /
  `projectors` are constructed against the real repo and own shared
  contribution buckets; a facade-hosted twin would clobber them.

Known edges (deliberate): a cmd-Z landed in the gap between two grouped
txs pops the partial entry to redo, and the next grouped tx's record
clears redo (invariant 5) — the first half becomes unrecoverable; the
window is microseconds for real composites. A group whose txs pin
different workspaces produces one entry per workspace manager (undo is
per-workspace); don't hand the facade to cross-workspace helpers.

The facade must not escape the callback — the token never expires, so a
leaked reference would stamp far-future txs into a long-dead group.
Adding a Repo member in one of the hazard classes means adding a facade
override (see the `undoGroup` jsdoc) — enforced structurally by
`src/data/test/repoFacadeGate.test.ts`: every Repo prototype member and
constructor-assigned instance property must be either facade-overridden
or classified on a reviewed allowlist, so an unclassified new member
fails the build until someone consciously decides its facade behavior.

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

### Rollout

`applySrsReschedulePlan` wraps its whole body in `block.repo.undoGroup`
(covering both the review-button path and the date-scrub commit path).
`RescheduleToast` matches the top entry by `groupId` instead of `txId`,
so a trailing same-group merge keeps the Undo button live while any
foreign entry disables it.

A follow-up audit (PR #308) grouped the other multi-tx composites:

- **`getOrCreateDailyNote`** groups internally (journal bootstrap +
  note create/repair can be two txs) — this fixes every pure caller at
  once (open-today/prev/next actions, QuickFind, DailyNotePicker, the
  daily-note landing). Callers that hand it their own facade fold it
  into their group via nested-join.
- **`appendTodayDailyBlockInStack`** (note + appended child),
  **`srsBlockDateAdapter.setIso`** (daily note + property write),
  **`createOrFindPlace`** (Locations-page bootstrap + place create),
  **`captureMedia`** (ASSETS-page bootstrap + asset mint) each wrap
  their composite in a caller-level group.

Audited and deliberately NOT grouped: the geo editor place-insert (the
link text lands via the editor's own flush pipeline in the common path
— cross-system, only the collision-toast fallback writes directly);
onboarding landing seeds (bootstrap, not an interactive action);
left-sidebar shortcuts bootstrap (cross-scope: UserPrefs +
BlockDefault can't merge); extract-type create/retag (two separate
dialogs = two intentional entries); Roam import (bulk, per-date
failure-isolated by design).

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
reschedule = exactly one undo entry, and one undo removes the daily notes";
each rollout site pins its own single-entry + undo-reverts-all test
(`dailyNotes.test.ts`, `srsBlockDateAdapter.test.ts`,
`createOrFindPlace.test.ts`). The facade override contract itself is
gated by `src/data/test/repoFacadeGate.test.ts`.

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
