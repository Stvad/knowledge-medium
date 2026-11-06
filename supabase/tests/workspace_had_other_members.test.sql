BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO public, extensions;

SELECT plan(11);

CREATE TEMP TABLE ids AS
SELECT extensions.gen_random_uuid()::text AS owner, extensions.gen_random_uuid()::text AS member;

SELECT set_config('request.jwt.claim.sub', (SELECT owner FROM ids), true);
CREATE TEMP TABLE created AS
SELECT public.create_workspace('shared') #>> '{workspace,id}' AS shared,
       public.create_workspace('solo') #>> '{workspace,id}' AS solo;

SELECT is(
  (SELECT had_other_members FROM public.workspaces WHERE id = (SELECT solo FROM created)),
  false,
  'a new workspace has had nobody else, its owner''s own membership included'
);

INSERT INTO public.workspace_members (id, workspace_id, user_id, role, create_time)
SELECT extensions.gen_random_uuid()::text, (SELECT shared FROM created), member, 'editor', 1 FROM ids;

SELECT is(
  (SELECT had_other_members FROM public.workspaces WHERE id = (SELECT shared FROM created)),
  true,
  'another member joining sets it'
);

SELECT is(
  (SELECT had_other_members FROM public.workspaces WHERE id = (SELECT solo FROM created)),
  false,
  'and only for that workspace'
);

-- Repointing the owner's own membership row at someone else counts too.
UPDATE public.workspace_members SET user_id = (SELECT member FROM ids)
 WHERE workspace_id = (SELECT solo FROM created);
SELECT is(
  (SELECT had_other_members FROM public.workspaces WHERE id = (SELECT solo FROM created)),
  true,
  'repointing a membership at someone else sets it'
);
UPDATE public.workspace_members SET user_id = (SELECT owner FROM ids)
 WHERE workspace_id = (SELECT solo FROM created);
DROP TRIGGER workspaces_prevent_had_other_members_reset ON public.workspaces;
UPDATE public.workspaces SET had_other_members = false WHERE id = (SELECT solo FROM created);

-- So does moving someone else's membership in from another workspace.
UPDATE public.workspace_members SET workspace_id = (SELECT solo FROM created)
 WHERE workspace_id = (SELECT shared FROM created) AND user_id = (SELECT member FROM ids);
SELECT is(
  (SELECT had_other_members FROM public.workspaces WHERE id = (SELECT solo FROM created)),
  true,
  'moving a membership in from another workspace sets it'
);
UPDATE public.workspace_members SET workspace_id = (SELECT shared FROM created)
 WHERE workspace_id = (SELECT solo FROM created) AND user_id = (SELECT member FROM ids);
UPDATE public.workspaces SET had_other_members = false WHERE id = (SELECT solo FROM created);

CREATE TRIGGER workspaces_prevent_had_other_members_reset
    BEFORE UPDATE OF had_other_members ON public.workspaces
    FOR EACH ROW EXECUTE FUNCTION public.workspaces_prevent_had_other_members_reset();

SELECT set_config('request.jwt.claim.sub', (SELECT member FROM ids), true);
SELECT public.remove_workspace_member((SELECT shared FROM created), (SELECT member FROM ids));

SELECT is(
  (SELECT count(*)::int FROM public.workspace_members
    WHERE workspace_id = (SELECT shared FROM created) AND user_id = (SELECT member FROM ids)),
  0,
  'precondition: the member really has removed themselves'
);

SELECT is(
  (SELECT had_other_members FROM public.workspaces WHERE id = (SELECT shared FROM created)),
  true,
  'it stays set after they leave'
);

SELECT throws_ok(
  format($$UPDATE public.workspaces SET had_other_members = false WHERE id = %L$$, (SELECT shared FROM created)),
  '23514',
  NULL,
  'nobody can clear it'
);

UPDATE public.workspaces SET name = 'renamed' WHERE id = (SELECT shared FROM created);

SELECT is(
  (SELECT name FROM public.workspaces WHERE id = (SELECT shared FROM created)),
  'renamed',
  'other updates to the row still work'
);

-- The backfill, against a workspace that already has another member.
DROP TRIGGER workspaces_prevent_had_other_members_reset ON public.workspaces;
INSERT INTO public.workspace_members (id, workspace_id, user_id, role, create_time)
SELECT extensions.gen_random_uuid()::text, (SELECT shared FROM created), member, 'editor', 1 FROM ids;
UPDATE public.workspaces SET had_other_members = false;

\ir ../migrations/20261106120000_add_workspaces_had_other_members.sql

SELECT is(
  (SELECT had_other_members FROM public.workspaces WHERE id = (SELECT shared FROM created)),
  true,
  'the backfill sets it where another member exists'
);

SELECT is(
  (SELECT had_other_members FROM public.workspaces WHERE id = (SELECT solo FROM created)),
  false,
  'and leaves a workspace with only its owner alone'
);

SELECT * FROM finish();
ROLLBACK;
