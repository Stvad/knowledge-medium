begin;

create schema if not exists private;

-- Keep internal RLS helpers out of API-role schema lookup.
revoke all on schema private from public;
revoke all on schema private from anon;
revoke all on schema private from authenticated;

create or replace function private.is_workspace_member(p_workspace_id text, p_user_id text)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = p_user_id
  );
$$;

create or replace function private.is_workspace_writer(p_workspace_id text, p_user_id text)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id
      and user_id = p_user_id
      and role in ('owner', 'editor')
  );
$$;

create or replace function private.is_workspace_owner(p_workspace_id text, p_user_id text)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.workspaces
    where id = p_workspace_id and owner_user_id = p_user_id
  );
$$;

alter policy workspaces_read on public.workspaces
  using (private.is_workspace_member(id, auth.uid()::text));

alter policy workspaces_update on public.workspaces
  using (private.is_workspace_writer(id, auth.uid()::text))
  with check (private.is_workspace_writer(id, auth.uid()::text));

alter policy workspace_members_read on public.workspace_members
  using (private.is_workspace_member(workspace_id, auth.uid()::text));

alter policy workspace_members_manage on public.workspace_members
  using (private.is_workspace_owner(workspace_id, auth.uid()::text))
  with check (private.is_workspace_owner(workspace_id, auth.uid()::text));

alter policy workspace_invitations_read_by_owner on public.workspace_invitations
  using (private.is_workspace_owner(workspace_id, auth.uid()::text));

alter policy blocks_read on public.blocks
  using (private.is_workspace_member(workspace_id, auth.uid()::text));

alter policy blocks_write on public.blocks
  using (private.is_workspace_writer(workspace_id, auth.uid()::text))
  with check (private.is_workspace_writer(workspace_id, auth.uid()::text));

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
  if not private.is_workspace_owner(p_workspace_id, v_user_id) then
    raise exception 'Only the workspace owner can delete the workspace';
  end if;

  delete from public.workspaces where id = p_workspace_id;
end $$;

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
  if not private.is_workspace_owner(p_workspace_id, v_caller) then
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

  v_is_owner := private.is_workspace_owner(p_workspace_id, v_caller);

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
  if not private.is_workspace_owner(p_workspace_id, v_caller) then
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

  if lower(v_invitation.email) <> v_email
     and not private.is_workspace_owner(v_invitation.workspace_id, v_user_id) then
    raise exception 'Cannot decline an invitation for another user';
  end if;

  delete from public.workspace_invitations where id = p_invitation_id;
end $$;

create or replace function public.list_workspace_members_with_emails(p_workspace_id text)
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
    and private.is_workspace_member(p_workspace_id, auth.uid()::text)
  order by m.create_time asc, m.id asc;
$$;

revoke execute on function public.is_workspace_member(text, text) from public;
revoke execute on function public.is_workspace_member(text, text) from anon;
revoke execute on function public.is_workspace_member(text, text) from authenticated;
revoke execute on function public.is_workspace_writer(text, text) from public;
revoke execute on function public.is_workspace_writer(text, text) from anon;
revoke execute on function public.is_workspace_writer(text, text) from authenticated;
revoke execute on function public.is_workspace_owner(text, text) from public;
revoke execute on function public.is_workspace_owner(text, text) from anon;
revoke execute on function public.is_workspace_owner(text, text) from authenticated;

drop function public.is_workspace_member(text, text);
drop function public.is_workspace_writer(text, text);
drop function public.is_workspace_owner(text, text);

commit;
