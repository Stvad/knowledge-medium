-- Behavioral tests for the `apply_block_patches` RPC. Run with:
--
--   yarn check:db
--
-- This file is pgTAP so `supabase test db` reports named TAP failures.
-- It also wraps itself in BEGIN/ROLLBACK, so manual psql runs leave no
-- residue.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO public, extensions;

SELECT plan(15);

CREATE TEMP TABLE apply_block_patches_test_ctx AS
SELECT
  'test-ws-' || extensions.gen_random_uuid()::text AS workspace_id,
  extensions.gen_random_uuid()::text             AS user_id,
  'test-block-a-' || extensions.gen_random_uuid()::text AS block_a_id,
  'test-block-b-' || extensions.gen_random_uuid()::text AS block_b_id,
  'test-block-c-' || extensions.gen_random_uuid()::text AS block_c_id,
  'test-parent-' || extensions.gen_random_uuid()::text AS parent_id,
  -- All client timestamps stay one minute in the past so the
  -- `blocks_clamp_updated_at` BEFORE trigger never clamps them.
  (extract(epoch from now()) * 1000)::bigint - 60000 AS then_ms,
  (extract(epoch from now()) * 1000)::bigint AS now_ms;

-- Seed: workspace + owner membership so the FK on blocks.workspace_id holds.
INSERT INTO public.workspaces (id, name, owner_user_id, create_time, update_time)
SELECT workspace_id, 'test', user_id, now_ms, now_ms
FROM apply_block_patches_test_ctx;

INSERT INTO public.workspace_members (id, workspace_id, user_id, role, create_time)
SELECT extensions.gen_random_uuid()::text, workspace_id, user_id, 'owner', now_ms
FROM apply_block_patches_test_ctx;

-- Parent row first so block_a's parent_id FK (if we ever attached it)
-- and the parent_id reassignment positive case can both succeed.
INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, created_at, updated_at, created_by, updated_by
)
SELECT parent_id, workspace_id, NULL, 'p0', 'parent',
       '{}', then_ms, then_ms, user_id, user_id
FROM apply_block_patches_test_ctx;

-- Three test rows. block-a uses non-default properties_json so we can
-- prove the patch doesn't clobber it; block-b starts with parent_id set
-- so we can null it via the patch.
INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, created_at, updated_at, created_by, updated_by
)
SELECT block_a_id, workspace_id, NULL, 'a0', 'A',
       '{"alias":["A"]}', then_ms, then_ms, user_id, user_id
FROM apply_block_patches_test_ctx;

INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, created_at, updated_at, created_by, updated_by
)
SELECT block_b_id, workspace_id, parent_id, 'b0', 'B',
       '{}', then_ms, then_ms, user_id, user_id
FROM apply_block_patches_test_ctx;

INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, created_at, updated_at, created_by, updated_by
)
SELECT block_c_id, workspace_id, NULL, 'c0', 'C',
       '{}', then_ms, then_ms, user_id, user_id
FROM apply_block_patches_test_ctx;

-------------------------------------------------------------------------
-- Single-id patch: only the keys present in the patch are written.
-- properties_json must stay untouched (no full-row overwrite).
-------------------------------------------------------------------------
SELECT lives_ok(
  format($q$SELECT public.apply_block_patches(jsonb_build_array(jsonb_build_object('id', %L, 'content', 'A-new')))$q$,
    (SELECT block_a_id FROM apply_block_patches_test_ctx)),
  'single-id patch does not raise'
);

SELECT is(
  (SELECT content FROM public.blocks
     WHERE id = (SELECT block_a_id FROM apply_block_patches_test_ctx)),
  'A-new'::text,
  'single-id patch updates content'
);

SELECT is(
  (SELECT properties_json FROM public.blocks
     WHERE id = (SELECT block_a_id FROM apply_block_patches_test_ctx)),
  '{"alias":["A"]}'::text,
  'single-id patch leaves properties_json untouched (no full-row overwrite)'
);

SELECT is(
  (SELECT parent_id FROM public.blocks
     WHERE id = (SELECT block_a_id FROM apply_block_patches_test_ctx)),
  NULL::text,
  'single-id patch leaves parent_id untouched (absent key, NULL value preserved)'
);

