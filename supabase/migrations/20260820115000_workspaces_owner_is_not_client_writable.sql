-- SECURITY: `workspaces.owner_user_id` becomes immutable to clients.
--
-- Found while reviewing the properties-migration owner flip (issue #671). RLS on
-- `public.workspaces` admits any workspace WRITER (`workspaces_update` ->
-- `private.is_workspace_writer`, i.e. owner OR editor), and both its USING and
-- WITH CHECK clauses re-test on `id`, which an UPDATE of this column does not
-- change. No trigger guarded the column. So an EDITOR could promote themselves in
-- two ordinary PostgREST requests:
--
--     update workspaces set owner_user_id = <self> where id = <ws>;   -- allowed
--     ... and is now the owner for every purpose that reads that column
--
-- `private.is_workspace_owner` reads exactly this column, so that single write
-- also hands the caller `workspaces_delete` and `workspace_members_manage` — the
-- latter being the only gate on rewriting member roles. It is a pre-existing
-- privilege escalation, not one the flip introduced; the flip is what made the
-- column an authorization boundary on the client path and so made it worth
-- closing rather than noting.
--
-- Immutable to CLIENTS, not to everyone: `create_workspace` and
-- `ensure_personal_workspace` set it at INSERT (this is a BEFORE UPDATE trigger,
-- so they are unaffected), and there is no transfer flow today. When one ships it
-- belongs in a SECURITY DEFINER RPC, which runs as `postgres` and is admitted
-- below — the same seam the e2ee columns use, and the reason this is a trigger
-- rather than a REVOKE on the column.

create or replace function public.workspaces_prevent_owner_change()
    returns trigger
    language plpgsql
    set search_path = ''
    as $$
begin
    if old.owner_user_id is not distinct from new.owner_user_id then
        return new;
    end if;

    -- errcode 23514 (check_violation) is PERMANENT, so a stale or buggy client
    -- PATCH quarantines instead of retrying forever. Same convention as
    -- workspaces_prevent_e2ee_field_change.
    if current_user not in ('postgres', 'service_role') then
        raise exception 'workspaces.owner_user_id is not client-writable (% -> %)',
            old.owner_user_id, new.owner_user_id
            using errcode = 'check_violation';
    end if;

    return new;
end;
$$;

drop trigger if exists workspaces_prevent_owner_change_trg on public.workspaces;
create trigger workspaces_prevent_owner_change_trg
    before update on public.workspaces
    for each row
    execute function public.workspaces_prevent_owner_change();
