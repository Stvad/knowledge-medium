-- The in-place E2EE conversion's server half: workspace_conversions, the
-- trigger admit, and the three owner-only RPCs. Run with:
--
--   pnpm check:db
--
-- This file is pgTAP so `supabase test db` reports named TAP failures.
-- It also wraps itself in BEGIN/ROLLBACK, so manual psql runs leave no
-- residue. The flip's table lock needs two connections and is tested in
-- workspace_e2ee_conversion_lock.test.sql.
--
-- RPC refusals share SQLSTATE KMC01 (or KMC02, a stale bundle), so each
-- refusal test matches the whole message, and each scenario breaks exactly
-- one precondition: with a refusal deleted, its own test is the one that
-- fails.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO public, extensions;

SELECT plan(63);

CREATE TEMP TABLE conv_ctx AS
SELECT
  'test-ws-' || extensions.gen_random_uuid()::text    AS ws,
  'test-ws-pt-' || extensions.gen_random_uuid()::text AS plain_ws,
  extensions.gen_random_uuid()::text AS owner_id,
  extensions.gen_random_uuid()::text AS editor_id,
  extensions.gen_random_uuid()::text AS stranger_id,
  -- One minute in the past so `blocks_clamp_updated_at` never clamps.
  (extract(epoch from now()) * 1000)::bigint - 60000 AS then_ms,
  (extract(epoch from now()) * 1000)::bigint AS now_ms;

CREATE FUNCTION pg_temp.ws() RETURNS text LANGUAGE sql AS $$ SELECT ws FROM conv_ctx $$;
CREATE FUNCTION pg_temp.plain_ws() RETURNS text LANGUAGE sql AS $$ SELECT plain_ws FROM conv_ctx $$;
CREATE FUNCTION pg_temp.owner_id() RETURNS text LANGUAGE sql AS $$ SELECT owner_id FROM conv_ctx $$;
CREATE FUNCTION pg_temp.editor_id() RETURNS text LANGUAGE sql AS $$ SELECT editor_id FROM conv_ctx $$;
CREATE FUNCTION pg_temp.stranger_id() RETURNS text LANGUAGE sql AS $$ SELECT stranger_id FROM conv_ctx $$;

-- A well-formed enc:v1: envelope, distinct per seed.
CREATE FUNCTION pg_temp.env(p_seed text)
RETURNS text
LANGUAGE sql
AS $$
  SELECT 'enc:v1:' || rtrim(translate(encode(sha256(convert_to(p_seed, 'UTF8')), 'base64'), '+/', '-_'), '=')
$$;

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

