-- A deleted workspace's id is retired: inserting a workspace under it is
-- refused on every path, so nothing a deleted workspace left behind (its
-- Storage objects under `<id>/`, or the history of a delete made outside
-- delete_workspace) ever passes to a new owner. delete_workspace also deletes
-- the workspace's history now.

-- ── retired ids ─────────────────────────────────────────────────────────
-- Written by workspaces_retire_deleted_id, read by workspaces_refuse_retired_id.
-- `private` is not exposed through PostgREST, and no API role holds a grant.
create table private.deleted_workspace_ids (
    workspace_id text primary key
);

alter table private.deleted_workspace_ids owner to postgres;
alter table private.deleted_workspace_ids enable row level security;
revoke all on table private.deleted_workspace_ids from public, anon, authenticated, service_role;

-- SECURITY DEFINER, on both triggers: a service_role delete or insert has no
-- grant on the table.
create function public.workspaces_retire_deleted_id()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $$
begin
    insert into private.deleted_workspace_ids (workspace_id) values (old.id);
    return null;
end;
$$;

alter function public.workspaces_retire_deleted_id() owner to postgres;
revoke all on function public.workspaces_retire_deleted_id() from public, anon, authenticated, service_role;

create trigger workspaces_retire_deleted_id_trg
    after delete on public.workspaces
    for each row
    execute function public.workspaces_retire_deleted_id();

-- AFTER, not BEFORE: an insert that waited on the id's uncommitted delete
-- reaches this check only once that delete has committed, so its retired id
-- is visible here.
create function public.workspaces_refuse_retired_id()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $$
begin
    if exists (select 1 from private.deleted_workspace_ids where workspace_id = new.id) then
        raise exception 'workspace id % belonged to a deleted workspace and cannot be reused', new.id
            using errcode = 'unique_violation';
    end if;
    return null;
end;
$$;

alter function public.workspaces_refuse_retired_id() owner to postgres;
revoke all on function public.workspaces_refuse_retired_id() from public, anon, authenticated, service_role;

create trigger workspaces_refuse_retired_id_trg
    after insert on public.workspaces
    for each row
    execute function public.workspaces_refuse_retired_id();

-- ── ids deleted before this migration ───────────────────────────────────
-- Their history and Storage objects are still there. Retiring the ids first
-- leaves any later purge of that residue free to run without reopening them.
insert into private.deleted_workspace_ids (workspace_id)
    select distinct h.workspace_id
        from public.blocks_history h
        where not exists (select 1 from public.workspaces w where w.id = h.workspace_id);

-- Guarded like 20260625000000_add_attachments_storage.sql: on a local
-- `supabase start` the Storage tables do not exist yet at migration time.
do $$
begin
    if to_regclass('storage.objects') is null then
        raise notice 'deleted_workspace_ids: storage schema not initialised yet; skipping the Storage backfill';
        return;
    end if;

    insert into private.deleted_workspace_ids (workspace_id)
        select distinct o.ws
            from (select (storage.foldername(name))[1] as ws
                      from storage.objects
                      where bucket_id = 'attachments') o
            where o.ws is not null
              and not exists (select 1 from public.workspaces w where w.id = o.ws)
        on conflict do nothing;
end $$;

-- ── delete_workspace ────────────────────────────────────────────────────
-- CREATE OR REPLACE resets the function's settings, so the raised
-- statement_timeout (20260513205724) is restated here.
create or replace function public.delete_workspace(p_workspace_id text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    set statement_timeout = '5min'
    as $$
declare
    v_user_id text := auth.uid()::text;
begin
    if v_user_id is null then raise exception 'Not authenticated'; end if;
    if not private.is_workspace_owner(p_workspace_id, v_user_id) then
        raise exception 'Only the workspace owner can delete the workspace';
    end if;

    delete from public.workspaces where id = p_workspace_id;
    -- After the workspace, not before: its cascade to blocks writes a history
    -- row holding the whole block for every block it deletes.
    delete from public.blocks_history where workspace_id = p_workspace_id;
end;
$$;

alter function public.delete_workspace(text) owner to postgres;

-- delete_workspace is the only client path to a delete, so every client delete
-- takes the workspace's history with it.
drop policy workspaces_delete on public.workspaces;
