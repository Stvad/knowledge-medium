-- Behavioral tests for the `apply_block_creates` RPC. Run with:
--
--   yarn check:db
--
-- This file is pgTAP so `supabase test db` reports named TAP failures.
-- It also wraps itself in BEGIN/ROLLBACK, so manual psql runs leave no
-- residue.
--
-- The RPC is insert-or-TOUCH: a genuinely-new id inserts the client's row; a
-- colliding id preserves the SERVER row untouched but re-assigns `updated_at` to
-- itself so the UPDATE emits a WAL change (the "echo" that heals an insert-or-skip
-- phantom). These tests pin the server-side "why safe" claims the migration header
-- states — conflict-row untouched, `updated_at`/`user_updated_at` unchanged, and
-- NO history row from the touch — so they can't silently drift. (They cannot
-- observe WAL/replication itself; that half is verified live against PowerSync.)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO public, extensions;

SELECT plan(13);

CREATE TEMP TABLE apply_block_creates_test_ctx AS
SELECT
  'test-ws-' || extensions.gen_random_uuid()::text AS workspace_id,
  extensions.gen_random_uuid()::text             AS user_id,
  'test-block-a-' || extensions.gen_random_uuid()::text AS block_a_id,
  'test-block-new-' || extensions.gen_random_uuid()::text AS block_new_id,
  'test-block-d-' || extensions.gen_random_uuid()::text AS block_d_id,
  -- Client timestamps stay one minute in the past so `blocks_clamp_updated_at`
  -- never future-clamps them, and `user_updated_at` is seeded (not NULL) so the
  -- touch is a genuine no-op (see the migration header's clamp caveats).
  (extract(epoch from now()) * 1000)::bigint - 60000 AS then_ms,
  (extract(epoch from now()) * 1000)::bigint AS now_ms;

-- Seed: workspace + owner membership so the FK on blocks.workspace_id holds.
INSERT INTO public.workspaces (id, name, owner_user_id, create_time, update_time)
SELECT workspace_id, 'test', user_id, now_ms, now_ms
FROM apply_block_creates_test_ctx;

INSERT INTO public.workspace_members (id, workspace_id, user_id, role, create_time)
SELECT extensions.gen_random_uuid()::text, workspace_id, user_id, 'owner', now_ms
FROM apply_block_creates_test_ctx;

-- One pre-existing server row (block-a) with non-default content + properties, so
-- a colliding create can be proven NOT to clobber them.
INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, references_json, created_at, updated_at,
  user_updated_at, created_by, updated_by, deleted
)
SELECT block_a_id, workspace_id, NULL, 'a0', 'A',
       '{"alias":["A"]}', '[]', then_ms, then_ms, then_ms, user_id, user_id, false
FROM apply_block_creates_test_ctx;

-- Helper builder: a full create payload (all 13 columns the client sends).
-- Wrapped as a SQL closure via format() in each call below.

-------------------------------------------------------------------------
-- Genuine INSERT: a new id lands with the client's values.
-------------------------------------------------------------------------
SELECT lives_ok(
  format($q$SELECT public.apply_block_creates(jsonb_build_array(jsonb_build_object(
    'id', %L, 'workspace_id', %L, 'parent_id', NULL, 'order_key', 'n0',
    'content', 'NEW', 'properties_json', '{}', 'references_json', '[]',
    'created_at', %s, 'updated_at', %s, 'user_updated_at', %s,
    'created_by', %L, 'updated_by', %L, 'deleted', false)))$q$,
    (SELECT block_new_id FROM apply_block_creates_test_ctx),
    (SELECT workspace_id FROM apply_block_creates_test_ctx),
    (SELECT then_ms FROM apply_block_creates_test_ctx),
    (SELECT then_ms FROM apply_block_creates_test_ctx),
    (SELECT then_ms FROM apply_block_creates_test_ctx),
    (SELECT user_id FROM apply_block_creates_test_ctx),
    (SELECT user_id FROM apply_block_creates_test_ctx)),
  'genuine-new create does not raise'
);

SELECT is(
  (SELECT content FROM public.blocks
     WHERE id = (SELECT block_new_id FROM apply_block_creates_test_ctx)),
  'NEW'::text,
  'genuine-new create inserts the client row'
);

SELECT is(
  (SELECT properties_json FROM public.blocks
     WHERE id = (SELECT block_new_id FROM apply_block_creates_test_ctx)),
  '{}'::text,
  'genuine-new create inserts the client properties_json'
);

