-- Behavioral tests for the monotonic clamp + user_updated_at split added in
-- 20260612000000_add_user_updated_at_monotonic_clamp.sql. Run with:
--
--   yarn check:db
--
-- pgTAP, self-wrapped in BEGIN/ROLLBACK so manual psql runs leave no residue.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO public, extensions;

SELECT plan(17);

CREATE TEMP TABLE clamp_test_ctx AS
SELECT
  'test-ws-' || extensions.gen_random_uuid()::text AS workspace_id,
  extensions.gen_random_uuid()::text               AS user_id,
  -- One minute in the past so the future-clamp never touches these.
  (extract(epoch from now()) * 1000)::bigint - 60000 AS then_ms,
  (extract(epoch from now()) * 1000)::bigint         AS now_ms;

INSERT INTO public.workspaces (id, name, owner_user_id, create_time, update_time)
SELECT workspace_id, 'test', user_id, now_ms, now_ms FROM clamp_test_ctx;

INSERT INTO public.workspace_members (id, workspace_id, user_id, role, create_time)
SELECT extensions.gen_random_uuid()::text, workspace_id, user_id, 'owner', now_ms
FROM clamp_test_ctx;

-- Helper: insert a content block at then_ms and return its id.
CREATE OR REPLACE FUNCTION pg_temp.seed_block(p_content text DEFAULT 'x')
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_id text := 'blk-' || extensions.gen_random_uuid()::text;
  c clamp_test_ctx%rowtype;
BEGIN
  SELECT * INTO c FROM clamp_test_ctx;
  INSERT INTO public.blocks (
    id, workspace_id, parent_id, order_key, content,
    properties_json, created_at, updated_at, user_updated_at, created_by, updated_by
  ) VALUES (
    v_id, c.workspace_id, NULL, 'k0', p_content,
    '{}', c.then_ms, c.then_ms, c.then_ms, c.user_id, c.user_id
  );
  RETURN v_id;
END $$;

-------------------------------------------------------------------------
-- 1. INSERT WITHOUT user_updated_at → trigger COALESCEs it to updated_at
--    (old-client / pre-split write population).
-------------------------------------------------------------------------
INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, created_at, updated_at, created_by, updated_by
)
SELECT 'ins-no-uua', workspace_id, NULL, 'k', 'c',
       '{}', then_ms, then_ms, user_id, user_id
FROM clamp_test_ctx;

SELECT is(
  (SELECT user_updated_at FROM public.blocks WHERE id = 'ins-no-uua'),
  (SELECT then_ms FROM clamp_test_ctx),
  'INSERT without user_updated_at: populated = updated_at'
);

-------------------------------------------------------------------------
-- 2. INSERT WITH an explicit PAST user_updated_at → preserved (least() no-op).
-------------------------------------------------------------------------
INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, created_at, updated_at, user_updated_at, created_by, updated_by
)
SELECT 'ins-uua', workspace_id, NULL, 'k', 'c',
       '{}', then_ms, then_ms, then_ms - 5000, user_id, user_id
FROM clamp_test_ctx;

SELECT is(
  (SELECT user_updated_at FROM public.blocks WHERE id = 'ins-uua'),
  (SELECT then_ms - 5000 FROM clamp_test_ctx),
  'INSERT with an explicit past user_updated_at: preserved'
);

-------------------------------------------------------------------------
-- 2b. A fast-clock client's FUTURE user_updated_at is clamped to ~server now
--     (else it would pin the block at the top of recents / show a future
--     "last edited" — the display regression Codex flagged).
-------------------------------------------------------------------------
INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, created_at, updated_at, user_updated_at, created_by, updated_by
)
SELECT 'ins-uua-future', workspace_id, NULL, 'k', 'c',
       '{}', then_ms, then_ms, now_ms + 3600000, user_id, user_id
FROM clamp_test_ctx;

SELECT cmp_ok(
  (SELECT user_updated_at FROM public.blocks WHERE id = 'ins-uua-future'),
  '<=',
  (extract(epoch from now()) * 1000)::bigint + 1000,
  'future user_updated_at is clamped down to ~server now'
);

-------------------------------------------------------------------------
-- 3. Content UPDATE bumps updated_at to OLD+1 even when the supplied stamp
--    equals OLD (same-ms collision case).
-------------------------------------------------------------------------
DO $$
DECLARE v_id text := pg_temp.seed_block('orig');
        c clamp_test_ctx%rowtype;
