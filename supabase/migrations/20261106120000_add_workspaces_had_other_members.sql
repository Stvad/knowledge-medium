-- Has this workspace ever had a member other than its owner? The client runs an
-- HTML document's scripts on sight only when the answer is no. Current membership
-- can't answer that: a member can write a document and then remove themselves
-- (remove_workspace_member allows it), and `blocks.updated_by` is client-claimed.
--
-- One way only. Nothing may clear it, including a workspace writer, who can
-- otherwise update this table directly (RLS workspaces_update + GRANT ALL to
-- authenticated), so like encryption_mode it needs a trigger, not convention.
--
-- Deploy ordering: this db push runs BEFORE the powersync deploy that adds the
-- column to the stream, which runs before clients that read it. Each step tolerates
-- the previous one's absence: a client reads a missing value as "may have had".

alter table public.workspaces
    add column if not exists had_other_members boolean not null default false;

-- Current members only: a member removed before this column existed left no record,
-- can no longer write, and no document type existed for them to have written.
update public.workspaces w
   set had_other_members = true
 where not w.had_other_members
   and exists (
       select 1 from public.workspace_members m
        where m.workspace_id = w.id
          and m.user_id is distinct from w.owner_user_id
   );

create or replace function private.mark_workspace_had_other_members()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $$
begin
    update public.workspaces
       set had_other_members = true
     where id = new.workspace_id
       and not had_other_members
       and owner_user_id is distinct from new.user_id;
    return new;
end;
$$;

drop trigger if exists workspace_members_mark_had_other_members on public.workspace_members;
create trigger workspace_members_mark_had_other_members
    after insert or update of user_id on public.workspace_members
    for each row execute function private.mark_workspace_had_other_members();

create or replace function public.workspaces_prevent_had_other_members_reset()
    returns trigger
    language plpgsql
    set search_path = ''
    as $$
begin
    -- errcode 23514 (check_violation) so a stale or hostile client PATCH lands in the
    -- upload-rejection quarantine instead of retrying forever, as for encryption_mode.
    if old.had_other_members and not new.had_other_members then
        raise exception 'workspaces.had_other_members is one-way'
            using errcode = 'check_violation';
    end if;
    return new;
end;
$$;

drop trigger if exists workspaces_prevent_had_other_members_reset on public.workspaces;
create trigger workspaces_prevent_had_other_members_reset
    before update of had_other_members on public.workspaces
    for each row execute function public.workspaces_prevent_had_other_members_reset();