-- outcome_as after p_setup (run as the test session's role), with both
-- always rolled back: a probe that unexpectedly succeeds, because a refusal
-- was mutated away, cannot change the state later tests read.
CREATE FUNCTION pg_temp.probe(p_role text, p_sub text, p_sql text, p_setup text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_outcome text;
BEGIN
  BEGIN
    IF p_setup IS NOT NULL THEN
      EXECUTE p_setup;
    END IF;
    v_outcome := pg_temp.outcome_as(p_role, p_sub, p_sql);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'KMT00';
  EXCEPTION WHEN SQLSTATE 'KMT00' THEN
    NULL;
  END;
  RETURN v_outcome;
END;
$$;

-- The conversion phase of p_ws as the member p_sub sees it through RLS.
CREATE FUNCTION pg_temp.phase_seen_by(p_sub text, p_ws text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_phase text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_sub, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT phase INTO v_phase FROM public.workspace_conversions WHERE workspace_id = p_ws;
  RESET ROLE;
  RETURN coalesce(v_phase, '(no row)');
END;
$$;

-- The conversion phase of p_ws, as the server holds it.
CREATE FUNCTION pg_temp.phase(p_ws text) RETURNS text LANGUAGE sql
AS $$ SELECT coalesce((SELECT phase FROM public.workspace_conversions WHERE workspace_id = p_ws), '(no row)') $$;

-- The trigger's refusal. Matched by message, not only SQLSTATE:
-- workspaces_wk_canary_matches_mode raises 23514 too.
CREATE FUNCTION pg_temp.admit_refusal() RETURNS text LANGUAGE sql
AS $$ SELECT '^23514: workspaces\.encryption_mode and wk_canary change only through convert_workspace_to_e2ee ' $$;

CREATE FUNCTION pg_temp.flip_sql(p_ws text, p_canary text)
RETURNS text LANGUAGE sql
AS $$ SELECT format('SELECT public.convert_workspace_to_e2ee(%L, %L)', p_ws, p_canary) $$;

CREATE FUNCTION pg_temp.purge_sql(p_ws text, p_through bigint, p_count bigint)
RETURNS text LANGUAGE sql
AS $$
  SELECT format('SELECT public.purge_workspace_history(%L, %s, %s)', p_ws,
    coalesce(p_through::text, 'NULL'), coalesce(p_count::text, 'NULL'))
$$;

CREATE FUNCTION pg_temp.finish_sql(p_ws text)
RETURNS text LANGUAGE sql
AS $$ SELECT format('SELECT public.finish_conversion(%L)', p_ws) $$;

-- An UPDATE of the guarded columns with km.conversion naming p_admit_ws:
-- run as postgres, it is what the flip's own UPDATE looks like to the
-- trigger.
CREATE FUNCTION pg_temp.admitted_update_sql(p_admit_ws text, p_ws text, p_set text)
RETURNS text LANGUAGE sql
AS $$
  SELECT format(
    $q$SELECT set_config('km.conversion', %L, true); UPDATE public.workspaces SET %s WHERE id = %L$q$,
    p_admit_ws, p_set, p_ws)
$$;

-------------------------------------------------------------------------
-- Fixture: a plaintext workspace with an owner and an editor, four blocks
-- and one edit, so its history holds 5 rows; and a second plaintext
-- workspace of the same owner, with 3 history rows of its own. Block 3 is
-- soft-deleted. Block 4's content and references_json already look sealed
-- and its properties_json does not, which plaintext allows.
-------------------------------------------------------------------------
INSERT INTO public.workspaces (id, name, owner_user_id, create_time, update_time)
SELECT ws, 'test', owner_id, now_ms, now_ms FROM conv_ctx
UNION ALL
SELECT plain_ws, 'test-plain', owner_id, now_ms, now_ms FROM conv_ctx;

INSERT INTO public.workspace_members (id, workspace_id, user_id, role, create_time)
SELECT extensions.gen_random_uuid()::text, ws, owner_id, 'owner', now_ms FROM conv_ctx
UNION ALL
SELECT extensions.gen_random_uuid()::text, ws, editor_id, 'editor', now_ms FROM conv_ctx
UNION ALL
SELECT extensions.gen_random_uuid()::text, plain_ws, owner_id, 'owner', now_ms FROM conv_ctx;

INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, references_json, created_at, updated_at,
  user_updated_at, created_by, updated_by, deleted
)
SELECT w || '-block-' || n, w, NULL, 'a' || n, 'plaintext ' || n,
       '{"k":"v"}', '[]', then_ms, then_ms, then_ms, owner_id, owner_id, n = 3
FROM conv_ctx, generate_series(1, 3) AS n, unnest(ARRAY[ws, plain_ws]) AS w;

INSERT INTO public.blocks (
  id, workspace_id, parent_id, order_key, content,
  properties_json, references_json, created_at, updated_at,
  user_updated_at, created_by, updated_by, deleted
)
SELECT ws || '-block-4', ws, NULL, 'a4', pg_temp.env('block-4:content'),
       '{"k":"v"}', pg_temp.env('block-4:references'), then_ms, then_ms, then_ms, owner_id, owner_id, false
FROM conv_ctx;

UPDATE public.blocks SET content = 'plaintext 1, edited'
WHERE id = pg_temp.ws() || '-block-1';

-- The recovery bundle's archive point, as the flow reads it after the flip.
-- Nothing between here and the flip writes this workspace's history.
CREATE TEMP TABLE conv_bundle AS
SELECT coalesce(max(event_id), 0) AS through, count(*) AS archived
FROM public.blocks_history
WHERE workspace_id = pg_temp.ws();

CREATE FUNCTION pg_temp.through() RETURNS bigint LANGUAGE sql AS $$ SELECT through FROM conv_bundle $$;
CREATE FUNCTION pg_temp.archived() RETURNS bigint LANGUAGE sql AS $$ SELECT archived FROM conv_bundle $$;

SELECT is(pg_temp.archived(), 5::bigint,
  'fixture: the workspace history holds four inserts and one edit');

-------------------------------------------------------------------------
-- workspace_conversions: members read it, and no client writes it.
-------------------------------------------------------------------------
SELECT ok(
  NOT has_function_privilege('anon', 'public.convert_workspace_to_e2ee(text, text)', 'execute')
  AND NOT has_function_privilege('anon', 'public.purge_workspace_history(text, bigint, bigint)', 'execute')
  AND NOT has_function_privilege('anon', 'public.finish_conversion(text)', 'execute')
  AND has_function_privilege('authenticated', 'public.convert_workspace_to_e2ee(text, text)', 'execute')
  AND has_function_privilege('authenticated', 'public.purge_workspace_history(text, bigint, bigint)', 'execute')
  AND has_function_privilege('authenticated', 'public.finish_conversion(text)', 'execute'),
  'the three RPCs are callable by authenticated and not by anon'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    format($$INSERT INTO public.workspace_conversions (workspace_id, phase) VALUES (%L, 'sealing')$$,
           pg_temp.plain_ws())),
  '42501: permission denied for table workspace_conversions',
  'the owner cannot insert a conversion row'
);

SELECT matches(
  pg_temp.probe('anon', NULL, 'SELECT 1 FROM public.workspace_conversions'),
  '^42501: permission denied for table workspace_conversions',
  'anon cannot read conversion rows'
);

SELECT matches(
  pg_temp.probe('postgres', NULL,
    format($$INSERT INTO public.workspace_conversions (workspace_id, phase) VALUES (%L, 'done')$$,
           pg_temp.plain_ws())),
  '^23514: new row for relation "workspace_conversions" violates check constraint "workspace_conversions_phase_valid"',
  'a phase outside sealing and cleaning violates the check'
);

-------------------------------------------------------------------------
-- The flip.
-------------------------------------------------------------------------
SELECT is(
  pg_temp.probe('authenticated', pg_temp.editor_id(), pg_temp.flip_sql(pg_temp.ws(), pg_temp.env('canary'))),
  'KMC01: convert_workspace_to_e2ee: only the workspace owner can convert it',
  'the flip refuses a member who is not the owner'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.stranger_id(), pg_temp.flip_sql(pg_temp.ws(), pg_temp.env('canary'))),
  'KMC01: convert_workspace_to_e2ee: only the workspace owner can convert it',
  'the flip refuses a non-member'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(), pg_temp.flip_sql(pg_temp.ws(), 'enc:v1:short')),
  'KMC01: convert_workspace_to_e2ee: the canary is not an enc:v1: envelope',
  'the flip refuses a malformed canary'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(), pg_temp.flip_sql(pg_temp.ws(), NULL)),
  'KMC01: convert_workspace_to_e2ee: the canary is not an enc:v1: envelope',
  'the flip refuses a missing canary'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(), pg_temp.finish_sql(pg_temp.ws())),
  'KMC01: finish_conversion: the conversion phase is none, not cleaning',
  'finish_conversion refuses a workspace that is not converting'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(), pg_temp.purge_sql(pg_temp.ws(), 0, 0)),
  'KMC01: purge_workspace_history: the conversion phase is none, not sealing',
  'the purge refuses a workspace that is not converting'
);

