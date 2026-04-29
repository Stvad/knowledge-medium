-- Consolidated initial schema for the v2 data-layer redesign.
--
-- This migration is the canonical ground-truth state for a fresh Supabase
-- project. It supersedes the previous seven migrations (deleted in this
-- branch); the prior project URL is documented in the PR description as a
-- historical snapshot. Per the data-layer redesign (§4 / §13.1):
--
--   - Server schema is just `blocks` (with `workspaces` /
--     `workspace_members` / `workspace_invitations` for auth + sync
--     scoping). NO `tx_context` / `row_events` / `command_events` and NO
--     upload-routing / row_events triggers — those are client-only and
--     live in `src/data/internals/clientSchema.ts`.
--
--   - `blocks` has a NEW shape: `parent_id + order_key` replaces
--     `child_ids_json`; `(workspace_id, id)` is UNIQUE so a composite FK
--     `(workspace_id, parent_id) → blocks (workspace_id, id) DEFERRABLE`
--     enforces the workspace invariant server-side. Tree queries can rely
--     on `parent_id` chains staying within one workspace by construction.
--
--   - Soft-delete-aware indexes match the redesign's expectation that tree
--     queries filter `deleted = 0`.
--
--   - Server enforces NO cycle prevention (FK / triggers can't structurally
--     catch cycles); cycle validation is engine-side on `tx.move` (§4.7
--     Layer 1) plus depth-100 + visited-id CTE guards (§4.7 Layer 2).
--
-- workspaces / workspace_members / workspace_invitations / RLS / RPCs are
-- preserved in their post-migration-#7 final shape.

begin;

-- ============================================================================
-- 0. Teardown — clean break; alpha, no data preserved.
-- ============================================================================

drop publication if exists powersync;

drop function if exists public.list_my_pending_invitations() cascade;
drop function if exists public.list_workspace_members_with_emails(text) cascade;
drop function if exists public.decline_invitation(text) cascade;
drop function if exists public.accept_invitation(text) cascade;
drop function if exists public.invite_member_by_email(text, text, text) cascade;
drop function if exists public.remove_workspace_member(text, text) cascade;
drop function if exists public.update_workspace_member_role(text, text, text) cascade;
drop function if exists public.delete_workspace(text) cascade;
drop function if exists public.create_workspace(text) cascade;
drop function if exists public.create_workspace(text, text) cascade;
drop function if exists public.ensure_personal_workspace() cascade;
drop function if exists public.ensure_personal_workspace(text) cascade;
drop function if exists public.is_workspace_owner(text, text) cascade;
drop function if exists public.is_workspace_writer(text, text) cascade;
drop function if exists public.is_workspace_member(text, text) cascade;
drop function if exists public.blocks_prevent_workspace_change() cascade;

drop table if exists public.workspace_invitations cascade;
drop table if exists public.blocks cascade;
drop table if exists public.workspace_members cascade;
drop table if exists public.workspaces cascade;

-- ============================================================================
-- 1. Extensions
-- ============================================================================

create extension if not exists "pgcrypto";

-- ============================================================================
-- 2. Workspace tables (preserved verbatim from the original schema's
--    post-migration-#7 final state).
-- ============================================================================

create table public.workspaces (
  id text primary key,
  name text not null,
  owner_user_id text not null,
  create_time bigint not null,
  update_time bigint not null
);

create table public.workspace_members (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  user_id text not null,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  create_time bigint not null,
  unique (workspace_id, user_id)
);
create index idx_workspace_members_user_id on public.workspace_members(user_id);

create table public.workspace_invitations (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('editor', 'viewer')),
  invited_by_user_id text not null,
  create_time bigint not null,
  unique (workspace_id, email)
);
create index idx_workspace_invitations_email on public.workspace_invitations(email);

