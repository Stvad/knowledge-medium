-- One-time cleanup of legacy `system:`-authored blocks (pre-c0d606f6 mints).
--
-- EXECUTED 2026-06-14 against prod: 787 rows zeroed + de-prefixed (verified
-- remaining=0, zeroed=787); converged on all bridge-connected devices. The e2ee
-- workspace + mobile converge on their next sync. Rollback source:
-- blocks_system_backup_20260614 (drop it once clients confirm sync).
--
-- Strips the `system:` prefix from `updated_by` (restoring a plain user-pair
-- author) and re-stamps the row to the `updated_at = 0` pristine sentinel, so it
-- re-replicates and converges EVERY device — including any shadowed copy on a
-- client we can't inspect (an e2ee workspace / mobile) — via the stamp-0 exemption.
-- `user_updated_at` is captured BEFORE zeroing so display "last edited" survives.
--
-- WHY ZEROING (not a +1 touch): a 0-stamped server row loses to no nonzero local
-- stamp, so under the CURRENT indiscriminate gate every device yields to it
-- regardless of its local stamp — healing even a competing-newer-default shadow.
--
-- ORDERING: this MUST run, and converge on every device, BEFORE PR #151 (the
-- hardened gate) merges. The hardened gate skip-stales a 0-stamped row over a
-- nonzero local (`local >= 0`), so if it ships first the zero never lands.
--
-- PRE-REQS: every device's upload queue drained (`ps_crud → 0`, incl. the e2ee
-- workspace + mobile) — a queued edit at run time would race the zero. `e2ee_plaintext_risk`
-- below must be 0 (the e2ee ciphertext trigger stays ENABLED and would abort the
-- UPDATE on a plaintext-content row in an e2ee workspace).
--
-- RUN: psql "$PS_DATABASE_URI" -f scripts/system-author-cleanup.sql
--   (connects as the blocks table owner — required to toggle triggers; the
--    Supabase Management API can't run this transactional DDL. $PS_DATABASE_URI
--    is sourced from .env.local.)

\set ON_ERROR_STOP on

-- ── Pre-check (read-only) — eyeball before the write ─────────────────────────
\echo '── pre-check: system: census + e2ee-plaintext risk (must be 0) ──'
SELECT count(*) AS total,
       count(*) FILTER (WHERE updated_at <> 0) AS nonzero,
       (SELECT count(*) FROM blocks b JOIN workspaces w ON w.id = b.workspace_id
          WHERE b.updated_by LIKE 'system:%' AND w.encryption_mode = 'e2ee'
            AND b.content NOT LIKE 'enc:v1:%') AS e2ee_plaintext_risk
  FROM blocks WHERE updated_by LIKE 'system:%';

-- ── Backup snapshot (rollback source; committed, outside the txn) ────────────
DROP TABLE IF EXISTS blocks_system_backup_20260614;
CREATE TABLE blocks_system_backup_20260614 AS
  SELECT id, updated_at, updated_by, user_updated_at
    FROM blocks WHERE updated_by LIKE 'system:%';
\echo '── backup rows captured ──'
SELECT count(*) AS backed_up FROM blocks_system_backup_20260614;

-- ── Cleanup (one transaction; DDL is transactional, so a failure rolls back
--    the trigger toggles too and leaves them ENABLED) ──────────────────────────
BEGIN;
ALTER TABLE public.blocks DISABLE TRIGGER blocks_clamp_updated_at_trg;   -- else the floor pins updated_at back up and 0 never lands
ALTER TABLE public.blocks DISABLE TRIGGER blocks_record_history_trg;     -- don't record a stamp "downgrade" in history

UPDATE blocks
   SET user_updated_at = COALESCE(user_updated_at, updated_at),  -- preserve display stamp (RHS reads OLD values)
       updated_at      = 0,                                       -- pristine sentinel
       updated_by      = substring(updated_by FROM length('system:') + 1)  -- strip 'system:' prefix
 WHERE updated_by LIKE 'system:%';

ALTER TABLE public.blocks ENABLE TRIGGER blocks_record_history_trg;
ALTER TABLE public.blocks ENABLE TRIGGER blocks_clamp_updated_at_trg;
COMMIT;

-- ── Post-commit verify (expect remaining = 0, zeroed = backed_up) ────────────
\echo '── verify ──'
SELECT
  (SELECT count(*) FROM blocks WHERE updated_by LIKE 'system:%') AS remaining_system,
  (SELECT count(*) FROM blocks b JOIN blocks_system_backup_20260614 z ON z.id = b.id
     WHERE b.updated_at = 0) AS zeroed,
  (SELECT count(*) FROM blocks_system_backup_20260614) AS expected;

-- ── Rollback (only if verify is wrong; needs the clamp trigger off again since
--    it restores nonzero stamps over the 0s) ─────────────────────────────────
-- BEGIN;
-- ALTER TABLE public.blocks DISABLE TRIGGER blocks_clamp_updated_at_trg;
-- ALTER TABLE public.blocks DISABLE TRIGGER blocks_record_history_trg;
-- UPDATE blocks b SET updated_at = z.updated_at, updated_by = z.updated_by,
--        user_updated_at = z.user_updated_at
--   FROM blocks_system_backup_20260614 z WHERE z.id = b.id;
-- ALTER TABLE public.blocks ENABLE TRIGGER blocks_record_history_trg;
-- ALTER TABLE public.blocks ENABLE TRIGGER blocks_clamp_updated_at_trg;
-- COMMIT;