-------------------------------------------------------------------------
-- Multi-id batch: each patch writes only its respective columns to its
-- respective row id. Different rows can be touched with different keys
-- inside one RPC call.
-------------------------------------------------------------------------
SELECT lives_ok(
  format($q$SELECT public.apply_block_patches(jsonb_build_array(
    jsonb_build_object('id', %L, 'content', 'B-new'),
    jsonb_build_object('id', %L, 'properties_json', '{"types":["page"]}')
  ))$q$,
    (SELECT block_b_id FROM apply_block_patches_test_ctx),
    (SELECT block_c_id FROM apply_block_patches_test_ctx)),
  'multi-id batch does not raise'
);

SELECT is(
  (SELECT content FROM public.blocks
     WHERE id = (SELECT block_b_id FROM apply_block_patches_test_ctx)),
  'B-new'::text,
  'multi-id batch updates row B content'
);

SELECT is(
  (SELECT properties_json FROM public.blocks
     WHERE id = (SELECT block_c_id FROM apply_block_patches_test_ctx)),
  '{"types":["page"]}'::text,
  'multi-id batch updates row C properties_json'
);

SELECT is(
  (SELECT content FROM public.blocks
     WHERE id = (SELECT block_c_id FROM apply_block_patches_test_ctx)),
  'C'::text,
  'multi-id batch leaves row C content untouched (not in its patch)'
);

-------------------------------------------------------------------------
-- Missing id: the RPC raises SQLSTATE P0002 (`no_data_found`), which
-- rolls back the function's transaction so sibling UPDATEs in the same
-- batch never commit. Without that, partial writes would persist while
-- the client and orchestrator both think the tx was rejected.
-------------------------------------------------------------------------
SELECT throws_ok(
  format($q$SELECT public.apply_block_patches(jsonb_build_array(
    jsonb_build_object('id', 'does-not-exist-xyz', 'content', 'ignored'),
    jsonb_build_object('id', %L, 'content', 'A-newer')
  ))$q$, (SELECT block_a_id FROM apply_block_patches_test_ctx)),
  'P0002',
  NULL,
  'missing id raises P0002 to abort the function transaction'
);

SELECT is(
  (SELECT content FROM public.blocks
     WHERE id = (SELECT block_a_id FROM apply_block_patches_test_ctx)),
  'A-new'::text,
  'sibling patch did not commit (function tx rolled back on missing id)'
);

-------------------------------------------------------------------------
-- parent_id null write (nullable column, CASE-WHEN-? branch).
-- block_b started with parent_id set; patch with explicit null clears it.
-------------------------------------------------------------------------
SELECT lives_ok(
  format($q$SELECT public.apply_block_patches(jsonb_build_array(jsonb_build_object('id', %L, 'parent_id', NULL)))$q$,
    (SELECT block_b_id FROM apply_block_patches_test_ctx)),
  'parent_id:null patch does not raise'
);

SELECT is(
  (SELECT parent_id FROM public.blocks
     WHERE id = (SELECT block_b_id FROM apply_block_patches_test_ctx)),
  NULL::text,
  'parent_id:null patch sets parent_id to NULL'
);

-------------------------------------------------------------------------
-- parent_id positive case: writing a non-null parent_id works.
-------------------------------------------------------------------------
SELECT lives_ok(
  format($q$SELECT public.apply_block_patches(jsonb_build_array(jsonb_build_object('id', %L, 'parent_id', %L)))$q$,
    (SELECT block_a_id FROM apply_block_patches_test_ctx),
    (SELECT parent_id FROM apply_block_patches_test_ctx)),
  'parent_id positive patch does not raise'
);

SELECT is(
  (SELECT parent_id FROM public.blocks
     WHERE id = (SELECT block_a_id FROM apply_block_patches_test_ctx)),
  (SELECT parent_id FROM apply_block_patches_test_ctx),
  'parent_id positive patch sets parent_id to the supplied value'
);

-------------------------------------------------------------------------
-- Empty patches array: no-op, no raise.
-------------------------------------------------------------------------
SELECT lives_ok(
  $q$SELECT public.apply_block_patches('[]'::jsonb)$q$,
  'empty patches array does not raise'
);

SELECT * FROM finish();

ROLLBACK;