-- ============================================================================
-- 3. blocks — NEW v2 shape per data-layer-redesign §4.1.
--    - `parent_id + order_key` replace `child_ids_json`.
--    - `(workspace_id, id)` UNIQUE backs the composite FK.
--    - DEFERRABLE FK lets PowerSync sync apply rows in any in-tx order.
--    - Soft-delete via `deleted` boolean.
-- ============================================================================

create table public.blocks (
  id              text primary key,
  workspace_id    text not null references public.workspaces(id) on delete cascade,
  parent_id       text,
  order_key       text not null,
  content         text not null default '',
  properties_json text not null default '{}',
  references_json text not null default '[]',
  created_at      bigint not null,
  updated_at      bigint not null,
  created_by      text not null,
  updated_by      text not null,
  deleted         boolean not null default false,

  -- Backs the composite FK below. (workspace_id, parent_id) → (workspace_id, id).
  unique (workspace_id, id),

  -- Workspace invariant: a block's parent (if any) must share its workspace.
  -- DEFERRABLE so sync can apply a parent and its child in the same
  -- transaction without ordering. parent_id IS NULL trivially satisfies the FK.
  -- ON DELETE: workspaces are cascade-deleted, so no per-row cascade needed
  --            (and we don't want orphan-cascade on individual block deletes —
  --            soft-delete handles tree state at the application level).
  foreign key (workspace_id, parent_id)
    references public.blocks (workspace_id, id)
    deferrable initially deferred
);

-- Sibling iteration: (parent_id, order_key, id) under deleted = 0.
-- The (id) tiebreak handles fractional-indexing-jittered key collisions for
-- deterministic post-sync ordering.
create index idx_blocks_parent_order on public.blocks (parent_id, order_key, id)
  where deleted = false;

-- Workspace-wide active-row scans (e.g. findBlocksByType).
create index idx_blocks_workspace_active on public.blocks (workspace_id)
  where deleted = false;

-- Backlink scans: only blocks with non-empty references_json.
create index idx_blocks_workspace_with_references on public.blocks (workspace_id)
  where deleted = false and references_json != '[]';

-- ============================================================================
-- 4. workspace_id immutability trigger
-- ============================================================================

create or replace function public.blocks_prevent_workspace_change()
returns trigger
language plpgsql
as $$
begin
  if OLD.workspace_id is distinct from NEW.workspace_id then
    raise exception 'blocks.workspace_id is immutable (% -> %)',
      OLD.workspace_id, NEW.workspace_id
      using errcode = 'check_violation';
  end if;
  return NEW;
end $$;

create trigger blocks_prevent_workspace_change_trg
  before update on public.blocks
  for each row execute function public.blocks_prevent_workspace_change();

-- ============================================================================
-- 5. Predicate helpers (SECURITY DEFINER to avoid RLS recursion).
-- ============================================================================

create or replace function public.is_workspace_member(p_workspace_id text, p_user_id text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = p_user_id
  );
$$;

create or replace function public.is_workspace_writer(p_workspace_id text, p_user_id text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id
      and user_id = p_user_id
      and role in ('owner', 'editor')
  );
$$;

create or replace function public.is_workspace_owner(p_workspace_id text, p_user_id text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.workspaces
    where id = p_workspace_id and owner_user_id = p_user_id
  );
$$;

grant execute on function public.is_workspace_member(text, text) to authenticated;
grant execute on function public.is_workspace_writer(text, text) to authenticated;
grant execute on function public.is_workspace_owner(text, text) to authenticated;

-- ============================================================================
-- 6. Row-level security
-- ============================================================================

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.blocks enable row level security;

create policy workspaces_read on public.workspaces
  for select
  using (public.is_workspace_member(id, auth.uid()::text));

create policy workspaces_update on public.workspaces
  for update
  using (public.is_workspace_writer(id, auth.uid()::text))
  with check (public.is_workspace_writer(id, auth.uid()::text));

create policy workspaces_delete on public.workspaces
  for delete
  using (owner_user_id = auth.uid()::text);

create policy workspace_members_read on public.workspace_members
  for select
  using (public.is_workspace_member(workspace_id, auth.uid()::text));

