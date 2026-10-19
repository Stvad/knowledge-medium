-- The flip's table lock, raced from real concurrent sessions. Run with:
--
--   pnpm check:db
--
-- The flip takes LOCK TABLE blocks IN SHARE MODE so that a block write held
-- open across it either commits before the mode changes or sees e2ee and is
-- refused by blocks_require_ciphertext_for_e2ee, which reads the mode without
-- a lock. That needs sessions that commit independently, so the writer and
-- the flipper are dblink connections back into this database, and their
-- fixture is COMMITTED, then deleted at the end.
--
-- dblink connects without a password only for a superuser, which
-- `pnpm check:db` runs as; any other runner skips this file.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO public, extensions;

SELECT plan(22);

SELECT rolsuper AS conv_lock_is_super FROM pg_roles WHERE rolname = current_user \gset

\if :conv_lock_is_super

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

CREATE TEMP TABLE conv_lock_ctx AS
SELECT
  'test-ws-lock-a-' || extensions.gen_random_uuid()::text AS ws_a,
  'test-ws-lock-b-' || extensions.gen_random_uuid()::text AS ws_b,
  'test-ws-lock-c-' || extensions.gen_random_uuid()::text AS ws_c,
  'test-ws-lock-d-' || extensions.gen_random_uuid()::text AS ws_d,
  'test-ws-lock-e-' || extensions.gen_random_uuid()::text AS ws_e,
  extensions.gen_random_uuid()::text AS owner_id,
  extensions.gen_random_uuid()::text AS stranger_id,
  (extract(epoch from now()) * 1000)::bigint - 60000 AS then_ms,
  format('host=%s port=%s dbname=%s user=%s',
    split_part(current_setting('unix_socket_directories'), ',', 1),
    current_setting('port'), current_database(), current_user) AS connstr;

CREATE FUNCTION pg_temp.ctx() RETURNS conv_lock_ctx LANGUAGE sql AS $$ SELECT * FROM conv_lock_ctx $$;

CREATE TEMP TABLE conv_lock_pids (name text PRIMARY KEY, pid int);

-- Runs p_sql on connection p_name and waits for it. A remote error is raised
-- here, so a broken setup step stops the file.
CREATE FUNCTION pg_temp.remote(p_name text, p_sql text) RETURNS void LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM * FROM dblink(p_name, p_sql) AS t(r text);
END;
$$;

-- Like remote(), but returns 'OK' or the remote error's text, prefixed with
-- 'late: ' when it took longer than p_limit.
CREATE FUNCTION pg_temp.remote_outcome_within(p_name text, p_sql text, p_limit interval)
RETURNS text LANGUAGE plpgsql
AS $$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_outcome text;
BEGIN
  PERFORM * FROM dblink(p_name, p_sql, false) AS t(r text);
  v_outcome := dblink_error_message(p_name);
  IF clock_timestamp() - v_started > p_limit THEN
    v_outcome := 'late: ' || v_outcome;
  END IF;
  RETURN v_outcome;
END;
$$;

-- The outcome of p_name's async query: 'OK' or the remote error's message.
-- One more call drains the connection so it takes queries again.
CREATE FUNCTION pg_temp.async_outcome(p_name text) RETURNS text LANGUAGE plpgsql
AS $$
DECLARE
  v_outcome text;
BEGIN
  PERFORM * FROM dblink_get_result(p_name, false) AS t(r text);
  v_outcome := dblink_error_message(p_name);
  PERFORM * FROM dblink_get_result(p_name, false) AS t(r text);
  RETURN v_outcome;
END;
$$;

-- Opens a connection and records its backend pid, which cannot be asked for
-- later while the connection is busy with an async query.
CREATE FUNCTION pg_temp.connect(p_name text) RETURNS void LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM dblink_connect(p_name, (pg_temp.ctx()).connstr);
  INSERT INTO conv_lock_pids
  SELECT p_name, pid FROM dblink(p_name, 'SELECT pg_backend_pid()') AS t(pid int);
END;
$$;

CREATE FUNCTION pg_temp.pid_of(p_name text) RETURNS int LANGUAGE sql
AS $$ SELECT pid FROM conv_lock_pids WHERE name = p_name $$;