BEGIN
  SELECT * INTO c FROM clamp_test_ctx;
  UPDATE public.blocks SET content = 'edited', updated_at = c.then_ms WHERE id = v_id;
  PERFORM set_config('clamp.t3_id', v_id, true);
END $$;

SELECT is(
  (SELECT updated_at FROM public.blocks WHERE id = current_setting('clamp.t3_id')),
  (SELECT then_ms + 1 FROM clamp_test_ctx),
  'content UPDATE with supplied stamp = OLD bumps updated_at to OLD+1'
);

-------------------------------------------------------------------------
-- 4. Clock-skew regression on a content UPDATE is floored UP (cannot
--    regress below OLD), then +1 for the content change.
-------------------------------------------------------------------------
DO $$
DECLARE v_id text := pg_temp.seed_block('orig');
        c clamp_test_ctx%rowtype;
BEGIN
  SELECT * INTO c FROM clamp_test_ctx;
  UPDATE public.blocks SET content = 'edited', updated_at = c.then_ms - 30000 WHERE id = v_id;
  PERFORM set_config('clamp.t4_id', v_id, true);
END $$;

SELECT is(
  (SELECT updated_at FROM public.blocks WHERE id = current_setting('clamp.t4_id')),
  (SELECT then_ms + 1 FROM clamp_test_ctx),
  'clock-skew regression on content UPDATE floored up to OLD+1'
);

-------------------------------------------------------------------------
-- 5. Metadata-only UPDATE (updated_by) with supplied stamp = OLD floors
--    but does NOT bump — updated_by is not a content column.
-------------------------------------------------------------------------
DO $$
DECLARE v_id text := pg_temp.seed_block('orig');
        c clamp_test_ctx%rowtype;
BEGIN
  SELECT * INTO c FROM clamp_test_ctx;
  UPDATE public.blocks SET updated_by = 'someone-else', updated_at = c.then_ms WHERE id = v_id;
  PERFORM set_config('clamp.t5_id', v_id, true);
END $$;

SELECT is(
  (SELECT updated_at FROM public.blocks WHERE id = current_setting('clamp.t5_id')),
  (SELECT then_ms FROM clamp_test_ctx),
  'metadata-only UPDATE floors but does not bump updated_at'
);

-------------------------------------------------------------------------
-- 6. Metadata-only UPDATE with a regressed supplied stamp is floored to
--    OLD (never below).
-------------------------------------------------------------------------
DO $$
DECLARE v_id text := pg_temp.seed_block('orig');
        c clamp_test_ctx%rowtype;
BEGIN
  SELECT * INTO c FROM clamp_test_ctx;
  UPDATE public.blocks SET updated_by = 'someone-else', updated_at = c.then_ms - 30000 WHERE id = v_id;
  PERFORM set_config('clamp.t6_id', v_id, true);
END $$;

SELECT is(
  (SELECT updated_at FROM public.blocks WHERE id = current_setting('clamp.t6_id')),
  (SELECT then_ms FROM clamp_test_ctx),
  'metadata-only UPDATE with regressed stamp floored up to OLD'
);

-------------------------------------------------------------------------
-- 7. A content UPDATE that does not carry user_updated_at leaves the
--    user-facing stamp untouched (version vs display separation). This is
--    exactly the skipMetadata bookkeeping-write shape.
-------------------------------------------------------------------------
DO $$
DECLARE v_id text := pg_temp.seed_block('orig');
BEGIN
  UPDATE public.blocks SET content = 'edited' WHERE id = v_id;  -- no user_updated_at
  PERFORM set_config('clamp.t7_id', v_id, true);
END $$;

SELECT is(
  (SELECT user_updated_at FROM public.blocks WHERE id = current_setting('clamp.t7_id')),
  (SELECT then_ms FROM clamp_test_ctx),
  'content UPDATE without user_updated_at leaves it unchanged'
);
SELECT cmp_ok(
  (SELECT updated_at FROM public.blocks WHERE id = current_setting('clamp.t7_id')),
  '>=',
  (SELECT then_ms + 1 FROM clamp_test_ctx),
  'same content UPDATE still bumps the row-version'
);

-------------------------------------------------------------------------
-- 8. Future-clamp still pulls a far-future supplied stamp down to ~now.
-------------------------------------------------------------------------
DO $$
DECLARE v_id text := pg_temp.seed_block('orig');
        c clamp_test_ctx%rowtype;
BEGIN
  SELECT * INTO c FROM clamp_test_ctx;
  UPDATE public.blocks SET content = 'edited', updated_at = c.now_ms + 3600000 WHERE id = v_id;
  PERFORM set_config('clamp.t8_id', v_id, true);
