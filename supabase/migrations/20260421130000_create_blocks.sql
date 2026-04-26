-- Initial schema: workspaces, members, invitations, blocks.
--
-- Drop-and-recreate is expected on first apply; existing data is disposable.
-- The previous global-graph schema is fully replaced.
--
-- Key invariants:
--   - Every block belongs to exactly one workspace; workspace_id is immutable.
--   - Workspace access is mediated by workspace_members (synthetic id PK so the
--     row is sync-friendly via PowerSync raw tables).
--   - RLS predicates that subquery a table go through SECURITY DEFINER helpers
--     to avoid Postgres' infinite_recursion (42P17) on self-referencing rules.

begin;

-- ============================================================================
-- 0. Teardown
-- ============================================================================

drop publication if exists powersync;

drop function if exists public.decline_invitation(text) cascade;
drop function if exists public.accept_invitation(text) cascade;
drop function if exists public.invite_member_by_email(text, text, text) cascade;
drop function if exists public.remove_workspace_member(text, text) cascade;
drop function if exists public.update_workspace_member_role(text, text, text) cascade;
drop function if exists public.delete_workspace(text) cascade;
drop function if exists public.create_workspace(text) cascade;
drop function if exists public.ensure_personal_workspace() cascade;
drop function if exists public.is_workspace_owner(text, text) cascade;
drop function if exists public.is_workspace_writer(text, text) cascade;
drop function if exists public.is_workspace_member(text, text) cascade;

drop table if exists public.workspace_invitations cascade;
drop table if exists public.blocks cascade;
drop table if exists public.workspace_members cascade;
drop table if exists public.workspaces cascade;

-- ============================================================================
-- 1. Extensions
-- ============================================================================

create extension if not exists "pgcrypto";

-- ============================================================================
-- 2. Tables
-- ============================================================================

create table public.workspaces (
  id text primary key,
  name text not null,
  owner_user_id text not null,
  create_time bigint not null,
  update_time bigint not null
);

-- Synthetic id makes this a single-column-PK table, friendly to PowerSync
-- raw tables. Natural unique key is (workspace_id, user_id).
create table public.workspace_members (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  user_id text not null,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  create_time bigint not null,
  unique (workspace_id, user_id)
);
create index idx_workspace_members_user_id on public.workspace_members(user_id);

-- Pending email-keyed invitations. Email is stored lowercase for match.
-- Not synced via PowerSync; the client fetches via Supabase REST + RLS so
-- we don't need to thread the email claim into a sync rule.
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

create table public.blocks (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  content text not null default '',
  properties_json text not null default '{}',
  child_ids_json text not null default '[]',
  parent_id text,
  create_time bigint not null,
  update_time bigint not null,
  created_by_user_id text not null,
  updated_by_user_id text not null,
  references_json text not null default '[]'
);
create index idx_blocks_parent_id on public.blocks(parent_id);
create index idx_blocks_workspace_id on public.blocks(workspace_id);

-- ============================================================================
-- 3. blocks.workspace_id immutability trigger
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
-- 4. Predicate helpers (SECURITY DEFINER to avoid RLS recursion).
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
-- 5. Row-level security
-- ============================================================================

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.blocks enable row level security;

-- workspaces: read by members; rename by writers; delete by owner.
-- Inserts go through create_workspace / ensure_personal_workspace RPCs.
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

-- workspace_members: read by co-members. Manage by owner only.
-- Self-leave handled via RPC (so we can guard against last-owner removal);
-- no direct DELETE policy for non-owners.
create policy workspace_members_read on public.workspace_members
  for select
  using (public.is_workspace_member(workspace_id, auth.uid()::text));

create policy workspace_members_manage on public.workspace_members
  for all
  using (public.is_workspace_owner(workspace_id, auth.uid()::text))
  with check (public.is_workspace_owner(workspace_id, auth.uid()::text));

-- workspace_invitations: read by invitee (matched on email), and by workspace owner.
-- Mutations only via RPC.
create policy workspace_invitations_read_by_invitee on public.workspace_invitations
  for select
  using (
    auth.email() is not null
    and lower(email) = lower(auth.email())
  );

create policy workspace_invitations_read_by_owner on public.workspace_invitations
  for select
  using (public.is_workspace_owner(workspace_id, auth.uid()::text));

-- blocks: read by workspace member; write by workspace writer.
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
-- 6. RPCs
-- ============================================================================

-- Create a workspace and add the caller as the sole owner. Single round-trip,
-- atomic on success.
create or replace function public.create_workspace(p_name text)
returns public.workspaces
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id text := auth.uid()::text;
  v_workspace public.workspaces;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_name text := coalesce(nullif(trim(p_name), ''), 'Workspace');
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.workspaces (id, name, owner_user_id, create_time, update_time)
  values (gen_random_uuid()::text, v_name, v_user_id, v_now, v_now)
  returning * into v_workspace;

  insert into public.workspace_members (id, workspace_id, user_id, role, create_time)
  values (gen_random_uuid()::text, v_workspace.id, v_user_id, 'owner', v_now);

  return v_workspace;
end $$;

grant execute on function public.create_workspace(text) to authenticated;


-- Idempotent first-bootstrap RPC. Returns the user's first workspace
-- (in create_time order) if any exist, else creates a fresh one.
-- Replaces the racy client-side "wait for sync, then create" pattern.
create or replace function public.ensure_personal_workspace()
returns public.workspaces
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id text := auth.uid()::text;
  v_workspace public.workspaces;
  v_default_name text;
  v_email text;
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
    return v_workspace;
  end if;

  v_email := nullif(trim(coalesce(auth.email(), '')), '');
  if v_email is not null then
    v_default_name := split_part(v_email, '@', 1) || '''s workspace';
  else
    v_default_name := 'Personal';
  end if;

  return public.create_workspace(v_default_name);
end $$;

grant execute on function public.ensure_personal_workspace() to authenticated;


create or replace function public.delete_workspace(p_workspace_id text)
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


create or replace function public.update_workspace_member_role(
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

  -- No self-demotion: ownership transfer is out of scope for v1.
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


create or replace function public.remove_workspace_member(
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

  -- Either the workspace owner or the target user themselves can remove.
  -- (Self-leave: punted to a follow-up; users who want out today get removed by owner.)
  if not v_is_owner and p_user_id <> v_caller then
    raise exception 'Only the workspace owner or the target user can remove a member';
  end if;

  -- The owner row cannot be removed; delete the workspace instead.
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


-- Always creates an invitation row (even if the invitee already exists).
-- The recipient sees it via the workspace_invitations_read_by_invitee policy,
-- and accept_invitation converts it into a workspace_members row.
create or replace function public.invite_member_by_email(
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


create or replace function public.accept_invitation(p_invitation_id text)
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


create or replace function public.decline_invitation(p_invitation_id text)
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

  -- The invitee or the workspace owner can decline (delete) the invitation.
  if lower(v_invitation.email) <> v_email
     and not public.is_workspace_owner(v_invitation.workspace_id, v_user_id) then
    raise exception 'Cannot decline an invitation for another user';
  end if;

  delete from public.workspace_invitations where id = p_invitation_id;
end $$;

grant execute on function public.decline_invitation(text) to authenticated;

-- ============================================================================
-- 7. PowerSync publication
-- ============================================================================

create publication powersync for table
  public.workspaces,
  public.workspace_members,
  public.blocks;

commit;
