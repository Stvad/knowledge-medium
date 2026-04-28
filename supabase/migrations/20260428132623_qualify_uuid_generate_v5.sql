-- Hotfix for the prior migration: uuid-ossp's uuid_generate_v5 lives
-- in supabase's `extensions` schema, but create_workspace runs with
-- `search_path = public` and so failed to resolve an unqualified
-- uuid_generate_v5 call ("function uuid_generate_v5(uuid, text) does
-- not exist"). Qualify the call. Same for ensure_personal_workspace
-- which delegates here.
--
-- Drop+create rather than CREATE OR REPLACE so the function body
-- update is unambiguous when re-applying.

begin;

drop function if exists public.create_workspace(text, text) cascade;
drop function if exists public.ensure_personal_workspace(text) cascade;

create function public.create_workspace(p_name text, p_today_iso text)
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
  v_iso text := nullif(trim(p_today_iso), '');
  v_workspace_id text := gen_random_uuid()::text;
  v_root_block_id text;
  v_daily_note_ns uuid := '53421e08-2f31-42f8-b73a-43830bb718f1';
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if v_iso is null then
    raise exception 'p_today_iso is required';
  end if;

  if v_iso !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'p_today_iso must be YYYY-MM-DD: %', v_iso;
  end if;

  v_root_block_id := extensions.uuid_generate_v5(v_daily_note_ns, v_workspace_id || ':' || v_iso)::text;

  insert into public.workspaces (id, name, owner_user_id, create_time, update_time)
  values (v_workspace_id, v_name, v_user_id, v_now, v_now)
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

grant execute on function public.create_workspace(text, text) to authenticated;


create function public.ensure_personal_workspace(p_today_iso text)
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

  v_create_result := public.create_workspace(v_default_name, p_today_iso);
  return v_create_result || jsonb_build_object('inserted', true);
end $$;

grant execute on function public.ensure_personal_workspace(text) to authenticated;

commit;
