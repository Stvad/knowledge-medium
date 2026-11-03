-- A workspace id is used once: no workspace can again be created under, or
-- moved to, an id any workspace has had, so nothing a deleted workspace left
-- behind (its Storage objects under `<id>/`) passes to a new owner. Deleting
-- a workspace deletes its history.

-- ── used ids ────────────────────────────────────────────────────────────
-- A reuse fails on this primary key (23505), which no snapshot can miss.
-- `private` is not exposed through PostgREST and grants nothing on its
-- tables; RLS with no policy keeps that default-deny if a grant ever lands.
create table private.used_workspace_ids (
    workspace_id text primary key
);

alter table private.used_workspace_ids owner to postgres;
alter table private.used_workspace_ids enable row level security;

-- SECURITY DEFINER: a service_role insert has no grant on the table.
create function public.workspaces_record_id()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $$
begin
    insert into private.used_workspace_ids (workspace_id) values (new.id);
    return null;
end;
$$;

alter function public.workspaces_record_id() owner to postgres;

create trigger workspaces_record_id_trg
    after insert on public.workspaces
    for each row
    execute function public.workspaces_record_id();

create trigger workspaces_record_new_id_trg
    after update of id on public.workspaces
    for each row
    when (old.id is distinct from new.id)
    execute function public.workspaces_record_id();

-- Every id in use, and every id whose deleted workspace left history behind.
insert into private.used_workspace_ids (workspace_id)
    select id from public.workspaces
    union
    select workspace_id from public.blocks_history;

-- Guarded like 20260625000000_add_attachments_storage.sql: on a local
-- `supabase start` the Storage tables do not exist yet at migration time.
do $$
begin
    if to_regclass('storage.objects') is null then
        raise notice 'used_workspace_ids: storage schema not initialised yet; skipping the Storage backfill';
        return;
    end if;
    if row_security_active('storage.objects') then
        raise exception 'used_workspace_ids: RLS filters storage.objects for %, so the backfill would miss ids', current_user;
    end if;

    insert into private.used_workspace_ids (workspace_id)
        select distinct o.ws
            from (select (storage.foldername(name))[1] as ws
                      from storage.objects
                      where bucket_id = 'attachments') o
            where o.ws is not null
        on conflict do nothing;
end $$;

-- ── history ─────────────────────────────────────────────────────────────
-- Deferred to commit: only by then has the cascade to blocks written each
-- deleted block's row into blocks_history. SECURITY DEFINER: it fires as the
-- committing role, which may hold no DELETE grant on blocks_history.
create function public.workspaces_delete_history()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $$
begin
    delete from public.blocks_history where workspace_id = old.id;
    return null;
end;
$$;

alter function public.workspaces_delete_history() owner to postgres;

create constraint trigger workspaces_delete_history_trg
    after delete on public.workspaces
    deferrable initially deferred
    for each row
    execute function public.workspaces_delete_history();