SELECT is(
  pg_temp.outcome_as('authenticated', pg_temp.owner_id(), pg_temp.flip_sql(pg_temp.ws(), pg_temp.env('canary'))),
  'ok',
  'the owner flips a plaintext workspace'
);

SELECT results_eq(
  $$SELECT encryption_mode, wk_canary, pg_temp.phase(id) FROM public.workspaces WHERE id = pg_temp.ws()$$,
  $$SELECT 'e2ee'::text, pg_temp.env('canary'), 'sealing'::text$$,
  'the flip sets the mode and the canary, and starts the conversion in sealing'
);

SELECT is(
  (SELECT count(*) FROM public.blocks_history WHERE workspace_id = pg_temp.ws()),
  pg_temp.archived(),
  'the flip writes no block row'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(), pg_temp.flip_sql(pg_temp.ws(), pg_temp.env('canary-2'))),
  'KMC01: convert_workspace_to_e2ee: the workspace is not plaintext',
  'the flip refuses a workspace that is already e2ee'
);

SELECT is(pg_temp.phase_seen_by(pg_temp.editor_id(), pg_temp.ws()), 'sealing',
  'a member reads the conversion phase');

SELECT is(pg_temp.phase_seen_by(pg_temp.stranger_id(), pg_temp.ws()), '(no row)',
  'a non-member does not');

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    format($$UPDATE public.workspace_conversions SET phase = 'cleaning' WHERE workspace_id = %L$$, pg_temp.ws())),
  '42501: permission denied for table workspace_conversions',
  'the owner cannot advance the phase directly'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    format('DELETE FROM public.workspace_conversions WHERE workspace_id = %L', pg_temp.ws())),
  '42501: permission denied for table workspace_conversions',
  'the owner cannot end the conversion directly'
);