-- Begins a transaction on p_name as user p_sub, as PostgREST would: its
-- role, its claims and the authenticator role's timeouts. The settings are
-- transaction-local, so every BEGIN sets them again.
CREATE FUNCTION pg_temp.begin_as(p_name text, p_sub text) RETURNS void LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_temp.remote(p_name, 'BEGIN');
  PERFORM pg_temp.remote(p_name, $q$SET LOCAL lock_timeout = '8s'$q$);
  PERFORM pg_temp.remote(p_name, $q$SET LOCAL statement_timeout = '8s'$q$);
  PERFORM pg_temp.remote(p_name, format(
    $q$SELECT set_config('request.jwt.claim.sub', %L, true)
              || set_config('request.jwt.claims', %L, true)$q$,
    p_sub, json_build_object('sub', p_sub, 'role', 'authenticated')::text));
  PERFORM pg_temp.remote(p_name, 'SET LOCAL ROLE authenticated');
END;
$$;

CREATE FUNCTION pg_temp.begin_as_owner(p_name text) RETURNS void LANGUAGE sql
AS $$ SELECT pg_temp.begin_as(p_name, (pg_temp.ctx()).owner_id) $$;

-- True once p_waiter is blocked on a lock p_holder holds; false after ~5s.
CREATE FUNCTION pg_temp.blocked_by(p_waiter int, p_holder int) RETURNS boolean LANGUAGE plpgsql
AS $$
BEGIN
  FOR i IN 1..200 LOOP
    IF p_holder = ANY (pg_blocking_pids(p_waiter)) THEN
      RETURN true;
    END IF;
    PERFORM pg_sleep(0.025);
  END LOOP;
  RETURN false;
END;
$$;

CREATE FUNCTION pg_temp.patch_sql(p_ws text, p_content text) RETURNS text LANGUAGE sql
AS $$
  SELECT format('SELECT public.apply_block_patches(%L::jsonb)',
    jsonb_build_array(jsonb_build_object('id', p_ws || '-block', 'content', p_content)))
$$;

CREATE FUNCTION pg_temp.flip_sql(p_ws text, p_canary text DEFAULT 'enc:v1:' || repeat('A', 40))
RETURNS text LANGUAGE sql
AS $$ SELECT format('SELECT public.convert_workspace_to_e2ee(%L, %L)', p_ws, p_canary) $$;

CREATE TEMP TABLE conv_lock_bundle (ws text PRIMARY KEY, through bigint, archived bigint);

CREATE FUNCTION pg_temp.purge_sql(p_ws text) RETURNS text LANGUAGE sql
AS $$
  SELECT format('SELECT public.purge_workspace_history(%L, %s, %s)', p_ws, through, archived)
  FROM conv_lock_bundle WHERE ws = p_ws
$$;

CREATE FUNCTION pg_temp.finish_sql(p_ws text) RETURNS text LANGUAGE sql
AS $$ SELECT format('SELECT public.finish_conversion(%L)', p_ws) $$;

CREATE FUNCTION pg_temp.mode_of(p_ws text) RETURNS text LANGUAGE sql
AS $$
  SELECT w.encryption_mode || '/' || coalesce(c.phase, 'none')
  FROM public.workspaces w LEFT JOIN public.workspace_conversions c ON c.workspace_id = w.id
  WHERE w.id = p_ws
$$;

CREATE FUNCTION pg_temp.content_of(p_ws text) RETURNS text LANGUAGE sql
AS $$ SELECT content FROM public.blocks WHERE id = p_ws || '-block' $$;

-- Committed fixture: five plaintext workspaces of one owner, one block each.
SELECT pg_temp.connect('conv_setup');
SELECT pg_temp.connect('conv_writer');
SELECT pg_temp.connect('conv_flipper');

SELECT pg_temp.remote('conv_setup', format($q$
  WITH w AS (SELECT unnest(ARRAY[%3$L, %4$L, %5$L, %6$L, %7$L]) AS id),
  ws AS (
    INSERT INTO public.workspaces (id, name, owner_user_id, create_time, update_time)
    SELECT id, 'test-lock', %1$L, %2$s, %2$s FROM w RETURNING id
  ),
  m AS (
    INSERT INTO public.workspace_members (id, workspace_id, user_id, role, create_time)
    SELECT gen_random_uuid()::text, id, %1$L, 'owner', %2$s FROM ws
  )
  SELECT count(*) FROM ws
$q$, (pg_temp.ctx()).owner_id, (pg_temp.ctx()).then_ms,
     (pg_temp.ctx()).ws_a, (pg_temp.ctx()).ws_b, (pg_temp.ctx()).ws_c,
     (pg_temp.ctx()).ws_d, (pg_temp.ctx()).ws_e));

