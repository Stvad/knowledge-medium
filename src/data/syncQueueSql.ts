/**
 * Canonical SQL for the PowerSync upload/download queue counts. Lives in core
 * (`src/data/`) rather than the `system-status` plugin because it's also
 * consumed by `src/utils/dbForensicsHooks.ts` — and core cannot import from
 * `src/plugins/**` (`boundary/no-core-to-plugin-imports`). UI formatting
 * (`formatPendingChanges`) stays in the plugin's `queueCounts.ts`; only the
 * SQL moved here.
 */

export const uploadQueueCountCap = 1000

// Count distinct *blocks* with pending changes, not raw `ps_crud` rows. A
// single editing burst (typing, focus changes, reorders) fans out to many
// CRUD entries against the same block, so a raw row count balloons into a
// huge, meaningless number. `ps_crud.data` is the upload envelope written by
// the blocks_upload_* triggers (clientSchema.ts): `{op, type, id, data}`,
// where `$.id` is the block id.
//
// The preview cap rides on `DISTINCT … LIMIT cap+1`: SQLite emits each new
// distinct id as it discovers it and stops once it has cap+1, so a queue
// touching many distinct blocks bounds the scan. (A queue with millions of
// rows but few distinct blocks still scans fully — but that only happens
// after a long offline stretch, and the scan runs in-memory via
// `temp_store = MEMORY`.)
export const uploadQueuePreviewCountSql =
  `SELECT COUNT(*) AS count FROM (SELECT DISTINCT json_extract(data, '$.id') FROM ps_crud LIMIT ${uploadQueueCountCap + 1})`
export const uploadQueueExactCountSql =
  `SELECT COUNT(DISTINCT json_extract(data, '$.id')) AS count FROM ps_crud`

// Rows downloaded into the `blocks_synced` staging table but not yet applied to
// the app-visible `blocks` table — the Layout B observer's materialization
// backlog (its `blocks_synced_changes` change queue; see observer.ts). It drains
// to 0 as the observer catches up, so the indicator counts down. A plain
// single-table COUNT(*) — cheap even at a large initial-sync backlog, and the
// real magnitude is worth showing, so it isn't capped like the upload preview.
export const materializeQueueCountSql =
  'SELECT COUNT(*) AS count FROM blocks_synced_changes'

// The rejection quarantine — CRUD entries PowerSync's upload gave up on
// (server-side validation failure, permanent conflict). Healthy: 0.
export const rejectedQueueCountSql =
  'SELECT COUNT(*) AS count FROM ps_crud_rejected'

// Raw (non-distinct) `ps_crud` row count, capped the same way as the preview
// query above but over rows rather than distinct block ids — cheaper (no
// `json_extract`/DISTINCT) and gives the sync-health breadcrumb a second,
// independent signal: a queue with few distinct blocks but many raw rows
// (one block edited over and over while offline) shows up here even though
// `pendingBlocks` stays small.
export const uploadQueueRowCountSql =
  `SELECT COUNT(*) AS count FROM (SELECT 1 FROM ps_crud LIMIT ${uploadQueueCountCap + 1})`

// The exact, uncapped queue-progress signal. `ps_crud.id` is the table's
// rowid, and PowerSync drains a completed upload batch with
// `DELETE FROM ps_crud WHERE id <= ?` (verified in `@powersync/common`
// `SqliteBucketStorage.ts:155`) — so `MIN(id)` only ever moves UP as batches
// land, and `lo` advancing between two samples is exactly "the upload loop
// completed a batch since the last observation," with no cap and no
// json_extract/DISTINCT scan: each of the two subqueries is a single b-tree
// edge probe. `lo IS NULL` (both aggregates are, since SQLite's MIN/MAX
// return NULL over zero rows) means the queue is empty. `hi` (MAX(id)) is
// carried alongside for a cheap depth-in-ids sanity check but isn't required
// by the progress signal itself, which only needs `lo`.
//
// This replaces the old decrease-in-capped-counts heuristic
// (uploadQueuePreviewCountSql/uploadQueueRowCountSql going down) as the
// signal that DRIVES the sync-health stall verdict — see
// `computeSyncStall` in dbForensicsHooks.ts. Those two capped counts are
// still queried and kept in the recorded sample as the human-legible
// "depth" (what the status chip shows), but they no longer decide the
// verdict, so the cap no longer limits how deep a genuinely-draining
// backlog can be told apart from a wedged one.
export const uploadQueueEdgeSql =
  'SELECT (SELECT MIN(id) FROM ps_crud) AS lo, (SELECT MAX(id) FROM ps_crud) AS hi'
