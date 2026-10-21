-- conversion_history_page: the conversion's pages of a workspace's history,
-- in event order, owner-only. Run with:
--
--   pnpm check:db

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO public, extensions;

SELECT plan(6);

CREATE TEMP TABLE page_ctx AS
SELECT
  'test-ws-' || extensions.gen_random_uuid()::text    AS ws,
  'test-ws-other-' || extensions.gen_random_uuid()::text AS other_ws,
  extensions.gen_random_uuid()::text AS owner_id,
  extensions.gen_random_uuid()::text AS editor_id,
  (extract(epoch from now()) * 1000)::bigint AS now_ms;

CREATE FUNCTION pg_temp.ws() RETURNS text LANGUAGE sql AS $$ SELECT ws FROM page_ctx $$;

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
SELECT ws, 'test', owner_id, now_ms, now_ms FROM page_ctx
UNION ALL
SELECT other_ws, 'other', owner_id, now_ms, now_ms FROM page_ctx;

INSERT INTO public.workspace_members (id, workspace_id, user_id, role, create_time)
SELECT extensions.gen_random_uuid()::text, ws, owner_id, 'owner', now_ms FROM page_ctx
UNION ALL
SELECT extensions.gen_random_uuid()::text, ws, editor_id, 'editor', now_ms FROM page_ctx
UNION ALL
SELECT extensions.gen_random_uuid()::text, other_ws, owner_id, 'owner', now_ms FROM page_ctx;

-- Six blocks in each workspace, interleaved, so each workspace's history
-- events are not contiguous.
INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, references_json, created_at, updated_at,
  user_updated_at, created_by, updated_by, deleted
)
SELECT w || '-block-' || n, w, NULL, 'a' || n, 'plaintext ' || n,
       '{}', '[]', now_ms, now_ms, now_ms, owner_id, owner_id, false
FROM page_ctx, generate_series(1, 6) AS n, unnest(ARRAY[ws, other_ws]) AS w
ORDER BY n, w;

CREATE TEMP TABLE events AS
SELECT event_id, row_number() OVER (ORDER BY event_id) AS n
FROM public.blocks_history WHERE workspace_id = pg_temp.ws();

-- The page's event ids, as text, for the given cursor, bound and limit.
CREATE FUNCTION pg_temp.page(p_sub text, p_after bigint, p_through bigint, p_limit int) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.as_user(p_sub, format(
    'SELECT coalesce(string_agg(event_id::text, %L ORDER BY ord), %L) FROM public.conversion_history_page(%L, %s, %s, %s) WITH ORDINALITY AS p(event_id, block_id, workspace_id, op, semantic_op, changed_columns, actor, event_time, before_diff, after_diff, ord)',
    ',', '', pg_temp.ws(), p_after, p_through, p_limit))
$$;

SELECT is(
  pg_temp.page((SELECT owner_id FROM page_ctx), 0, (SELECT max(event_id) FROM events), 100),
  (SELECT string_agg(event_id::text, ',' ORDER BY event_id) FROM events),
  'returns every history row of the workspace, in event order, and none of another');

SELECT is(
  pg_temp.page((SELECT owner_id FROM page_ctx), (SELECT event_id FROM events WHERE n = 2), (SELECT max(event_id) FROM events), 2),
  (SELECT string_agg(event_id::text, ',' ORDER BY event_id) FROM events WHERE n IN (3, 4)),
  'starts after the cursor and stops at the limit');

SELECT is(
  pg_temp.page((SELECT owner_id FROM page_ctx), 0, (SELECT event_id FROM events WHERE n = 3), 100),
  (SELECT string_agg(event_id::text, ',' ORDER BY event_id) FROM events WHERE n <= 3),
  'stops at the bound');

SELECT is(
  pg_temp.page((SELECT editor_id FROM page_ctx), 0, (SELECT max(event_id) FROM events), 100),
  'KMC01: conversion_history_page: only the workspace owner can read its history',
  'refuses a member who is not the owner');

SELECT is(
  pg_temp.as_user((SELECT owner_id FROM page_ctx),
    $$SELECT count(*)::text FROM public.conversion_history_page('test-ws-none', 0, 1, 1)$$),
  'KMC01: conversion_history_page: only the workspace owner can read its history',
  'a workspace that does not exist is refused like one this user does not own');

SELECT ok(
  NOT has_function_privilege('anon', 'public.conversion_history_page(text, bigint, bigint, integer)', 'EXECUTE'),
  'anon cannot call it');

SELECT * FROM finish();
ROLLBACK;