SELECT pg_temp.remote('conv_setup', format($q$
  INSERT INTO public.blocks (id, workspace_id, parent_id, order_key, content, properties_json,
                             references_json, created_at, updated_at, user_updated_at,
                             created_by, updated_by, deleted)
  SELECT w || '-block', w, NULL, 'a0', 'plaintext', '{}', '[]', %2$s, %2$s, %2$s, %1$L, %1$L, false
  FROM unnest(ARRAY[%3$L, %4$L, %5$L, %6$L, %7$L]) AS w
$q$, (pg_temp.ctx()).owner_id, (pg_temp.ctx()).then_ms,
     (pg_temp.ctx()).ws_a, (pg_temp.ctx()).ws_b, (pg_temp.ctx()).ws_c,
     (pg_temp.ctx()).ws_d, (pg_temp.ctx()).ws_e));

-------------------------------------------------------------------------
-- A write in flight when the flip starts commits first, plaintext and in
-- history, and only then does the mode change.
-------------------------------------------------------------------------
SELECT pg_temp.begin_as_owner('conv_writer');
SELECT pg_temp.remote('conv_writer', pg_temp.patch_sql((pg_temp.ctx()).ws_a, 'written before the flip'));

SELECT pg_temp.begin_as_owner('conv_flipper');
SELECT dblink_send_query('conv_flipper', pg_temp.flip_sql((pg_temp.ctx()).ws_a));

SELECT ok(
  pg_temp.blocked_by(pg_temp.pid_of('conv_flipper'), pg_temp.pid_of('conv_writer')),
  'the flip waits for a block write that is in flight'
);

SELECT is(pg_temp.mode_of((pg_temp.ctx()).ws_a), 'none/none',
  'the mode does not change while the write is open');

SELECT pg_temp.remote('conv_writer', 'COMMIT');

SELECT is(pg_temp.async_outcome('conv_flipper'), 'OK',
  'the flip completes once the write commits');
SELECT pg_temp.remote('conv_flipper', 'COMMIT');

SELECT is(pg_temp.mode_of((pg_temp.ctx()).ws_a), 'e2ee/sealing', 'the flip committed');

SELECT is(pg_temp.content_of((pg_temp.ctx()).ws_a), 'written before the flip',
  'the write that began before the flip committed');

SELECT is(
  (SELECT count(*) FROM public.blocks_history
    WHERE workspace_id = (pg_temp.ctx()).ws_a
      AND after_diff ->> 'content' = 'written before the flip'),
  1::bigint,
  'and is in history'
);

-------------------------------------------------------------------------
-- A write that starts while the flip's transaction is open waits for it,
-- then sees e2ee and is refused.
-------------------------------------------------------------------------
SELECT pg_temp.begin_as_owner('conv_flipper');
SELECT pg_temp.remote('conv_flipper', pg_temp.flip_sql((pg_temp.ctx()).ws_b));

SELECT pg_temp.begin_as_owner('conv_writer');
SELECT dblink_send_query('conv_writer', pg_temp.patch_sql((pg_temp.ctx()).ws_b, 'written during the flip'));

SELECT ok(
  pg_temp.blocked_by(pg_temp.pid_of('conv_writer'), pg_temp.pid_of('conv_flipper')),
  'a block write waits for the flip''s transaction'
);

SELECT pg_temp.remote('conv_flipper', 'COMMIT');

SELECT matches(pg_temp.async_outcome('conv_writer'),
  'must carry a well-formed enc:v1: envelope',
  'once the flip commits, the write sees e2ee and the ciphertext trigger refuses it');
SELECT pg_temp.remote('conv_writer', 'ROLLBACK');

SELECT is(pg_temp.mode_of((pg_temp.ctx()).ws_b), 'e2ee/sealing', 'the flip committed');