END $$;

SELECT cmp_ok(
  (SELECT updated_at FROM public.blocks WHERE id = current_setting('clamp.t8_id')),
  '<=',
  (extract(epoch from now()) * 1000)::bigint + 1000,
  'future-clamp pulls a far-future stamp down to ~server now'
);

-------------------------------------------------------------------------
-- 9. RPC apply_block_patches carries user_updated_at through. A distinct PAST
--    value (1700000000000 ≈ 2023, ≠ the seed's then_ms) proves the closed
--    column list wrote it AND survives the future-clamp (it's not in the future).
-------------------------------------------------------------------------
DO $$
DECLARE v_id text := pg_temp.seed_block('orig');
BEGIN PERFORM set_config('clamp.t9_id', v_id, true); END $$;

SELECT lives_ok(
  format($q$SELECT public.apply_block_patches(jsonb_build_array(
    jsonb_build_object('id', %L, 'content', 'rpc-edit', 'user_updated_at', 1700000000000::bigint)
  ))$q$, current_setting('clamp.t9_id')),
  'RPC patch with user_updated_at does not raise'
);
SELECT is(
  (SELECT user_updated_at FROM public.blocks WHERE id = current_setting('clamp.t9_id')),
  1700000000000::bigint,
  'RPC patch writes user_updated_at through the closed column list'
);

-------------------------------------------------------------------------
-- 10. RPC content-only PATCH (no user_updated_at) leaves the display stamp
--     untouched but the trigger still bumps the row-version.
-------------------------------------------------------------------------
DO $$
DECLARE v_id text := pg_temp.seed_block('orig');
BEGIN PERFORM set_config('clamp.t10_id', v_id, true); END $$;

SELECT lives_ok(
  format($q$SELECT public.apply_block_patches(jsonb_build_array(
    jsonb_build_object('id', %L, 'content', 'rpc-edit')
  ))$q$, current_setting('clamp.t10_id')),
  'RPC content-only patch does not raise'
);
SELECT is(
  (SELECT user_updated_at FROM public.blocks WHERE id = current_setting('clamp.t10_id')),
  (SELECT then_ms FROM clamp_test_ctx),
  'RPC content-only patch leaves user_updated_at unchanged'
);
SELECT cmp_ok(
  (SELECT updated_at FROM public.blocks WHERE id = current_setting('clamp.t10_id')),
  '>=',
  (SELECT then_ms + 1 FROM clamp_test_ctx),
  'RPC content-only patch still bumps the row-version via the clamp trigger'
);

-------------------------------------------------------------------------
-- 11. INSERT does NOT floor/bump (no OLD; the floor is TG_OP='UPDATE'-only).
--     A past stamp on INSERT lands verbatim — proves the UPDATE guard.
-------------------------------------------------------------------------
INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, created_at, updated_at, user_updated_at, created_by, updated_by
)
SELECT 'ins-low', workspace_id, NULL, 'k', 'c',
       '{}', then_ms, then_ms, then_ms, user_id, user_id
FROM clamp_test_ctx;

SELECT is(
  (SELECT updated_at FROM public.blocks WHERE id = 'ins-low'),
  (SELECT then_ms FROM clamp_test_ctx),
  'INSERT with a past stamp lands unchanged (no floor/bump on INSERT)'
);

-------------------------------------------------------------------------
-- 12. created_at future-clamp (the trigger clamps created_at too, not just
--     updated_at — otherwise untested).
-------------------------------------------------------------------------
INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, created_at, updated_at, user_updated_at, created_by, updated_by
)
SELECT 'ins-futcreated', workspace_id, NULL, 'k', 'c',
       '{}', now_ms + 3600000, then_ms, then_ms, user_id, user_id
FROM clamp_test_ctx;

SELECT cmp_ok(
  (SELECT created_at FROM public.blocks WHERE id = 'ins-futcreated'),
  '<=',
  (extract(epoch from now()) * 1000)::bigint + 1000,
  'future created_at is clamped down to ~server now'
);

-- (The UPDATE-path COALESCE-on-NULL case — a pre-migration row not yet
-- backfilled — uses the identical `coalesce(NEW.user_updated_at,
-- NEW.updated_at)` expression already proven on the INSERT path in test #1.
-- Re-staging it here would require DISABLE TRIGGER mid-transaction, which
-- Postgres rejects once `blocks` has pending trigger events from earlier DML.)

SELECT * FROM finish();

ROLLBACK;
