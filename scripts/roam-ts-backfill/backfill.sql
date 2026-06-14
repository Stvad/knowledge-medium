-- ===========================================================================
-- Roam timestamp backfill — ff-vlad-dev workspace ef43b424-80ba-4967-b587-a4c32efd8071
--
-- Restores real Roam create-time/edit-time onto the ~312K already-imported
-- blocks (all currently stamped at 2026-05-13 import time). Run server-side on
-- Supabase; clients converge via PowerSync down-sync.
--
-- Mapping per block:
--   created_at      <- Roam create-time          (always, for matched rows)
--   user_updated_at <- Roam edit-time            EXCEPT preserve-list rows
--                                                (genuine post-import activity)
--   updated_at      <- server-now (forward bump) so the change propagates and
--                      the client materialize LWW gate accepts it; NEVER the
--                      Roam value (it is the server-monotonic sync row-version)
--   created_by / updated_by                      unchanged
--
-- EXECUTION: hold for a coordinated drain window (no clients actively editing).
-- The down-sync re-materializes ~310K rows on each client, firing the
-- blocks_row_event_update trigger (source='sync') once per row — an inherent,
-- one-time row_events burst (see docs/row-events-retention.md; pruning is the
-- real fix). Not avoidable by any backfill path.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Load the two CSVs into staging tables (run from psql, paths relative to
--    this directory). roam_ts_map = id,create_time,edit_time (312527 rows);
--    roam_ts_preserve = id (1525 rows).
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS roam_ts_map;
CREATE TABLE roam_ts_map (id text PRIMARY KEY, create_time bigint, edit_time bigint);
\copy roam_ts_map (id, create_time, edit_time) FROM 'roam_ts_map.csv' WITH (FORMAT csv, HEADER true);

DROP TABLE IF EXISTS roam_ts_preserve;
CREATE TABLE roam_ts_preserve (id text PRIMARY KEY);
\copy roam_ts_preserve (id) FROM 'roam_ts_preserve.csv' WITH (FORMAT csv, HEADER true);

-- Sanity: row counts should be 312527 and 1525.
SELECT (SELECT count(*) FROM roam_ts_map) AS map_rows,
       (SELECT count(*) FROM roam_ts_preserve) AS preserve_rows;

-- ---------------------------------------------------------------------------
-- 1. Recovery snapshot (rollback path). Captures CURRENT values of every row
--    we are about to touch, BEFORE the UPDATE.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS blocks_ts_backup_20260613;
CREATE TABLE blocks_ts_backup_20260613 AS
SELECT b.id, b.created_at, b.updated_at, b.user_updated_at
FROM public.blocks b
JOIN roam_ts_map m ON m.id = b.id
WHERE b.workspace_id = 'ef43b424-80ba-4967-b587-a4c32efd8071'
  AND b.deleted = false;

-- ---------------------------------------------------------------------------
-- 2. The backfill. One transaction. Disable ONLY the history trigger (so we
--    don't write one blocks_history row per block) — the clamp trigger stays
--    enabled and is a no-op here (created_at/user_updated_at are past, so the
--    future-clamp doesn't fire; updated_at moves forward so the monotonic
--    floor keeps it; the content-change +1 bump is not in our changed columns).
--    `session_replication_role = replica` is NOT used — it would also disable
--    the clamp + e2ee triggers (matches migration 20260612...).
-- ---------------------------------------------------------------------------
BEGIN;

ALTER TABLE public.blocks DISABLE TRIGGER blocks_record_history_trg;

UPDATE public.blocks b SET
  created_at      = m.create_time,
  user_updated_at = CASE WHEN p.id IS NULL THEN m.edit_time ELSE b.user_updated_at END,
  updated_at      = (extract(epoch from now()) * 1000)::bigint
FROM roam_ts_map m
LEFT JOIN roam_ts_preserve p ON p.id = m.id
WHERE b.id = m.id
  AND b.workspace_id = 'ef43b424-80ba-4967-b587-a4c32efd8071'
  AND b.deleted = false;

ALTER TABLE public.blocks ENABLE TRIGGER blocks_record_history_trg;

-- ---------------------------------------------------------------------------
-- 3. Verify BEFORE committing. Expect (of ~312527 matched, non-deleted):
--    - created_at_set ≈ all matched · uua_recovered ≈ 311002 · uua_preserved ≈ 1525
--    - updated_at_NOT_bumped_should_be_0 = 0.
-- ---------------------------------------------------------------------------
SELECT
  count(*) FILTER (WHERE b.created_at = m.create_time)                       AS created_at_set,
  count(*) FILTER (WHERE p.id IS NULL  AND b.user_updated_at = m.edit_time)  AS uua_recovered,
  count(*) FILTER (WHERE p.id IS NOT NULL
                   AND b.user_updated_at = bk.user_updated_at)               AS uua_preserved,
  count(*) FILTER (WHERE b.updated_at <= bk.updated_at)                      AS updated_at_NOT_bumped_should_be_0
FROM public.blocks b
JOIN roam_ts_map m ON m.id = b.id
JOIN blocks_ts_backup_20260613 bk ON bk.id = b.id
LEFT JOIN roam_ts_preserve p ON p.id = b.id
WHERE b.workspace_id = 'ef43b424-80ba-4967-b587-a4c32efd8071' AND b.deleted = false;

-- COMMIT;    -- <- uncomment to apply once the verify row looks right
-- ROLLBACK;  -- <- otherwise

-- ---------------------------------------------------------------------------
-- ROLLBACK (post-commit), if ever needed: restore the three columns from the
-- snapshot. (updated_at restore is best-effort; clients will have moved on.)
-- ---------------------------------------------------------------------------
-- ALTER TABLE public.blocks DISABLE TRIGGER blocks_record_history_trg;
-- UPDATE public.blocks b SET
--   created_at = bk.created_at, updated_at = (extract(epoch from now())*1000)::bigint,
--   user_updated_at = bk.user_updated_at
-- FROM blocks_ts_backup_20260613 bk
-- WHERE b.id = bk.id AND b.workspace_id = 'ef43b424-80ba-4967-b587-a4c32efd8071';
-- ALTER TABLE public.blocks ENABLE TRIGGER blocks_record_history_trg;

-- Cleanup after a few days of confidence:
-- DROP TABLE roam_ts_map; DROP TABLE roam_ts_preserve; DROP TABLE blocks_ts_backup_20260613;
