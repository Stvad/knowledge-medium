-- Caller-identity tests for the block upload RPCs (`apply_block_patches`,
-- `apply_block_creates`). Run with:
--
--   pnpm check:db
--
-- This file is pgTAP so `supabase test db` reports named TAP failures.
-- It also wraps itself in BEGIN/ROLLBACK, so manual psql runs leave no
-- residue.
--
-- Every other RPC test calls as the superuser, which bypasses RLS. These call
-- through the PostgREST roles: `anon` (a request that went out with the anon
-- key because the client's session refresh failed) must be refused with
-- PT401, which PostgREST answers as HTTP 401 and the client retries. A real
-- user, writer or not, must still reach the RPC body.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO public, extensions;

SELECT plan(7);

CREATE TEMP TABLE block_rpcs_anon_test_ctx AS
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
FROM block_rpcs_anon_test_ctx;

INSERT INTO public.workspace_members (id, workspace_id, user_id, role, create_time)
SELECT extensions.gen_random_uuid()::text, workspace_id, user_id, 'owner', now_ms
FROM block_rpcs_anon_test_ctx;

INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, references_json, created_at, updated_at,
  user_updated_at, created_by, updated_by, deleted
)
SELECT block_a_id, workspace_id, NULL, 'a0', 'A',
       '{}', '[]', then_ms, then_ms, then_ms, user_id, user_id, false
FROM block_rpcs_anon_test_ctx;

-- Calls `p_rpc` as `p_role` with a JWT whose `sub` is `p_sub`, and returns
-- 'ok' or the SQLSTATE it raised. A raise rolls back the block's
-- subtransaction, which also reverts the role and claims it set. Both claim
-- settings are set because `auth.uid()` reads the legacy per-claim one in the
-- test image and the JSON one on the hosted project.
CREATE FUNCTION pg_temp.rpc_outcome(p_role text, p_sub text, p_rpc text, p_payload jsonb)
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
  EXECUTE format('SELECT public.%I($1)', p_rpc) USING p_payload;
  RESET ROLE;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END;
$$;

CREATE TEMP TABLE block_rpcs_anon_payloads AS
SELECT
  jsonb_build_array(jsonb_build_object(
    'id', block_a_id, 'workspace_id', workspace_id,
    'content', 'patched', 'updated_at', then_ms + 1,
    'base_updated_at', then_ms
  )) AS patch,
  jsonb_build_array(jsonb_build_object(
    'id', block_new_id, 'workspace_id', workspace_id, 'parent_id', NULL,
    'order_key', 'n0', 'content', 'NEW', 'properties_json', '{}',
    'references_json', '[]', 'created_at', then_ms, 'updated_at', then_ms,
    'user_updated_at', then_ms, 'created_by', user_id, 'updated_by', user_id,
    'deleted', false
  )) AS creates
FROM block_rpcs_anon_test_ctx;

-------------------------------------------------------------------------
-- anon: refused before the body runs, with a code the client retries.
-- (Without the guard RLS hides every row, so a patch reports the target
-- "missing" (P0002) and a create is an RLS violation (42501) — both of
-- which the client quarantines as permanent.)
-------------------------------------------------------------------------
SELECT is(
  pg_temp.rpc_outcome('anon', NULL, 'apply_block_patches',
    (SELECT patch FROM block_rpcs_anon_payloads)),
  'PT401',
  'anon apply_block_patches is refused with PT401'
);

SELECT is(
  pg_temp.rpc_outcome('anon', NULL, 'apply_block_creates',
    (SELECT creates FROM block_rpcs_anon_payloads)),
  'PT401',
  'anon apply_block_creates is refused with PT401'
);

-------------------------------------------------------------------------
-- An authenticated non-writer still reaches the body: losing access to a
-- workspace is a permanent rejection, not a retry-forever 401.
-------------------------------------------------------------------------
SELECT is(
  pg_temp.rpc_outcome('authenticated',
    (SELECT stranger_id FROM block_rpcs_anon_test_ctx), 'apply_block_patches',
    (SELECT patch FROM block_rpcs_anon_payloads)),
  'P0002',
  'authenticated non-writer apply_block_patches still raises P0002'
);

-------------------------------------------------------------------------
-- An authenticated writer is unaffected.
-------------------------------------------------------------------------
SELECT is(
  pg_temp.rpc_outcome('authenticated',
    (SELECT user_id FROM block_rpcs_anon_test_ctx), 'apply_block_patches',
    (SELECT patch FROM block_rpcs_anon_payloads)),
  'ok',
  'authenticated writer apply_block_patches succeeds'
);

SELECT is(
  (SELECT content FROM public.blocks
     WHERE id = (SELECT block_a_id FROM block_rpcs_anon_test_ctx)),
  'patched'::text,
  'authenticated writer patch lands'
);

SELECT is(
  pg_temp.rpc_outcome('authenticated',
    (SELECT user_id FROM block_rpcs_anon_test_ctx), 'apply_block_creates',
    (SELECT creates FROM block_rpcs_anon_payloads)),
  'ok',
  'authenticated writer apply_block_creates succeeds'
);

SELECT is(
  (SELECT content FROM public.blocks
     WHERE id = (SELECT block_new_id FROM block_rpcs_anon_test_ctx)),
  'NEW'::text,
  'authenticated writer create lands'
);

SELECT * FROM finish();

ROLLBACK;
