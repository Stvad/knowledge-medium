-- A create racing the delete of its id, from real concurrent sessions. Run
-- with:
--
--   pnpm check:db
--
-- The create's insert waits on the delete's uncommitted row and goes ahead
-- once the delete commits, so the retired-id check has to run after that wait.
-- That needs sessions that commit independently, so the deleter and the
-- creator are dblink connections back into this database, and their fixture
-- is COMMITTED, then deleted at the end.
--
-- dblink connects without a password only for a superuser, which
-- `pnpm check:db` runs as; any other runner skips this file.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO public, extensions;

SELECT plan(2);

SELECT rolsuper AS reuse_race_is_super FROM pg_roles WHERE rolname = current_user \gset

\if :reuse_race_is_super

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

CREATE TEMP TABLE reuse_race_ctx AS
SELECT
  'test-ws-race-' || extensions.gen_random_uuid()::text AS ws,
  extensions.gen_random_uuid()::text AS owner_id,
  extensions.gen_random_uuid()::text AS stranger_id,
  format('host=%s port=%s dbname=%s user=%s',
    split_part(current_setting('unix_socket_directories'), ',', 1),
    current_setting('port'), current_database(), current_user) AS connstr;

CREATE FUNCTION pg_temp.ctx() RETURNS reuse_race_ctx LANGUAGE sql AS $$ SELECT * FROM reuse_race_ctx $$;

CREATE TEMP TABLE reuse_race_pids (name text PRIMARY KEY, pid int);

-- Runs p_sql on connection p_name and waits for it. A remote error is raised
-- here, so a broken setup step stops the file.
CREATE FUNCTION pg_temp.remote(p_name text, p_sql text) RETURNS void LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM * FROM dblink(p_name, p_sql) AS t(r text);
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
  INSERT INTO reuse_race_pids
  SELECT p_name, pid FROM dblink(p_name, 'SELECT pg_backend_pid()') AS t(pid int);
END;
$$;

CREATE FUNCTION pg_temp.pid_of(p_name text) RETURNS int LANGUAGE sql
AS $$ SELECT pid FROM reuse_race_pids WHERE name = p_name $$;

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

-- Committed fixture: ws and its owner.
SELECT pg_temp.connect('reuse_setup');
SELECT pg_temp.connect('reuse_deleter');
SELECT pg_temp.connect('reuse_creator');

SELECT pg_temp.remote('reuse_setup', format($q$
  WITH ws AS (
    INSERT INTO public.workspaces (id, name, owner_user_id, create_time, update_time)
    VALUES (%1$L, 'test-race', %2$L, 0, 0) RETURNING id
  )
  INSERT INTO public.workspace_members (id, workspace_id, user_id, role, create_time)
  SELECT gen_random_uuid()::text, id, %2$L, 'owner', 0 FROM ws
$q$, (pg_temp.ctx()).ws, (pg_temp.ctx()).owner_id));

SELECT pg_temp.begin_as('reuse_deleter', (pg_temp.ctx()).owner_id);
SELECT pg_temp.remote('reuse_deleter',
  format('SELECT public.delete_workspace(%L)', (pg_temp.ctx()).ws));

SELECT pg_temp.begin_as('reuse_creator', (pg_temp.ctx()).stranger_id);
SELECT dblink_send_query('reuse_creator',
  format($q$SELECT public.create_workspace('test', 'none', %L)$q$, (pg_temp.ctx()).ws));

SELECT ok(
  pg_temp.blocked_by(pg_temp.pid_of('reuse_creator'), pg_temp.pid_of('reuse_deleter')),
  'fixture: the create waits on the uncommitted delete of its id'
);

SELECT pg_temp.remote('reuse_deleter', 'COMMIT');

SELECT matches(
  pg_temp.async_outcome('reuse_creator'),
  '^ERROR:  workspace id \S+ belonged to a deleted workspace and cannot be reused',
  'a create that waited on the delete of its id is refused once the delete commits'
);
SELECT pg_temp.remote('reuse_creator', 'ROLLBACK');

-- The fixture was committed: delete what is left of it.
SELECT pg_temp.remote('reuse_setup', format(
  'DELETE FROM public.workspaces WHERE id = %1$L; DELETE FROM private.deleted_workspace_ids WHERE workspace_id = %1$L',
  (pg_temp.ctx()).ws));
SELECT dblink_disconnect(name) FROM reuse_race_pids;

\else

SELECT skip('dblink connects back only as a superuser; run with pnpm check:db', 2);

\endif

SELECT * FROM finish();

ROLLBACK;
