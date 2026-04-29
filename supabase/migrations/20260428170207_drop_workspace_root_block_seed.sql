-- Stop seeding a "workspace root" block from create_workspace /
-- ensure_personal_workspace. The client no longer needs an
-- always-present root block to bootstrap: getInitialBlock lands on
-- today's daily note via getOrCreateDailyNote, which is idempotent
-- under deterministic UUIDs and creates the row client-side if missing.
--
-- The original seed (75bcb48 "Seed root block server-side") existed to
-- prevent a soft-lock where a workspace could exist server-side with
-- zero blocks if the client crashed between the RPC and a follow-up
-- local seed write — every reload then 12s-polled for a non-arriving
-- root and threw. With the client-side daily-note seed doing the
-- right thing, that failure mode is gone: a workspace with zero blocks
-- just creates the daily note on first render and continues.
--
-- The other reason that commit existed — return the canonical member
-- row to avoid duplicate workspace_members locally — is preserved
-- here.  Both RPCs continue to return jsonb { workspace, member [,
-- inserted] }; only the root_block_id field and the p_today_iso
-- parameter (which only fed the deterministic seed-id namespace input)
-- are removed.
--
-- Drop+recreate so the function signature change (removing
-- p_today_iso) and return-shape change land in one transaction.
--
-- No backfill: workspaces created before this migration keep their
-- existing seed-root block as just another parent-less block in the
-- workspace. They still resolve correctly on next reload — the daily
-- note is created on the side and the seed-root simply ages into
-- "abandoned empty page" status. Acceptable per "alpha, no data
-- migrations" stance.

begin;

drop function if exists public.create_workspace(text, text) cascade;
drop function if exists public.ensure_personal_workspace(text) cascade;

create function public.create_workspace(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id text := auth.uid()::text;
  v_workspace public.workspaces;
  v_member public.workspace_members;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_name text := coalesce(nullif(trim(p_name), ''), 'Workspace');
  v_workspace_id text := gen_random_uuid()::text;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.workspaces (id, name, owner_user_id, create_time, update_time)
  values (v_workspace_id, v_name, v_user_id, v_now, v_now)
  returning * into v_workspace;

  insert into public.workspace_members (id, workspace_id, user_id, role, create_time)
  values (gen_random_uuid()::text, v_workspace.id, v_user_id, 'owner', v_now)
  returning * into v_member;

  return jsonb_build_object(
    'workspace', to_jsonb(v_workspace),
    'member', to_jsonb(v_member)
  );
end $$;

grant execute on function public.create_workspace(text) to authenticated;


create function public.ensure_personal_workspace()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id text := auth.uid()::text;
  v_workspace public.workspaces;
  v_member public.workspace_members;
  v_default_name text;
  v_email text;
  v_create_result jsonb;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select w.* into v_workspace
  from public.workspaces w
  join public.workspace_members m on m.workspace_id = w.id
  where m.user_id = v_user_id
  order by w.create_time asc, w.id asc
  limit 1;

  if found then
    select m.* into v_member
    from public.workspace_members m
    where m.workspace_id = v_workspace.id and m.user_id = v_user_id
    limit 1;

    return jsonb_build_object(
      'workspace', to_jsonb(v_workspace),
      'member', to_jsonb(v_member),
      'inserted', false
    );
  end if;

  v_email := nullif(trim(coalesce(auth.email(), '')), '');
  if v_email is not null then
    v_default_name := split_part(v_email, '@', 1) || '''s workspace';
  else
    v_default_name := 'Personal';
  end if;

  v_create_result := public.create_workspace(v_default_name);
  return v_create_result || jsonb_build_object('inserted', true);
end $$;

grant execute on function public.ensure_personal_workspace() to authenticated;

commit;