SELECT is(
  pg_temp.probe('service_role', NULL,
    format($$UPDATE public.workspace_conversions SET phase = 'cleaning' WHERE workspace_id = %L$$, pg_temp.ws())),
  '42501: permission denied for table workspace_conversions',
  'service_role, which bypasses RLS, cannot write conversion rows either'
);

SELECT is(
  pg_temp.probe('postgres', NULL,
    format('DELETE FROM public.workspaces WHERE id = %L; SELECT 1 / (SELECT count(*) FROM public.workspace_conversions WHERE workspace_id = %L)::int',
           pg_temp.ws(), pg_temp.ws())),
  '22012: division by zero',
  'deleting a converting workspace deletes its conversion row (the division sees zero rows)'
);

-------------------------------------------------------------------------
-- The admit: nothing but the flip changes the mode or the canary.
-------------------------------------------------------------------------
SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    format($$UPDATE public.workspaces SET name = 'renamed' WHERE id = %L$$, pg_temp.ws())),
  'ok',
  'an UPDATE that leaves the guarded columns alone (a rename) still passes'
);

SELECT matches(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    format($$UPDATE public.workspaces SET encryption_mode = 'e2ee', wk_canary = %L WHERE id = %L$$,
           pg_temp.env('canary'), pg_temp.plain_ws())),
  pg_temp.admit_refusal(),
  'the owner cannot flip a workspace with a direct UPDATE'
);

SELECT matches(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    format($$UPDATE public.workspaces SET encryption_mode = 'e2ee' WHERE id = %L$$, pg_temp.plain_ws())),
  pg_temp.admit_refusal(),
  'the mode alone cannot change'
);

SELECT matches(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    format('UPDATE public.workspaces SET wk_canary = %L WHERE id = %L', pg_temp.env('canary-2'), pg_temp.ws())),
  pg_temp.admit_refusal(),
  'the canary alone cannot change'
);

-- Each half of the admit, with the other half satisfied.
SELECT matches(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    pg_temp.admitted_update_sql(pg_temp.plain_ws(), pg_temp.plain_ws(),
      format($$encryption_mode = 'e2ee', wk_canary = %L$$, pg_temp.env('canary')))),
  pg_temp.admit_refusal(),
  'km.conversion does not admit authenticated'
);

SELECT matches(
  pg_temp.probe('service_role', NULL,
    pg_temp.admitted_update_sql(pg_temp.plain_ws(), pg_temp.plain_ws(),
      format($$encryption_mode = 'e2ee', wk_canary = %L$$, pg_temp.env('canary')))),
  pg_temp.admit_refusal(),
  'km.conversion does not admit service_role'
);

SELECT matches(
  pg_temp.probe('postgres', NULL,
    format($$UPDATE public.workspaces SET encryption_mode = 'e2ee', wk_canary = %L WHERE id = %L$$,
           pg_temp.env('canary'), pg_temp.plain_ws())),
  pg_temp.admit_refusal(),
  'postgres without km.conversion is not admitted'
);

SELECT matches(
  pg_temp.probe('postgres', NULL,
    pg_temp.admitted_update_sql(pg_temp.ws(), pg_temp.plain_ws(),
      format($$encryption_mode = 'e2ee', wk_canary = %L$$, pg_temp.env('canary')))),
  pg_temp.admit_refusal(),
  'km.conversion naming another workspace does not admit'
);

SELECT is(
  pg_temp.probe('postgres', NULL,
    pg_temp.admitted_update_sql(pg_temp.plain_ws(), pg_temp.plain_ws(),
      format($$encryption_mode = 'e2ee', wk_canary = %L$$, pg_temp.env('canary')))),
  'ok',
  'control: postgres naming the workspace in km.conversion is admitted for the flip'
);

