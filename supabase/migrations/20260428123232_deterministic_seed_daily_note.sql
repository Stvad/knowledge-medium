-- Make create_workspace seed its root block with a deterministic id
-- derived from (workspace_id, today's iso date) via uuid v5, so that a
-- second client typing [[2026-04-28]] before the new workspace's seed
-- syncs locally lands on the same block instead of producing a parallel
-- daily note that ends up duplicated post-sync.
--
-- The namespace constant matches DAILY_NOTE_NS in src/data/dailyNotes.ts;
-- as long as both sides keep that constant in sync, JS uuidv5 and PG
-- uuid_generate_v5 produce byte-identical UUIDs (both follow RFC 4122 v5
-- — SHA-1 hash of namespace bytes + name bytes, then version/variant
-- bits set the same way).
--
-- Today is supplied by the caller (p_today_iso 'YYYY-MM-DD'); we don't
-- default to server-side now() because the server's UTC day can disagree
-- with the user's local-TZ day for the ~12h overlap window. If client
-- and server disagree, the seeded block id won't line up with what
-- getOrCreateDailyNote(repo, workspaceId, todayIso()) would compute and
-- the user's first action ("create workspace, then immediately type
-- [[today]]") would produce a duplicate row.
--
-- No backfill: workspaces created before this migration keep their
-- random-id seed blocks, which now sit alongside any deterministic-id
-- daily note the client creates next time it resolves "today" — the
-- two won't dedupe. Acceptable per "early dev, no old data" stance;
-- the dup, if it happens, is a one-row cosmetic miss in pre-migration
-- workspaces and doesn't break anything.

begin;

create extension if not exists "uuid-ossp";

drop function if exists public.create_workspace(text) cascade;
drop function if exists public.ensure_personal_workspace() cascade;

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
  -- Daily-note namespace UUID. Mirrors DAILY_NOTE_NS in
  -- src/data/dailyNotes.ts. The input format below
  -- (workspace_id || ':' || iso) mirrors `${workspaceId}:${iso}` in
  -- dailyNoteBlockId(). Drift between the two reintroduces the
  -- duplication this migration prevents — enforced by
  -- src/data/test/dailyNotesMigrationParity.test.ts, which fails the
  -- build before either edit ships unaccompanied.
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

  v_root_block_id := uuid_generate_v5(v_daily_note_ns, v_workspace_id || ':' || v_iso)::text;

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
