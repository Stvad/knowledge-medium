-- Caller-identity tests for writes to `blocks` (`blocks_refuse_anon_trg`).
-- Run with:
--
--   pnpm check:db
--
-- This file is pgTAP so `supabase test db` reports named TAP failures.
-- It also wraps itself in BEGIN/ROLLBACK, so manual psql runs leave no
-- residue.
--
-- Writes go through the PostgREST roles, so RLS applies: `anon` must be
-- refused with PT401 (HTTP 401, retried by the client) on every write path,
-- and a real user, writer or not, must still reach RLS and the RPC bodies.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO public, extensions;

SELECT plan(9);

CREATE TEMP TABLE blocks_refuse_anon_test_ctx AS
SELECT
  'test-ws-' || extensions.gen_random_uuid()::text AS workspace_id,
  extensions.gen_random_uuid()::text             AS user_id,
  extensions.gen_random_uuid()::text             AS stranger_id,
  'test-block-a-' || extensions.gen_random_uuid()::text AS block_a_id,
  'test-block-new-' || extensions.gen_random_uuid()::text AS block_new_id,
  -- One minute in the past so `blocks_clamp_updated_at` never clamps.
  (extract(epoch from now()) * 1000)::bigint - 60000 AS then_ms,
  (extract(epoch from now()) * 1000)::bigint AS now_ms;

INSERT INTO public.workspaces (id, name, owner_user_id, create_time, update_time)
SELECT workspace_id, 'test', user_id, now_ms, now_ms
FROM blocks_refuse_anon_test_ctx;

INSERT INTO public.workspace_members (id, workspace_id, user_id, role, create_time)
SELECT extensions.gen_random_uuid()::text, workspace_id, user_id, 'owner', now_ms
FROM blocks_refuse_anon_test_ctx;

INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, references_json, created_at, updated_at,
  user_updated_at, created_by, updated_by, deleted
)
SELECT block_a_id, workspace_id, NULL, 'a0', 'A',
       '{}', '[]', then_ms, then_ms, then_ms, user_id, user_id, false
FROM blocks_refuse_anon_test_ctx;

-- Runs `p_sql` as `p_role` with a JWT whose `sub` is `p_sub`, and returns
-- 'ok' or the SQLSTATE it raised. A raise rolls back the block's
-- subtransaction, which also reverts the role and claims it set. Both claim
-- settings are set because `auth.uid()` reads the legacy per-claim one in the
-- test image and the JSON one on the hosted project.
CREATE FUNCTION pg_temp.outcome_as(p_role text, p_sub text, p_sql text)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', p_sub, 'role', p_role)::text,
    true
  );
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  EXECUTE p_sql;
  RESET ROLE;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END;
$$;

CREATE TEMP TABLE blocks_refuse_anon_sql AS
SELECT
  format('SELECT public.apply_block_patches(%L::jsonb)', jsonb_build_array(jsonb_build_object(
    'id', block_a_id, 'workspace_id', workspace_id,
    'content', 'patched', 'updated_at', then_ms + 1,
    'base_updated_at', then_ms
  ))) AS patch,
  format('SELECT public.apply_block_creates(%L::jsonb)', jsonb_build_array(jsonb_build_object(
    'id', block_new_id, 'workspace_id', workspace_id, 'parent_id', NULL,
    'order_key', 'n0', 'content', 'NEW', 'properties_json', '{}',
    'references_json', '[]', 'created_at', then_ms, 'updated_at', then_ms,
    'user_updated_at', then_ms, 'created_by', user_id, 'updated_by', user_id,
    'deleted', false
  ))) AS creates,
  format('DELETE FROM public.blocks WHERE id = %L', block_a_id) AS delete_a
FROM blocks_refuse_anon_test_ctx;

-------------------------------------------------------------------------
-- anon: refused on every write path, with a code the client retries.
-------------------------------------------------------------------------
SELECT is(
  pg_temp.outcome_as('anon', NULL, (SELECT patch FROM blocks_refuse_anon_sql)),
  'PT401',
  'anon apply_block_patches is refused with PT401'
);

SELECT is(
  pg_temp.outcome_as('anon', NULL, (SELECT creates FROM blocks_refuse_anon_sql)),
  'PT401',
  'anon apply_block_creates is refused with PT401'
);

SELECT is(
  pg_temp.outcome_as('anon', NULL, (SELECT delete_a FROM blocks_refuse_anon_sql)),
  'PT401',
  'anon direct DELETE is refused with PT401'
);

-------------------------------------------------------------------------
-- An authenticated non-writer still gets the permanent rejection: losing
-- access to a workspace must quarantine, not retry forever.
-------------------------------------------------------------------------
SELECT is(
  pg_temp.outcome_as('authenticated',
    (SELECT stranger_id FROM blocks_refuse_anon_test_ctx),
    (SELECT patch FROM blocks_refuse_anon_sql)),
  'P0002',
  'authenticated non-writer apply_block_patches still raises P0002'
);

SELECT is(
  pg_temp.outcome_as('authenticated',
    (SELECT stranger_id FROM blocks_refuse_anon_test_ctx),
    (SELECT creates FROM blocks_refuse_anon_sql)),
  '42501',
  'authenticated non-writer apply_block_creates still raises 42501'
);

-------------------------------------------------------------------------
-- An authenticated writer is unaffected.
-------------------------------------------------------------------------
SELECT is(
  pg_temp.outcome_as('authenticated',
    (SELECT user_id FROM blocks_refuse_anon_test_ctx),
    (SELECT patch FROM blocks_refuse_anon_sql)),
  'ok',
  'authenticated writer apply_block_patches succeeds'
);

SELECT is(
  (SELECT content FROM public.blocks
     WHERE id = (SELECT block_a_id FROM blocks_refuse_anon_test_ctx)),
  'patched'::text,
  'authenticated writer patch lands'
);

SELECT is(
  pg_temp.outcome_as('authenticated',
    (SELECT user_id FROM blocks_refuse_anon_test_ctx),
    (SELECT creates FROM blocks_refuse_anon_sql)),
  'ok',
  'authenticated writer apply_block_creates succeeds'
);

SELECT is(
  (SELECT content FROM public.blocks
     WHERE id = (SELECT block_new_id FROM blocks_refuse_anon_test_ctx)),
  'NEW'::text,
  'authenticated writer create lands'
);

SELECT * FROM finish();

ROLLBACK;