-- Under the admit, only none -> e2ee passes.
SELECT matches(
  pg_temp.probe('postgres', NULL,
    pg_temp.admitted_update_sql(pg_temp.ws(), pg_temp.ws(),
      $$encryption_mode = 'none', wk_canary = NULL$$)),
  pg_temp.admit_refusal(),
  'e2ee -> none is refused'
);

SELECT matches(
  pg_temp.probe('postgres', NULL,
    pg_temp.admitted_update_sql(pg_temp.ws(), pg_temp.ws(),
      format('wk_canary = %L', pg_temp.env('canary-2')))),
  pg_temp.admit_refusal(),
  'the canary of an e2ee workspace cannot change'
);

SELECT matches(
  pg_temp.probe('postgres', NULL,
    pg_temp.admitted_update_sql(pg_temp.plain_ws(), pg_temp.plain_ws(),
      format('wk_canary = %L', pg_temp.env('canary')))),
  pg_temp.admit_refusal(),
  'a canary cannot land on a plaintext workspace'
);

-------------------------------------------------------------------------
-- A block row is sealed only when every content column is an envelope: the
-- rule the ciphertext trigger enforces and the purge checks.
-------------------------------------------------------------------------
SELECT results_eq(
  $$SELECT public.is_sealed_block(c, p, r) FROM (VALUES
      (pg_temp.env('c'), pg_temp.env('p'), pg_temp.env('r')),
      ('plain',          pg_temp.env('p'), pg_temp.env('r')),
      (pg_temp.env('c'), '{}',             pg_temp.env('r')),
      (pg_temp.env('c'), pg_temp.env('p'), '[]')
    ) AS t(c, p, r)$$,
  $$VALUES (true), (false), (false), (false)$$,
  'a block row is sealed only when content, properties_json and references_json all are'
);

-------------------------------------------------------------------------
-- The purge refuses a plaintext block row; then the re-seal, through the RPC
-- the client uses, soft-deleted row included.
-------------------------------------------------------------------------
SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    pg_temp.purge_sql(pg_temp.ws(), pg_temp.through(), pg_temp.archived())),
  'KMC01: purge_workspace_history: a block row of the workspace is not fully sealed',
  'the purge refuses while a block row is plaintext'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    pg_temp.purge_sql(pg_temp.ws(), pg_temp.through(), pg_temp.archived()),
    format('SELECT public.apply_block_patches(%L::jsonb)',
      (SELECT jsonb_agg(jsonb_build_object(
          'id', b.id,
          'content', pg_temp.env(b.id || ':content'),
          'properties_json', pg_temp.env(b.id || ':properties'),
          'references_json', pg_temp.env(b.id || ':references'),
          'base_updated_at', b.updated_at))
       FROM public.blocks b WHERE b.workspace_id = pg_temp.ws() AND NOT b.deleted))),
  'KMC01: purge_workspace_history: a block row of the workspace is not fully sealed',
  'the purge refuses while a soft-deleted row alone is plaintext'
);

SELECT is(
  pg_temp.outcome_as('authenticated', pg_temp.owner_id(),
    format('SELECT public.apply_block_patches(%L::jsonb)',
      (SELECT jsonb_agg(jsonb_build_object(
          'id', b.id,
          'content', pg_temp.env(b.id || ':content'),
          'properties_json', pg_temp.env(b.id || ':properties'),
          'references_json', pg_temp.env(b.id || ':references'),
          'base_updated_at', b.updated_at) ORDER BY b.id)
       FROM public.blocks b WHERE b.workspace_id = pg_temp.ws() AND b.id <> pg_temp.ws() || '-block-4'))),
  'ok',
  'the owner re-seals blocks 1-3'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    pg_temp.purge_sql(pg_temp.ws(), pg_temp.through(), pg_temp.archived())),
  'KMC01: purge_workspace_history: a block row of the workspace is not fully sealed',
  'the purge refuses a row whose properties_json alone is plaintext'
);

SELECT is(
  pg_temp.outcome_as('authenticated', pg_temp.owner_id(),
    format('SELECT public.apply_block_patches(%L::jsonb)',
      jsonb_build_array(jsonb_build_object(
        'id', pg_temp.ws() || '-block-4',
        'properties_json', pg_temp.env('block-4:properties'),
        'base_updated_at', (SELECT updated_at FROM public.blocks WHERE id = pg_temp.ws() || '-block-4'))))),
  'ok',
  'the owner re-seals block 4'
);

