-- conversion_workspace_counts: the conversion flow's block and history counts,
-- read once, owner-only. Run with:
--
--   pnpm check:db

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO public, extensions;

SELECT plan(6);

CREATE TEMP TABLE counts_ctx AS
SELECT
  'test-ws-' || extensions.gen_random_uuid()::text    AS ws,
  'test-ws-other-' || extensions.gen_random_uuid()::text AS other_ws,
  extensions.gen_random_uuid()::text AS owner_id,
  extensions.gen_random_uuid()::text AS editor_id,
  (extract(epoch from now()) * 1000)::bigint - 60000 AS then_ms,
  (extract(epoch from now()) * 1000)::bigint AS now_ms;

CREATE FUNCTION pg_temp.ws() RETURNS text LANGUAGE sql AS $$ SELECT ws FROM counts_ctx $$;

-- Runs p_sql as an authenticated p_sub; returns its first column as text, or
-- '<SQLSTATE>: <message>'.
CREATE FUNCTION pg_temp.as_user(p_sub text, p_sql text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_result text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_sub, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  EXECUTE p_sql INTO v_result;
  RESET ROLE;
  RETURN v_result;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ': ' || SQLERRM;
END;
$$;

INSERT INTO public.workspaces (id, name, owner_user_id, create_time, update_time)
SELECT ws, 'test', owner_id, now_ms, now_ms FROM counts_ctx
UNION ALL
SELECT other_ws, 'other', owner_id, now_ms, now_ms FROM counts_ctx;

INSERT INTO public.workspace_members (id, workspace_id, user_id, role, create_time)
SELECT extensions.gen_random_uuid()::text, ws, owner_id, 'owner', now_ms FROM counts_ctx
UNION ALL
SELECT extensions.gen_random_uuid()::text, ws, editor_id, 'editor', now_ms FROM counts_ctx
UNION ALL
SELECT extensions.gen_random_uuid()::text, other_ws, owner_id, 'owner', now_ms FROM counts_ctx;

-- Three blocks (one soft-deleted) and one edit in the workspace: 4 history
-- rows. Two blocks in the other workspace, which must not count.
INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, references_json, created_at, updated_at,
  user_updated_at, created_by, updated_by, deleted
)
SELECT w || '-block-' || n, w, NULL, 'a' || n, 'plaintext ' || n,
       '{}', '[]', then_ms, then_ms, then_ms, owner_id, owner_id, n = 3
FROM counts_ctx, generate_series(1, 3) AS n, unnest(ARRAY[ws]) AS w
UNION ALL
SELECT other_ws || '-block-' || n, other_ws, NULL, 'a' || n, 'other ' || n,
       '{}', '[]', then_ms, then_ms, then_ms, owner_id, owner_id, false
FROM counts_ctx, generate_series(1, 2) AS n;

UPDATE public.blocks SET content = 'plaintext 1, edited' WHERE id = pg_temp.ws() || '-block-1';

SELECT is(
  pg_temp.as_user((SELECT owner_id FROM counts_ctx),
    format('SELECT row(block_count, history_count)::text FROM public.conversion_workspace_counts(%L)', pg_temp.ws())),
  '(3,4)',
  'counts every block row of the workspace, soft-deleted included, and every history row, and nothing of another');

SELECT is(
  pg_temp.as_user((SELECT owner_id FROM counts_ctx),
    format('SELECT max_event_id::text FROM public.conversion_workspace_counts(%L)', pg_temp.ws())),
  (SELECT max(event_id)::text FROM public.blocks_history WHERE workspace_id = pg_temp.ws()),
  'returns the workspace''s last history event');

SELECT is(
  pg_temp.as_user((SELECT owner_id FROM counts_ctx),
    $$SELECT row(block_count, history_count, max_event_id)::text FROM public.conversion_workspace_counts('test-ws-none')$$),
  'KMC01: conversion_workspace_counts: only the workspace owner can count it',
  'a workspace that does not exist is refused like one this user does not own');

SELECT is(
  pg_temp.as_user((SELECT editor_id FROM counts_ctx),
    format('SELECT block_count::text FROM public.conversion_workspace_counts(%L)', pg_temp.ws())),
  'KMC01: conversion_workspace_counts: only the workspace owner can count it',
  'refuses a member who is not the owner');

SELECT ok(
  NOT has_function_privilege('anon', 'public.conversion_workspace_counts(text)', 'EXECUTE'),
  'anon cannot call it');

DELETE FROM public.blocks_history WHERE workspace_id = pg_temp.ws();

SELECT is(
  pg_temp.as_user((SELECT owner_id FROM counts_ctx),
    format('SELECT row(block_count, history_count, max_event_id)::text FROM public.conversion_workspace_counts(%L)', pg_temp.ws())),
  '(3,0,0)',
  'an empty history counts as 0 through event 0');

SELECT * FROM finish();
ROLLBACK;
