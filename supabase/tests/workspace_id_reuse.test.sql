-- Deleted workspace ids are retired, and delete_workspace takes the
-- workspace's history with it. Run with:
--
--   pnpm check:db
--
-- This file is pgTAP so `supabase test db` reports named TAP failures.
-- It also wraps itself in BEGIN/ROLLBACK, so manual psql runs leave no
-- residue. An insert racing the delete of its id needs two connections and is
-- tested in workspace_id_reuse_race.test.sql.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO public, extensions;

SELECT plan(13);

CREATE TEMP TABLE reuse_ctx AS
SELECT
  -- Created through create_workspace, given history, deleted through delete_workspace.
  'test-ws-' || extensions.gen_random_uuid()::text        AS ws,
  -- Keeps its history throughout.
  'test-ws-other-' || extensions.gen_random_uuid()::text  AS other_ws,
  -- Deleted directly by service_role.
  'test-ws-direct-' || extensions.gen_random_uuid()::text AS direct_ws,
  extensions.gen_random_uuid()::text AS e2ee_ws,
  extensions.gen_random_uuid()::text AS owner_id,
  extensions.gen_random_uuid()::text AS stranger_id,
  -- One minute in the past so `blocks_clamp_updated_at` never clamps.
  (extract(epoch from now()) * 1000)::bigint - 60000 AS then_ms,
  (extract(epoch from now()) * 1000)::bigint AS now_ms;

CREATE FUNCTION pg_temp.ctx() RETURNS reuse_ctx LANGUAGE sql AS $$ SELECT * FROM reuse_ctx $$;

-- Runs p_sql as p_role with a JWT whose `sub` is p_sub, and returns 'ok' or
-- '<SQLSTATE>: <message>'. A raise rolls back the subtransaction, which also
-- reverts the role and claims. Both claim settings are set because
-- `auth.uid()` reads the legacy per-claim one in the test image and the JSON
-- one on the hosted project. p_sql may hold several statements.
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
  RETURN SQLSTATE || ': ' || SQLERRM;
END;
$$;

-- outcome_as, always rolled back: a probe that unexpectedly succeeds, because
-- a guard was mutated away, cannot change the state later tests read.
CREATE FUNCTION pg_temp.probe(p_role text, p_sub text, p_sql text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_outcome text;
BEGIN
  BEGIN
    v_outcome := pg_temp.outcome_as(p_role, p_sub, p_sql);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'KMT00';
  EXCEPTION WHEN SQLSTATE 'KMT00' THEN
    NULL;
  END;
  RETURN v_outcome;
END;
$$;

-- p_sql that raises 22012 (division by zero) unless p_ws is visible.
CREATE FUNCTION pg_temp.then_expect_visible(p_sql text, p_ws text) RETURNS text LANGUAGE sql
AS $$ SELECT p_sql || format('; SELECT 1 / (SELECT count(*) FROM public.workspaces WHERE id = %L)::int', p_ws) $$;

CREATE FUNCTION pg_temp.create_sql(p_ws text) RETURNS text LANGUAGE sql
AS $$ SELECT format($q$SELECT public.create_workspace('test', 'none', %L)$q$, p_ws) $$;

CREATE FUNCTION pg_temp.history_count(p_ws text) RETURNS bigint LANGUAGE sql
AS $$ SELECT count(*) FROM public.blocks_history WHERE workspace_id = p_ws $$;

CREATE FUNCTION pg_temp.retired(p_ws text) RETURNS text LANGUAGE sql
AS $$ SELECT format('23505: workspace id %s belonged to a deleted workspace and cannot be reused', p_ws) $$;

-------------------------------------------------------------------------
-- A fresh client-chosen id is accepted, in either mode.
-------------------------------------------------------------------------

SELECT is(
  pg_temp.outcome_as('authenticated', (pg_temp.ctx()).owner_id,
    pg_temp.then_expect_visible(pg_temp.create_sql((pg_temp.ctx()).ws), (pg_temp.ctx()).ws)),
  'ok',
  'create_workspace creates a plaintext workspace under a fresh client-chosen id'
);

SELECT is(
  pg_temp.probe('authenticated', (pg_temp.ctx()).owner_id,
    pg_temp.then_expect_visible(
      format($q$SELECT public.create_workspace('test', 'e2ee', %L, %L)$q$,
             (pg_temp.ctx()).e2ee_ws, 'enc:v1:' || repeat('A', 40)),
      (pg_temp.ctx()).e2ee_ws)),
  'ok',
  'create_workspace creates an e2ee workspace under a fresh client-chosen id'
);

SELECT is(
  pg_temp.probe('service_role', NULL,
    format($q$INSERT INTO public.workspaces (id, name, owner_user_id, create_time, update_time)
              VALUES (%L, 'test', %L, 0, 0)$q$,
           'test-ws-admin-' || extensions.gen_random_uuid()::text, (pg_temp.ctx()).owner_id)),
  'ok',
  'service_role still inserts a workspace under a fresh id'
);

-------------------------------------------------------------------------
-- Fixture: history in ws (create, update, hard delete) and in other_ws;
-- direct_ws has its owner only.
-------------------------------------------------------------------------

INSERT INTO public.workspaces (id, name, owner_user_id, create_time, update_time)
SELECT unnest(ARRAY[other_ws, direct_ws]), 'test', owner_id, now_ms, now_ms
FROM reuse_ctx;

INSERT INTO public.workspace_members (id, workspace_id, user_id, role, create_time)
SELECT extensions.gen_random_uuid()::text, unnest(ARRAY[other_ws, direct_ws]), owner_id, 'owner', now_ms
FROM reuse_ctx;

INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, references_json, created_at, updated_at,
  user_updated_at, created_by, updated_by, deleted
)
SELECT b.id, b.ws, NULL, b.order_key, 'plaintext',
       '{}', '[]', then_ms, then_ms, then_ms, owner_id, owner_id, false