SELECT is(
  (SELECT count(*) FROM public.blocks_history
    WHERE workspace_id = pg_temp.ws()
      AND event_id > pg_temp.through()
      AND changed_columns = ARRAY['content', 'properties_json', 'references_json', 'updated_at']),
  3::bigint,
  'fixture: each full re-seal wrote one history row touching the content columns and the version'
);

-------------------------------------------------------------------------
-- The purge's other refusals, each breaking one precondition.
-------------------------------------------------------------------------
SELECT is(
  pg_temp.probe('authenticated', pg_temp.editor_id(),
    pg_temp.purge_sql(pg_temp.ws(), pg_temp.through(), pg_temp.archived())),
  'KMC01: purge_workspace_history: only the workspace owner can purge its history',
  'the purge refuses a member who is not the owner'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    pg_temp.purge_sql(pg_temp.ws(), NULL, pg_temp.archived())),
  'KMC01: purge_workspace_history: through_event_id is required (an empty history archives through 0)',
  'the purge refuses a null through_event_id'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    pg_temp.purge_sql(pg_temp.ws(), pg_temp.through(), pg_temp.archived() - 1)),
  format('KMC02: purge_workspace_history: 5 history row(s) up to event %s, but the bundle archived 4',
         pg_temp.through()),
  'the purge refuses when the count up to through does not match the bundle'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    pg_temp.purge_sql(pg_temp.ws(), pg_temp.through(), pg_temp.archived()),
    format($$INSERT INTO public.blocks_history
               (event_id, block_id, workspace_id, op, semantic_op, after_diff)
             SELECT min(event_id) - 1, %L, %L, 'I', 'create', '{}'::jsonb
             FROM public.blocks_history$$,
           pg_temp.ws() || '-block-late', pg_temp.ws())),
  format('KMC02: purge_workspace_history: 6 history row(s) up to event %s, but the bundle archived 5',
         pg_temp.through()),
  'the purge refuses a history row that committed late with an id below the boundary'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(), pg_temp.purge_sql(pg_temp.ws(), 0, 0)),
  'KMC02: purge_workspace_history: 5 history row(s) after event 0 are not re-seal writes',
  'the purge over through = 0 refuses the plaintext history'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    pg_temp.purge_sql(pg_temp.ws(), pg_temp.through(), pg_temp.archived()),
    format('SELECT public.apply_block_patches(%L::jsonb)',
      jsonb_build_array(jsonb_build_object(
        'id', pg_temp.ws() || '-block-1',
        'order_key', 'z9',
        'base_updated_at', (SELECT updated_at FROM public.blocks WHERE id = pg_temp.ws() || '-block-1'))))),
  format('KMC02: purge_workspace_history: 1 history row(s) after event %s are not re-seal writes',
         pg_temp.through()),
  'the purge refuses a sealed write after through that touched more than the content columns'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    pg_temp.purge_sql(pg_temp.ws(), pg_temp.through(), pg_temp.archived()),
    format('DELETE FROM public.blocks WHERE id = %L', pg_temp.ws() || '-block-3')),
  format('KMC02: purge_workspace_history: 1 history row(s) after event %s are not re-seal writes',
         pg_temp.through()),
  'the purge refuses a hard delete after through'
);

-- A history row shaped like a re-seal (an UPDATE of one content column and
-- the version) whose new value is plaintext, once per content column.
SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(),
    pg_temp.purge_sql(pg_temp.ws(), pg_temp.through(), pg_temp.archived()),
    format($$INSERT INTO public.blocks_history
               (block_id, workspace_id, op, semantic_op, changed_columns, before_diff, after_diff)
             VALUES (%L, %L, 'U', 'update', ARRAY[%L, 'updated_at'],
                     jsonb_build_object(%L, %L, 'updated_at', 1),
                     jsonb_build_object(%L, 'plaintext', 'updated_at', 2))$$,
           pg_temp.ws() || '-block-2', pg_temp.ws(), col,
           col, pg_temp.env('before'), col)),
  format('KMC02: purge_workspace_history: 1 history row(s) after event %s are not re-seal writes',
         pg_temp.through()),
  format('the purge refuses a re-seal-shaped history row with a plaintext %s', col)
)
FROM unnest(ARRAY['content', 'properties_json', 'references_json']) AS col;

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(), pg_temp.finish_sql(pg_temp.ws())),
  'KMC01: finish_conversion: the conversion phase is sealing, not cleaning',
  'finish_conversion refuses while the phase is sealing'
);

