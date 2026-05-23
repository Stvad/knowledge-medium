-- Trigger behavior tests for `blocks_history`. Run with:
--
--   yarn check:db
--
-- This file is pgTAP so `supabase test db` reports named TAP failures.
-- It also wraps itself in BEGIN/ROLLBACK, so manual psql runs leave no
-- residue.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO public, extensions;

SELECT plan(35);

CREATE TEMP TABLE blocks_history_test_ctx AS
SELECT
  'test-ws-' || extensions.gen_random_uuid()::text AS workspace_id,
  extensions.gen_random_uuid()::text AS user_id,
  extensions.gen_random_uuid()::text AS other_user_id,
  'test-block-' || extensions.gen_random_uuid()::text AS block_id,
  -- All client timestamps stay one minute in the past so the
  -- `blocks_clamp_updated_at` BEFORE trigger never clamps them. Within the
  -- test we use then_ms + small offsets; all comfortably below server now.
  (extract(epoch from now()) * 1000)::bigint - 60000 AS then_ms,
  (extract(epoch from now()) * 1000)::bigint AS now_ms,
  NULL::int AS history_count_before_noop;

CREATE TEMP VIEW latest_blocks_history AS
SELECT h.*
FROM public.blocks_history h
JOIN blocks_history_test_ctx c ON c.block_id = h.block_id
ORDER BY h.event_id DESC
LIMIT 1;

-- Seed: workspace + owner membership so the FK on blocks.workspace_id holds.
INSERT INTO public.workspaces (id, name, owner_user_id, create_time, update_time)
SELECT workspace_id, 'test', user_id, now_ms, now_ms
FROM blocks_history_test_ctx;

INSERT INTO public.workspace_members (id, workspace_id, user_id, role, create_time)
SELECT extensions.gen_random_uuid()::text, workspace_id, user_id, 'owner', now_ms
FROM blocks_history_test_ctx;

-------------------------------------------------------------------------
-- INSERT
-------------------------------------------------------------------------
INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  created_at, updated_at, created_by, updated_by
)
SELECT
  block_id, workspace_id, NULL, 'a0', 'hello',
  then_ms, then_ms, user_id, user_id
FROM blocks_history_test_ctx;

SELECT is(
  (SELECT count(*)::int FROM public.blocks_history h JOIN blocks_history_test_ctx c ON c.block_id = h.block_id),
  1,
  'INSERT records one history row'
);

SELECT is((SELECT op FROM latest_blocks_history), 'I'::text, 'INSERT records op=I');
SELECT is((SELECT semantic_op FROM latest_blocks_history), 'create'::text, 'INSERT records semantic_op=create');
SELECT is((SELECT before_diff FROM latest_blocks_history), NULL::jsonb, 'INSERT has no before_diff');
SELECT ok((SELECT after_diff IS NOT NULL FROM latest_blocks_history), 'INSERT has an after_diff');
SELECT ok((SELECT after_diff ? 'id' FROM latest_blocks_history), 'INSERT after_diff contains the full row id');
SELECT ok((SELECT after_diff ? 'content' FROM latest_blocks_history), 'INSERT after_diff contains content');
SELECT is((SELECT changed_columns FROM latest_blocks_history), NULL::text[], 'INSERT has no changed_columns list');
SELECT is(
  (SELECT actor FROM latest_blocks_history),
  (SELECT user_id FROM blocks_history_test_ctx),
  'INSERT actor is created_by'
);

-------------------------------------------------------------------------
-- UPDATE (non-deleted column)
-------------------------------------------------------------------------
UPDATE public.blocks b
SET
  content = 'world',
  updated_at = c.then_ms + 1,
  updated_by = c.other_user_id
FROM blocks_history_test_ctx c
WHERE b.id = c.block_id;

SELECT is(
  (SELECT count(*)::int FROM public.blocks_history h JOIN blocks_history_test_ctx c ON c.block_id = h.block_id),
  2,
  'UPDATE records one additional history row'
);