SELECT is(pg_temp.content_of((pg_temp.ctx()).ws_b), 'plaintext',
  'no plaintext write landed after the flip');

-------------------------------------------------------------------------
-- A write held open past lock_timeout makes the flip refuse, untouched.
-------------------------------------------------------------------------
SELECT pg_temp.begin_as_owner('conv_writer');
SELECT pg_temp.remote('conv_writer', pg_temp.patch_sql((pg_temp.ctx()).ws_c, 'held open'));

-- Every refusal that does not need the lock is decided before it, so none
-- of them waits for the write.
SELECT pg_temp.begin_as('conv_flipper', (pg_temp.ctx()).stranger_id);
SELECT matches(
  pg_temp.remote_outcome_within('conv_flipper', pg_temp.flip_sql((pg_temp.ctx()).ws_c), '1 second'),
  '^ERROR:  convert_workspace_to_e2ee: only the workspace owner can convert it',
  'a non-owner''s flip is refused without waiting for in-flight writes'
);
SELECT pg_temp.remote('conv_flipper', 'ROLLBACK');

SELECT pg_temp.begin_as_owner('conv_flipper');
SELECT matches(
  pg_temp.remote_outcome_within('conv_flipper', pg_temp.flip_sql((pg_temp.ctx()).ws_c, 'enc:v1:short'), '1 second'),
  '^ERROR:  convert_workspace_to_e2ee: the canary is not an enc:v1: envelope',
  'a malformed canary is refused without waiting for in-flight writes'
);
SELECT pg_temp.remote('conv_flipper', 'ROLLBACK');

SELECT pg_temp.begin_as_owner('conv_flipper');
SELECT matches(
  pg_temp.remote_outcome_within('conv_flipper', pg_temp.flip_sql((pg_temp.ctx()).ws_a), '1 second'),
  '^ERROR:  convert_workspace_to_e2ee: the workspace is not plaintext',
  'an e2ee workspace''s flip is refused without waiting for in-flight writes'
);
SELECT pg_temp.remote('conv_flipper', 'ROLLBACK');

SELECT pg_temp.begin_as_owner('conv_flipper');
-- Within 6s, so the flip's own 2s lock_timeout is what fired, not the
-- session's 8s.
SELECT matches(
  pg_temp.remote_outcome_within('conv_flipper', pg_temp.flip_sql((pg_temp.ctx()).ws_c), '6 seconds'),
  '^ERROR:  convert_workspace_to_e2ee: block writes are still in flight; retry',
  'the flip refuses when an in-flight write outlasts its lock_timeout'
);
SELECT pg_temp.remote('conv_flipper', 'ROLLBACK');
SELECT pg_temp.remote('conv_writer', 'ROLLBACK');

SELECT is(pg_temp.mode_of((pg_temp.ctx()).ws_c), 'none/none',
  'a refused flip leaves the workspace plaintext');

-------------------------------------------------------------------------
-- Concurrent calls of one RPC serialize on a row lock; the later one
-- is refused, never silently accepted.
-------------------------------------------------------------------------
SELECT pg_temp.begin_as_owner('conv_flipper');
SELECT pg_temp.remote('conv_flipper', pg_temp.flip_sql((pg_temp.ctx()).ws_d));

-- The second flip passes the unlocked pre-check, since the first has not
-- committed, and SHARE does not conflict with SHARE.
SELECT pg_temp.begin_as_owner('conv_writer');
SELECT dblink_send_query('conv_writer', pg_temp.flip_sql((pg_temp.ctx()).ws_d, 'enc:v1:' || repeat('B', 40)));
SELECT ok(
  pg_temp.blocked_by(pg_temp.pid_of('conv_writer'), pg_temp.pid_of('conv_flipper')),
  'a second flip of the same workspace waits for the first'
);
SELECT pg_temp.remote('conv_flipper', 'COMMIT');
SELECT matches(pg_temp.async_outcome('conv_writer'),
  '^ERROR:  convert_workspace_to_e2ee: the workspace is not plaintext',
  'and is refused once the first commits');
SELECT pg_temp.remote('conv_writer', 'ROLLBACK');

SELECT is(
  (SELECT wk_canary FROM public.workspaces WHERE id = (pg_temp.ctx()).ws_d),
  'enc:v1:' || repeat('A', 40),
  'the first flip''s canary stands'
);