FROM reuse_ctx,
     LATERAL (VALUES (ws || '-a', ws, 'a0'),
                     (ws || '-b', ws, 'a1'),
                     (other_ws || '-a', other_ws, 'a0')) AS b(id, ws, order_key);

UPDATE public.blocks SET content = 'edited', updated_at = (pg_temp.ctx()).then_ms + 1
WHERE id = (pg_temp.ctx()).ws || '-a';

DELETE FROM public.blocks WHERE id = (pg_temp.ctx()).ws || '-b';

SELECT is(
  (SELECT string_agg(op, '' ORDER BY event_id) FROM public.blocks_history
   WHERE workspace_id = (pg_temp.ctx()).ws),
  'IIUD',
  'fixture: ws has create, update and delete history'
);

-------------------------------------------------------------------------
-- delete_workspace takes the workspace's history with it.
-------------------------------------------------------------------------

SELECT is(
  pg_temp.outcome_as('authenticated', (pg_temp.ctx()).owner_id,
    format('SELECT public.delete_workspace(%L)', (pg_temp.ctx()).ws)),
  'ok',
  'the owner deletes the workspace'
);

SELECT is(
  pg_temp.history_count((pg_temp.ctx()).ws),
  0::bigint,
  'delete_workspace leaves no history rows, the delete rows of its cascade included'
);

SELECT is(
  pg_temp.history_count((pg_temp.ctx()).other_ws),
  1::bigint,
  'delete_workspace leaves other workspaces'' history alone'
);

-------------------------------------------------------------------------
-- A deleted id cannot be created again.
-------------------------------------------------------------------------

SELECT is(
  pg_temp.probe('authenticated', (pg_temp.ctx()).stranger_id, pg_temp.create_sql((pg_temp.ctx()).ws)),
  pg_temp.retired((pg_temp.ctx()).ws),
  'create_workspace refuses the id of a deleted workspace'
);

SELECT is(
  pg_temp.probe('authenticated', (pg_temp.ctx()).stranger_id,
    format($q$SELECT public.create_workspace('test', 'e2ee', %L, %L)$q$,
           (pg_temp.ctx()).ws, 'enc:v1:' || repeat('A', 40))),
  pg_temp.retired((pg_temp.ctx()).ws),
  'create_workspace refuses the id of a deleted workspace in e2ee mode too'
);

-------------------------------------------------------------------------
-- Every delete path retires the id; clients have only delete_workspace.
-------------------------------------------------------------------------

SELECT is(
  pg_temp.probe('authenticated', (pg_temp.ctx()).owner_id,
    pg_temp.then_expect_visible(
      format('DELETE FROM public.workspaces WHERE id = %L', (pg_temp.ctx()).other_ws),
      (pg_temp.ctx()).other_ws)),
  'ok',
  'the owner cannot delete the workspace row directly (the delete matches no row)'
);

SELECT is(
  pg_temp.outcome_as('service_role', NULL,
    format('DELETE FROM public.workspaces WHERE id = %L', (pg_temp.ctx()).direct_ws)),
  'ok',
  'service_role deletes a workspace row directly'
);

SELECT is(
  pg_temp.probe('authenticated', (pg_temp.ctx()).stranger_id, pg_temp.create_sql((pg_temp.ctx()).direct_ws)),
  pg_temp.retired((pg_temp.ctx()).direct_ws),
  'create_workspace refuses the id of a workspace deleted outside delete_workspace'
);

SELECT is(
  pg_temp.probe('service_role', NULL,
    format($q$INSERT INTO public.workspaces (id, name, owner_user_id, create_time, update_time)
              VALUES (%L, 'test', %L, 0, 0)$q$,
           (pg_temp.ctx()).direct_ws, (pg_temp.ctx()).owner_id)),
  pg_temp.retired((pg_temp.ctx()).direct_ws),
  'a direct service_role insert of a deleted id is refused too'
);

SELECT * FROM finish();

ROLLBACK;
