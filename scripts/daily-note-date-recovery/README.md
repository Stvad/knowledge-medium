# `daily-note:date` recovery (ff-vlad-dev)

One-time restore of the `daily-note:date` property onto the daily notes that
lost it. The property is the indexable calendar-day value the query layer needs
(SRS due-dates, date filters); see `src/plugins/daily-notes/schema.ts`.

**Status: authored, NOT executed.** The recovery writes to shared/synced infra
(~4,075 rows). Hold for explicit approval + a coordinated window.

## What happened (verified 2026-06-16 via the agent bridge)

The write path was **never** broken. The current backfill
(`src/plugins/daily-notes/backfill.ts`, commit `ef0ad445`) writes through
`repo.tx`, so its rows carry `source='user'` and upload — proven by
`backfill.test.ts` (`expect(await uploadOps(id)).toContain('PATCH')`) and by the
52 daily notes that still carry the property today (set on the creation path,
synced fine).

The failure is the **one-shot marker**, not the write path:

- `Repo.scheduleWorkspaceBackfills` runs each `WorkspaceBackfill` **at most once
  per (workspace, client)**, gated by a `workspace_backfill:<ws>:<id>` row in the
  local `client_schema_state` table.
- That marker is present on `ff-vlad-dev`
  (`workspace_backfill:ef43b424-…:daily-note-date-from-alias`), so the backfill
  has already "run" and refuses to run again.
- When it ran (after `ef0ad445`, 2026-06-09), the rows still carried the
  *local-only* value the original 2026-05-18 raw-`db.execute` backfill had
  written but never uploaded. The in-tx recheck
  (`block.properties[...] !== undefined`) therefore skipped every row — a clean,
  **write-nothing** run — yet still recorded the marker. (Consistent with the
  observed `ps_crud` having **0** `daily-note:date` ops.)
- A server-authoritative pass on 2026-06-14 then dropped those never-synced
  local values, leaving the rows with `daily-note:date` genuinely NULL on both
  local and server.

Net: ~4,075 rows are NULL, eligible for the backfill's exact `IS NULL` +
valid-ISO-alias condition, but the marker permanently blocks the re-run. The
root-cause investigation of *what* dropped the values on 2026-06-14 is tracked
separately and out of scope here.

## Blast radius (measured on `ff-vlad-dev`)

| workspace | daily notes | missing `daily-note:date` |
|---|---|---|
| `ef43b424-80ba-4967-b587-a4c32efd8071` | 4,127 | **4,075** |
| `f8982ba0-c4b1-4662-b4b8-97e5aad48819` | 1 | 0 |

All 4,075 carry a valid ISO alias (e.g. `["June 8th, 2026","2026-06-08"]`), so
the date is recoverable from the alias. The upload queue is fully drained
(`ps_crud` = 0), i.e. sync is otherwise healthy.

## The code fix (committed)

`src/plugins/daily-notes/backfill.ts` bumps the backfill `id`
(`daily-note-date-from-alias` → `daily-note-date-from-alias-v2`). This is the
documented `WorkspaceBackfill.id` escape hatch ("Change it to force a re-run on
every workspace"): the new key doesn't match the old marker, so each workspace
re-runs the backfill exactly once. The rows are NULL now, so the in-tx recheck
passes and the writes actually happen + upload — unlike the 2026-06-09 no-op.

Once this re-run uploads, the server holds `daily-note:date` (it never did
before), so a future server-authoritative pass preserves it rather than
dropping it.

## Recovery — pick one (both HELD pending approval)

Both paths use the same uploading `repo.tx` + `setProperty` write; both are
idempotent (re-checks NULL per row), so a partial pass is safe to re-run.

### Option A — deploy the v2 backfill (in-app self-heal, preferred)

1. Drain clients to a coordinated window (small fleet; `ps_crud → 0` on each).
2. Ship the build with this commit.
3. On the authoritative client, open workspace `ef43b424-…`. The v2 backfill
   re-runs off the open path, fills the 4,075 rows, and uploads them.
4. Verify (below). Other clients converge on next sync.

No manual server write — the heal is ordinary app operation.

### Option B — run the bridge eval now (no app build needed)

`recover.eval.js` in this directory mirrors the v2 backfill exactly. With the
`ff-vlad-dev` tab focused/connected:

```bash
# Dry-run — reports the candidate count, writes nothing:
pnpm agent --profile ff-vlad-dev eval --file scripts/daily-note-date-recovery/recover.eval.js

# Apply — performs the writes (HELD until approved):
pnpm agent --profile ff-vlad-dev eval --file scripts/daily-note-date-recovery/recover.eval.js \
  --data-json '{"apply":true}'
```

Defaults to the active workspace; pass
`{"apply":true,"workspaceId":"ef43b424-80ba-4967-b587-a4c32efd8071"}` to target
one explicitly. Run on one client with the others idle to avoid racing a
mid-flight reprojection.

## Verify after recovery

```bash
# Local: missing count should drop to 0 (or only future SRS targets remain).
pnpm agent --profile ff-vlad-dev sql all "SELECT COUNT(*) AS missing FROM blocks b JOIN block_types bt ON bt.block_id=b.id AND bt.type='daily-note' WHERE b.workspace_id='ef43b424-80ba-4967-b587-a4c32efd8071' AND b.deleted=0 AND json_extract(b.properties_json,'\$.\"daily-note:date\"') IS NULL"

# Upload queue drains as the writes flush:
pnpm agent --profile ff-vlad-dev sql all "SELECT COUNT(*) AS queued FROM ps_crud"

# Server copy: blocks_synced should match local once the queue drains.
pnpm agent --profile ff-vlad-dev sql all "SELECT COUNT(*) AS synced_with_date FROM blocks_synced b JOIN block_types bt ON bt.block_id=b.id AND bt.type='daily-note' WHERE b.workspace_id='ef43b424-80ba-4967-b587-a4c32efd8071' AND json_extract(b.data,'\$.properties.\"daily-note:date\"') IS NOT NULL"
```

(Adjust the `blocks_synced` JSON path to match the synced-row shape if it
differs from `$.properties."daily-note:date"`.)

## Notes / edge cases

- **Future-dated SRS daily notes** already have the property (creation path);
  the recheck skips them — no clobber.
- **Shape-only date aliases** (`2026-13-01`, `2026-02-30`) are excluded by the
  `date(value) = value` guard, same as the backfill.
- **Non-daily-note pages** that merely carry a date-shaped alias are excluded by
  the `block_types` join.
- The old `daily-note-date-from-alias` marker row stays in `client_schema_state`
  as an inert entry (the marker store is add-only); harmless.