create policy workspace_members_manage on public.workspace_members
  for all
  using (public.is_workspace_owner(workspace_id, auth.uid()::text))
  with check (public.is_workspace_owner(workspace_id, auth.uid()::text));

create policy workspace_invitations_read_by_invitee on public.workspace_invitations
  for select
  using (
    auth.email() is not null
    and lower(email) = lower(auth.email())
  );

create policy workspace_invitations_read_by_owner on public.workspace_invitations
  for select
  using (public.is_workspace_owner(workspace_id, auth.uid()::text));

create policy blocks_read on public.blocks
  for select
  using (public.is_workspace_member(workspace_id, auth.uid()::text));

create policy blocks_write on public.blocks
  for all
  using (public.is_workspace_writer(workspace_id, auth.uid()::text))
  with check (public.is_workspace_writer(workspace_id, auth.uid()::text));

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.blocks to authenticated;
grant select on public.workspaces to authenticated;
grant select on public.workspace_members to authenticated;
grant select on public.workspace_invitations to authenticated;

-- ============================================================================
-- 7. RPCs (post-migration-#7 final shape: jsonb returns, no root-block seed)
-- ============================================================================

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


create function public.delete_workspace(p_workspace_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id text := auth.uid()::text;
begin
  if v_user_id is null then raise exception 'Not authenticated'; end if;
  if not public.is_workspace_owner(p_workspace_id, v_user_id) then
    raise exception 'Only the workspace owner can delete the workspace';
  end if;

  delete from public.workspaces where id = p_workspace_id;
end $$;

grant execute on function public.delete_workspace(text) to authenticated;


create function public.update_workspace_member_role(
  p_workspace_id text,
  p_user_id text,
  p_role text
)
returns public.workspace_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text := auth.uid()::text;
  v_member public.workspace_members;
begin
  if v_caller is null then raise exception 'Not authenticated'; end if;
  if not public.is_workspace_owner(p_workspace_id, v_caller) then
    raise exception 'Only the workspace owner can change roles';
  end if;
  if p_role not in ('owner', 'editor', 'viewer') then
    raise exception 'Invalid role: %', p_role;
  end if;

  if p_user_id = v_caller and p_role <> 'owner' then
    raise exception 'Owner cannot demote themselves';
  end if;

  update public.workspace_members
  set role = p_role
  where workspace_id = p_workspace_id and user_id = p_user_id
  returning * into v_member;

  if not found then
    raise exception 'Member not found';
  end if;

  return v_member;
end $$;

grant execute on function public.update_workspace_member_role(text, text, text) to authenticated;


create function public.remove_workspace_member(
  p_workspace_id text,
  p_user_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text := auth.uid()::text;
  v_is_owner boolean;
begin
  if v_caller is null then raise exception 'Not authenticated'; end if;

  v_is_owner := public.is_workspace_owner(p_workspace_id, v_caller);

  if not v_is_owner and p_user_id <> v_caller then
    raise exception 'Only the workspace owner or the target user can remove a member';
  end if;

  if exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id
      and user_id = p_user_id
      and role = 'owner'
  ) then
    raise exception 'Cannot remove the workspace owner; delete the workspace instead';
  end if;

  delete from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id;
end $$;

grant execute on function public.remove_workspace_member(text, text) to authenticated;


create function public.invite_member_by_email(
  p_workspace_id text,
  p_email text,
  p_role text
)
returns public.workspace_invitations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text := auth.uid()::text;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_invitation public.workspace_invitations;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if v_caller is null then raise exception 'Not authenticated'; end if;
  if not public.is_workspace_owner(p_workspace_id, v_caller) then
    raise exception 'Only the workspace owner can invite members';
  end if;
  if v_email = '' then raise exception 'Email is required'; end if;
  if p_role not in ('editor', 'viewer') then
    raise exception 'Role must be editor or viewer';
  end if;

  insert into public.workspace_invitations (
    id, workspace_id, email, role, invited_by_user_id, create_time
  )
  values (
    gen_random_uuid()::text,
    p_workspace_id,
    v_email,
    p_role,
    v_caller,
    v_now
  )
  on conflict (workspace_id, email) do update
    set role = excluded.role,
        invited_by_user_id = excluded.invited_by_user_id,
        create_time = excluded.create_time
  returning * into v_invitation;

  return v_invitation;
end $$;

grant execute on function public.invite_member_by_email(text, text, text) to authenticated;


create function public.accept_invitation(p_invitation_id text)
returns public.workspace_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id text := auth.uid()::text;
  v_email text := lower(trim(coalesce(auth.email(), '')));
  v_invitation public.workspace_invitations;
  v_member public.workspace_members;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if v_user_id is null then raise exception 'Not authenticated'; end if;
  if v_email = '' then raise exception 'Sign in with an email to accept invitations'; end if;

  select * into v_invitation
  from public.workspace_invitations
  where id = p_invitation_id;

  if not found then
    raise exception 'Invitation not found';
  end if;

  if lower(v_invitation.email) <> v_email then
    raise exception 'Invitation is for a different email';
  end if;

  insert into public.workspace_members (
    id, workspace_id, user_id, role, create_time
  )
  values (
    gen_random_uuid()::text,
    v_invitation.workspace_id,
    v_user_id,
    v_invitation.role,
    v_now
  )
  on conflict (workspace_id, user_id) do update
    set role = excluded.role
  returning * into v_member;

  delete from public.workspace_invitations where id = p_invitation_id;

  return v_member;
end $$;

grant execute on function public.accept_invitation(text) to authenticated;


create function public.decline_invitation(p_invitation_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id text := auth.uid()::text;
  v_email text := lower(trim(coalesce(auth.email(), '')));
  v_invitation public.workspace_invitations;
begin
  if v_user_id is null then raise exception 'Not authenticated'; end if;

  select * into v_invitation
  from public.workspace_invitations
  where id = p_invitation_id;

  if not found then return; end if;

  if lower(v_invitation.email) <> v_email
     and not public.is_workspace_owner(v_invitation.workspace_id, v_user_id) then
    raise exception 'Cannot decline an invitation for another user';
  end if;

  delete from public.workspace_invitations where id = p_invitation_id;
end $$;

grant execute on function public.decline_invitation(text) to authenticated;


create function public.list_workspace_members_with_emails(p_workspace_id text)
returns table (
  id text,
  workspace_id text,
  user_id text,
  role text,
  email text,
  create_time bigint
)
language sql
security definer
stable
set search_path = public
as $$
  select
    m.id,
    m.workspace_id,
    m.user_id,
    m.role,
    coalesce(u.email, '')::text as email,
    m.create_time
  from public.workspace_members m
  left join auth.users u on u.id::text = m.user_id
  where m.workspace_id = p_workspace_id
    and public.is_workspace_member(p_workspace_id, auth.uid()::text)
  order by m.create_time asc, m.id asc;
$$;

grant execute on function public.list_workspace_members_with_emails(text) to authenticated;


create function public.list_my_pending_invitations()
returns table (
  id text,
  workspace_id text,
  workspace_name text,
  email text,
  role text,
  invited_by_user_id text,
  create_time bigint
)
language sql
security definer
stable
set search_path = public
as $$
  select
    i.id,
    i.workspace_id,
    w.name as workspace_name,
    i.email,
    i.role,
    i.invited_by_user_id,
    i.create_time
  from public.workspace_invitations i
  join public.workspaces w on w.id = i.workspace_id
  where auth.email() is not null
    and lower(i.email) = lower(auth.email())
  order by i.create_time desc, i.id asc;
$$;

grant execute on function public.list_my_pending_invitations() to authenticated;

-- ============================================================================
-- 8. PowerSync publication
-- ============================================================================

create publication powersync for table
  public.workspaces,
  public.workspace_members,
  public.blocks;

commit;
