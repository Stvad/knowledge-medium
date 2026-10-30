BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO public, extensions;

SELECT plan(8);

-- Exercise the default change with a pre-existing cell-backed workspace.
ALTER TABLE public.workspaces ALTER COLUMN properties_migration SET DEFAULT 'cell';
SELECT set_config('request.jwt.claim.sub', extensions.gen_random_uuid()::text, true);
CREATE TEMP TABLE existing_workspace AS
SELECT public.create_workspace('existing') AS payload;
UPDATE public.workspaces SET create_time = 0
WHERE id = (SELECT payload #>> '{workspace,id}' FROM existing_workspace);

\ir ../migrations/20261030064840_default_new_workspaces_to_child_properties.sql

CREATE TEMP TABLE new_workspaces AS
SELECT public.create_workspace('plaintext') AS payload
UNION ALL
SELECT public.create_workspace(
  'encrypted', 'e2ee', extensions.gen_random_uuid()::text,
  'enc:v1:' || repeat('A', 40)
);

SELECT is(
  (SELECT payload #>> '{workspace,properties_migration}' FROM new_workspaces
   WHERE payload #>> '{workspace,encryption_mode}' = 'none'),
  'children',
  'new plaintext workspaces start with child-backed properties'
);

SELECT is(
  (SELECT payload #>> '{workspace,properties_migration}' FROM new_workspaces
   WHERE payload #>> '{workspace,encryption_mode}' = 'e2ee'),
  'children',
  'new encrypted workspaces start with child-backed properties'
);

CREATE TEMP TABLE existing_personal AS
SELECT public.ensure_personal_workspace() AS payload;

SELECT is(
  (SELECT payload ->> 'inserted' FROM existing_personal),
  'false',
  'personal workspace bootstrap reuses the existing workspace'
);

SELECT is(
  (SELECT payload #>> '{workspace,properties_migration}' FROM existing_personal),
  'cell',
  'personal workspace bootstrap preserves an existing cell-backed workspace'
);

SELECT is(
  (SELECT w.properties_migration FROM public.workspaces w
   JOIN existing_workspace e ON w.id = e.payload #>> '{workspace,id}'),
  'cell',
  'changing the default leaves existing stored workspace state unchanged'
);

SELECT set_config('request.jwt.claim.sub', extensions.gen_random_uuid()::text, true);
CREATE TEMP TABLE new_personal AS
SELECT public.ensure_personal_workspace() AS payload;

SELECT is(
  (SELECT payload ->> 'inserted' FROM new_personal),
  'true',
  'personal workspace bootstrap creates a workspace for a new user'
);

SELECT is(
  (SELECT payload #>> '{workspace,properties_migration}' FROM new_personal),
  'children',
  'new personal workspaces start with child-backed properties'
);

SELECT is(
  (SELECT count(*) FROM public.workspaces w
   JOIN (SELECT payload FROM new_workspaces UNION ALL SELECT payload FROM new_personal) n
     ON w.id = n.payload #>> '{workspace,id}'
   WHERE w.properties_migration = 'children'),
  3::bigint,
  'all new workspace creation paths persist child-backed properties'
);

SELECT * FROM finish();
ROLLBACK;