SELECT is((SELECT op FROM latest_blocks_history), 'U'::text, 'UPDATE records op=U');
SELECT is((SELECT semantic_op FROM latest_blocks_history), 'update'::text, 'UPDATE records semantic_op=update');
SELECT ok((SELECT changed_columns @> ARRAY['content']::text[] FROM latest_blocks_history), 'UPDATE changed_columns includes content');
SELECT ok((SELECT changed_columns @> ARRAY['updated_at']::text[] FROM latest_blocks_history), 'UPDATE changed_columns includes updated_at');
SELECT ok((SELECT changed_columns @> ARRAY['updated_by']::text[] FROM latest_blocks_history), 'UPDATE changed_columns includes updated_by');
SELECT ok((SELECT NOT (changed_columns @> ARRAY['deleted']::text[]) FROM latest_blocks_history), 'UPDATE changed_columns excludes deleted');
SELECT is((SELECT before_diff ->> 'content' FROM latest_blocks_history), 'hello'::text, 'UPDATE before_diff records old content');
SELECT is((SELECT after_diff ->> 'content' FROM latest_blocks_history), 'world'::text, 'UPDATE after_diff records new content');
SELECT ok((SELECT NOT (before_diff ? 'id') FROM latest_blocks_history), 'UPDATE before_diff excludes unchanged id');
SELECT is(
  (SELECT actor FROM latest_blocks_history),
  (SELECT other_user_id FROM blocks_history_test_ctx),
  'UPDATE actor is updated_by'
);

-------------------------------------------------------------------------
-- UPDATE - soft_delete (deleted false -> true)
-------------------------------------------------------------------------
UPDATE public.blocks b
SET
  deleted = TRUE,
  updated_at = c.then_ms + 2
FROM blocks_history_test_ctx c
WHERE b.id = c.block_id;

SELECT is((SELECT op FROM latest_blocks_history), 'U'::text, 'soft_delete records op=U');
SELECT is((SELECT semantic_op FROM latest_blocks_history), 'soft_delete'::text, 'soft_delete records semantic_op=soft_delete');
SELECT ok((SELECT changed_columns @> ARRAY['deleted']::text[] FROM latest_blocks_history), 'soft_delete changed_columns includes deleted');
SELECT is((SELECT (before_diff ->> 'deleted')::boolean FROM latest_blocks_history), FALSE, 'soft_delete before_diff.deleted is false');
SELECT is((SELECT (after_diff ->> 'deleted')::boolean FROM latest_blocks_history), TRUE, 'soft_delete after_diff.deleted is true');

-------------------------------------------------------------------------
-- UPDATE - undelete (deleted true -> false)
-------------------------------------------------------------------------
UPDATE public.blocks b
SET
  deleted = FALSE,
  updated_at = c.then_ms + 3
FROM blocks_history_test_ctx c
WHERE b.id = c.block_id;

SELECT is((SELECT semantic_op FROM latest_blocks_history), 'undelete'::text, 'undelete records semantic_op=undelete');
SELECT is((SELECT (before_diff ->> 'deleted')::boolean FROM latest_blocks_history), TRUE, 'undelete before_diff.deleted is true');
SELECT is((SELECT (after_diff ->> 'deleted')::boolean FROM latest_blocks_history), FALSE, 'undelete after_diff.deleted is false');

-------------------------------------------------------------------------
-- UPDATE - no-op (identical values) should record NOTHING
-------------------------------------------------------------------------
UPDATE blocks_history_test_ctx c
SET history_count_before_noop = (
  SELECT count(*)::int
  FROM public.blocks_history h
  WHERE h.block_id = c.block_id
);

UPDATE public.blocks b
SET content = b.content
FROM blocks_history_test_ctx c
WHERE b.id = c.block_id;

SELECT is(
  (SELECT count(*)::int FROM public.blocks_history h JOIN blocks_history_test_ctx c ON c.block_id = h.block_id),
  (SELECT history_count_before_noop FROM blocks_history_test_ctx),
  'no-op UPDATE does not produce a history row'
);

-------------------------------------------------------------------------
-- DELETE
-------------------------------------------------------------------------
DELETE FROM public.blocks b
USING blocks_history_test_ctx c
WHERE b.id = c.block_id;

SELECT is((SELECT op FROM latest_blocks_history), 'D'::text, 'DELETE records op=D');
SELECT is((SELECT semantic_op FROM latest_blocks_history), 'delete'::text, 'DELETE records semantic_op=delete');
SELECT ok((SELECT before_diff IS NOT NULL FROM latest_blocks_history), 'DELETE before_diff is the full prior row');
SELECT ok((SELECT before_diff ? 'content' FROM latest_blocks_history), 'DELETE before_diff contains content');
SELECT is((SELECT after_diff FROM latest_blocks_history), NULL::jsonb, 'DELETE has no after_diff');
SELECT is((SELECT changed_columns FROM latest_blocks_history), NULL::text[], 'DELETE has no changed_columns list');

SELECT * FROM finish();

ROLLBACK;
