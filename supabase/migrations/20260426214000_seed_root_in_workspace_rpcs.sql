-- Move workspace root-block seeding into create_workspace, and return the
-- canonical workspace_members row alongside the workspace from both
-- create_workspace and ensure_personal_workspace.
--
-- Why:
--   1. The old client-side seed dance (RPC creates workspace + member;
--      client then writes a root block locally and reloads) could leave
--      the workspace block-less if anything between the RPC and the local
--      seed write failed. Subsequent reloads would find the workspace
--      locally but no root block, poll 12s for it, and throw — soft-lock.
--      Seeding inside the RPC, in the same transaction as the workspace
--      and member rows, makes "workspace with no blocks" unreachable.
--   2. The client used to prime workspace_members locally with a synthetic
--      id (`bootstrap-${workspace.id}`) because the original RPCs didn't
--      return the canonical row. PowerSync later replicated the real row,
--      and both rows persisted (different PKs; the local raw table has
--      no UNIQUE on (workspace_id, user_id)). Returning the canonical row
--      lets the client prime with the real id.
--
-- Both functions now return jsonb so we can deliver { workspace, member,
-- root_block_id [, inserted] } in a single round-trip. Return-type change
-- requires DROP + CREATE; CREATE OR REPLACE rejects return-type changes.

begin;

drop function if exists public.ensure_personal_workspace() cascade;
drop function if exists public.create_workspace(text) cascade;

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
  v_root_block_id text := gen_random_uuid()::text;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.workspaces (id, name, owner_user_id, create_time, update_time)
  values (gen_random_uuid()::text, v_name, v_user_id, v_now, v_now)
  returning * into v_workspace;

  insert into public.workspace_members (id, workspace_id, user_id, role, create_time)
  values (gen_random_uuid()::text, v_workspace.id, v_user_id, 'owner', v_now)
  returning * into v_member;

  insert into public.blocks (
    id, workspace_id, content, properties_json, child_ids_json, parent_id,
    create_time, update_time, created_by_user_id, updated_by_user_id, references_json
  )
  values (
    v_root_block_id, v_workspace.id, '', '{}', '[]', null,
    v_now, v_now, v_user_id, v_user_id, '[]'
  );

  return jsonb_build_object(
    'workspace', to_jsonb(v_workspace),
    'member', to_jsonb(v_member),
    'root_block_id', v_root_block_id
  );
end $$;

grant execute on function public.create_workspace(text) to authenticated;


-- Returns jsonb: { workspace, member, root_block_id, inserted }.
--   inserted=true  → this call created the workspace; root_block_id is the
--                    empty seed block the client may customize.
--   inserted=false → returning an existing workspace; root_block_id is null
--                    (the existing root will arrive via PowerSync sync).
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
      'root_block_id', null::text,
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