-- ws_e, flipped and re-sealed, committed; its bundle archived the insert.
SELECT pg_temp.begin_as_owner('conv_setup');
SELECT pg_temp.remote('conv_setup', pg_temp.flip_sql((pg_temp.ctx()).ws_e));
SELECT pg_temp.remote('conv_setup', 'COMMIT');

INSERT INTO conv_lock_bundle
SELECT workspace_id, max(event_id), count(*)
FROM public.blocks_history
WHERE workspace_id = (pg_temp.ctx()).ws_e
GROUP BY workspace_id;

SELECT pg_temp.begin_as_owner('conv_setup');
SELECT pg_temp.remote('conv_setup', format('SELECT public.apply_block_patches(%L::jsonb)',
  jsonb_build_array(jsonb_build_object(
    'id', (pg_temp.ctx()).ws_e || '-block',
    'content', 'enc:v1:' || repeat('C', 40),
    'properties_json', 'enc:v1:' || repeat('P', 40),
    'references_json', 'enc:v1:' || repeat('R', 40),
    'base_updated_at', (SELECT updated_at FROM public.blocks WHERE id = (pg_temp.ctx()).ws_e || '-block')))));
SELECT pg_temp.remote('conv_setup', 'COMMIT');

SELECT pg_temp.begin_as_owner('conv_flipper');
SELECT pg_temp.remote('conv_flipper', pg_temp.purge_sql((pg_temp.ctx()).ws_e));

SELECT pg_temp.begin_as_owner('conv_writer');
SELECT dblink_send_query('conv_writer', pg_temp.purge_sql((pg_temp.ctx()).ws_e));
SELECT ok(
  pg_temp.blocked_by(pg_temp.pid_of('conv_writer'), pg_temp.pid_of('conv_flipper')),
  'a second purge of the same workspace waits for the first'
);
SELECT pg_temp.remote('conv_flipper', 'COMMIT');
SELECT matches(pg_temp.async_outcome('conv_writer'),
  '^ERROR:  purge_workspace_history: the conversion phase is cleaning, not sealing',
  'and is refused on the phase once the first commits');
SELECT pg_temp.remote('conv_writer', 'ROLLBACK');

SELECT pg_temp.begin_as_owner('conv_flipper');
SELECT pg_temp.remote('conv_flipper', pg_temp.finish_sql((pg_temp.ctx()).ws_e));

SELECT pg_temp.begin_as_owner('conv_writer');
SELECT dblink_send_query('conv_writer', pg_temp.finish_sql((pg_temp.ctx()).ws_e));
SELECT ok(
  pg_temp.blocked_by(pg_temp.pid_of('conv_writer'), pg_temp.pid_of('conv_flipper')),
  'a second finish_conversion waits for the first'
);
SELECT pg_temp.remote('conv_flipper', 'COMMIT');
SELECT matches(pg_temp.async_outcome('conv_writer'),
  '^ERROR:  finish_conversion: the conversion phase is none, not cleaning',
  'and is refused once the first commits');
SELECT pg_temp.remote('conv_writer', 'ROLLBACK');

-- The fixture was committed: delete it.
SELECT pg_temp.remote('conv_setup', format($q$
  WITH ws AS (DELETE FROM public.workspaces WHERE id IN (%1$L, %2$L, %3$L, %4$L, %5$L) RETURNING id)
  SELECT count(*) FROM ws
$q$, (pg_temp.ctx()).ws_a, (pg_temp.ctx()).ws_b, (pg_temp.ctx()).ws_c,
     (pg_temp.ctx()).ws_d, (pg_temp.ctx()).ws_e));
SELECT pg_temp.remote('conv_setup', format($q$
  DELETE FROM public.blocks_history WHERE workspace_id IN (%1$L, %2$L, %3$L, %4$L, %5$L)
$q$, (pg_temp.ctx()).ws_a, (pg_temp.ctx()).ws_b, (pg_temp.ctx()).ws_c,
     (pg_temp.ctx()).ws_d, (pg_temp.ctx()).ws_e));
SELECT dblink_disconnect(name) FROM conv_lock_pids;

\else

SELECT skip('dblink connects back only as a superuser; run with pnpm check:db', 22);

\endif

SELECT * FROM finish();

ROLLBACK;