-------------------------------------------------------------------------
-- Colliding create: the TOUCH preserves the SERVER row and discards the
-- client's proposed content/properties (no clobber), leaving stamps intact.
-------------------------------------------------------------------------
SELECT lives_ok(
  format($q$SELECT public.apply_block_creates(jsonb_build_array(jsonb_build_object(
    'id', %L, 'workspace_id', %L, 'parent_id', NULL, 'order_key', 'zzz',
    'content', 'CLIENT-CONTENT', 'properties_json', '{"client":true}', 'references_json', '[]',
    'created_at', %s, 'updated_at', %s, 'user_updated_at', %s,
    'created_by', %L, 'updated_by', %L, 'deleted', false)))$q$,
    (SELECT block_a_id FROM apply_block_creates_test_ctx),
    (SELECT workspace_id FROM apply_block_creates_test_ctx),
    (SELECT now_ms FROM apply_block_creates_test_ctx),
    (SELECT now_ms FROM apply_block_creates_test_ctx),
    (SELECT now_ms FROM apply_block_creates_test_ctx),
    (SELECT user_id FROM apply_block_creates_test_ctx),
    (SELECT user_id FROM apply_block_creates_test_ctx)),
  'colliding create (touch) does not raise'
);

SELECT is(
  (SELECT content FROM public.blocks
     WHERE id = (SELECT block_a_id FROM apply_block_creates_test_ctx)),
  'A'::text,
  'touch preserves server content (client payload discarded)'
);

SELECT is(
  (SELECT properties_json FROM public.blocks
     WHERE id = (SELECT block_a_id FROM apply_block_creates_test_ctx)),
  '{"alias":["A"]}'::text,
  'touch preserves server properties_json'
);

SELECT is(
  (SELECT updated_at FROM public.blocks
     WHERE id = (SELECT block_a_id FROM apply_block_creates_test_ctx)),
  (SELECT then_ms FROM apply_block_creates_test_ctx),
  'touch leaves updated_at unchanged (clamp no-op, no version bump)'
);

SELECT is(
  (SELECT user_updated_at FROM public.blocks
     WHERE id = (SELECT block_a_id FROM apply_block_creates_test_ctx)),
  (SELECT then_ms FROM apply_block_creates_test_ctx),
  'touch leaves user_updated_at unchanged'
);

SELECT is(
  (SELECT count(*)::int FROM public.blocks_history
     WHERE block_id = (SELECT block_a_id FROM apply_block_creates_test_ctx)
       AND op = 'U'),
  0,
  'touch records NO history row (identical-row guard)'
);

-------------------------------------------------------------------------
-- Multi-row batch mixing a collision + a genuine insert: the existing row
-- stays preserved and the new one lands, in one RPC call.
-------------------------------------------------------------------------
SELECT lives_ok(
  format($q$SELECT public.apply_block_creates(jsonb_build_array(
    jsonb_build_object('id', %L, 'workspace_id', %L, 'parent_id', NULL, 'order_key', 'zzz',
      'content', 'CLIENT-AGAIN', 'properties_json', '{"client":2}', 'references_json', '[]',
      'created_at', %s, 'updated_at', %s, 'user_updated_at', %s, 'created_by', %L, 'updated_by', %L, 'deleted', false),
    jsonb_build_object('id', %L, 'workspace_id', %L, 'parent_id', NULL, 'order_key', 'd0',
      'content', 'D', 'properties_json', '{}', 'references_json', '[]',
      'created_at', %s, 'updated_at', %s, 'user_updated_at', %s, 'created_by', %L, 'updated_by', %L, 'deleted', false)
  ))$q$,
    (SELECT block_a_id FROM apply_block_creates_test_ctx),
    (SELECT workspace_id FROM apply_block_creates_test_ctx),
    (SELECT now_ms FROM apply_block_creates_test_ctx), (SELECT now_ms FROM apply_block_creates_test_ctx),
    (SELECT now_ms FROM apply_block_creates_test_ctx),
    (SELECT user_id FROM apply_block_creates_test_ctx), (SELECT user_id FROM apply_block_creates_test_ctx),
    (SELECT block_d_id FROM apply_block_creates_test_ctx),
    (SELECT workspace_id FROM apply_block_creates_test_ctx),
    (SELECT then_ms FROM apply_block_creates_test_ctx), (SELECT then_ms FROM apply_block_creates_test_ctx),
    (SELECT then_ms FROM apply_block_creates_test_ctx),
    (SELECT user_id FROM apply_block_creates_test_ctx), (SELECT user_id FROM apply_block_creates_test_ctx)),
  'multi-row (collision + insert) does not raise'
);

SELECT is(
  (SELECT content FROM public.blocks
     WHERE id = (SELECT block_a_id FROM apply_block_creates_test_ctx)),
  'A'::text,
  'multi-row: collision still preserves server content'
);

SELECT is(
  (SELECT content FROM public.blocks
     WHERE id = (SELECT block_d_id FROM apply_block_creates_test_ctx)),
  'D'::text,
  'multi-row: genuine-new sibling inserts'
);

-------------------------------------------------------------------------
-- Empty array: no-op, no raise.
-------------------------------------------------------------------------
SELECT lives_ok(
  $q$SELECT public.apply_block_creates('[]'::jsonb)$q$,
  'empty creates array does not raise'
);

SELECT * FROM finish();

ROLLBACK;