-------------------------------------------------------------------------
-- The purge succeeds, and finish_conversion completes the conversion.
-------------------------------------------------------------------------
-- A re-seal delivered twice: the replay changes nothing but the version,
-- and is still a re-seal write.
SELECT is(
  pg_temp.outcome_as('authenticated', pg_temp.owner_id(),
    format('SELECT public.apply_block_patches(%L::jsonb)',
      jsonb_build_array(jsonb_build_object(
        'id', pg_temp.ws() || '-block-1',
        'content', pg_temp.env(pg_temp.ws() || '-block-1:content'),
        'properties_json', pg_temp.env(pg_temp.ws() || '-block-1:properties'),
        'references_json', pg_temp.env(pg_temp.ws() || '-block-1:references'),
        'base_updated_at', 0)))),
  'ok',
  'a re-seal is replayed'
);

SELECT is(
  (SELECT count(*) FROM public.blocks_history
    WHERE workspace_id = pg_temp.ws() AND changed_columns = ARRAY['updated_at']),
  1::bigint,
  'fixture: the replay wrote a version-only history row'
);

SELECT is(
  pg_temp.outcome_as('authenticated', pg_temp.owner_id(),
    pg_temp.purge_sql(pg_temp.ws(), pg_temp.through(), pg_temp.archived())),
  'ok',
  'the owner purges a fully re-sealed workspace'
);

SELECT results_eq(
  $$SELECT (SELECT count(*) FROM public.blocks_history WHERE workspace_id = pg_temp.ws()),
           pg_temp.phase(pg_temp.ws())$$,
  $$VALUES (0::bigint, 'cleaning'::text)$$,
  'a successful purge leaves zero history rows and the phase cleaning'
);

SELECT is(
  (SELECT count(*) FROM public.blocks_history WHERE workspace_id = pg_temp.plain_ws()),
  3::bigint,
  'the purge leaves other workspaces'' history alone'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(), pg_temp.purge_sql(pg_temp.ws(), 0, 0)),
  'KMC01: purge_workspace_history: the conversion phase is cleaning, not sealing',
  'the purge refuses once the phase is cleaning'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.editor_id(), pg_temp.finish_sql(pg_temp.ws())),
  'KMC01: finish_conversion: only the workspace owner can finish its conversion',
  'finish_conversion refuses a member who is not the owner'
);

SELECT is(
  pg_temp.outcome_as('authenticated', pg_temp.owner_id(), pg_temp.finish_sql(pg_temp.ws())),
  'ok',
  'the owner finishes the conversion'
);

SELECT results_eq(
  $$SELECT encryption_mode, wk_canary, pg_temp.phase(id) FROM public.workspaces WHERE id = pg_temp.ws()$$,
  $$SELECT 'e2ee'::text, pg_temp.env('canary'), '(no row)'::text$$,
  'finish_conversion ends the conversion and keeps the mode and the canary'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(), pg_temp.finish_sql(pg_temp.ws())),
  'KMC01: finish_conversion: the conversion phase is none, not cleaning',
  'a finished conversion cannot be finished again'
);

SELECT is(
  pg_temp.probe('authenticated', pg_temp.owner_id(), pg_temp.flip_sql(pg_temp.ws(), pg_temp.env('canary-2'))),
  'KMC01: convert_workspace_to_e2ee: the workspace is not plaintext',
  'a finished conversion cannot start again'
);

-------------------------------------------------------------------------
-- Only the flip, and the trigger that reads it, name km.conversion: a new
-- function that sets it widens the admit.
-------------------------------------------------------------------------
SELECT is(
  (SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text)
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosrc LIKE '%km.conversion%' AND n.nspname NOT LIKE 'pg_temp%'),
  ARRAY[
    'convert_workspace_to_e2ee(text,text)',
    'workspaces_prevent_e2ee_field_change()'
  ],
  'only the flip sets km.conversion'
);

SELECT * FROM finish();

ROLLBACK;
