-- Properties-as-blocks rollout lever (PR #288 §6): a single per-workspace
-- enum column, the encryption_mode pattern — operator-written, synced to
-- every client through the existing workspace_data stream, synchronously
-- readable after workspace sync, and server-visible (the eventual §11
-- sync-rules split keys on it).
--
-- States are ORDERED: 'cell' → 'children' → 'cell-off'. "Flipped" is always
-- the at-or-past-'children' test, never equality. Transitions are
-- forward-only and operator-only (service-role SQL per the runbook); client
-- writes are rejected by trigger — the workspaces table is directly
-- updatable by workspace writers (RLS workspaces_update + GRANT ALL to
-- authenticated), so like the e2ee fields this needs a trigger, not
-- convention. No attestation RPC by design: the runbook is the gate.
--
-- Deploy ordering (PR #288 §11 slice B): this db push runs BEFORE the
-- powersync deploy that adds the column to the stream, which runs before
-- clients that read it — each step tolerates the previous one's absence
-- (clients read a missing column as 'cell').

alter table public.workspaces
    add column if not exists properties_migration text not null default 'cell'
    constraint workspaces_properties_migration_valid
    check (properties_migration in ('cell', 'children', 'cell-off'));

create or replace function public.workspaces_prevent_properties_migration_change()
    returns trigger
    language plpgsql
    set search_path = ''
    as $$
declare
    old_rank integer;
    new_rank integer;
begin
    if old.properties_migration is not distinct from new.properties_migration then
        return new;
    end if;

    -- Operator path only: service-role (or a direct superuser session).
    -- errcode 23514 (check_violation) so a stale/buggy client PATCH lands in
    -- the upload-rejection quarantine instead of retrying forever — same
    -- convention as workspaces_prevent_e2ee_field_change.
    if current_user not in ('postgres', 'service_role') then
        raise exception 'workspaces.properties_migration is operator-written (% -> %)',
            old.properties_migration, new.properties_migration
            using errcode = 'check_violation';
    end if;

    -- E2EE workspaces never flip (PR #288 §8): the child-backed write path
    -- would put reference-edge metadata into plaintext synced children of a
    -- workspace whose encryption promises otherwise. The runbook gate alone
    -- is one fat-fingered service-role UPDATE away from a leak; encode it.
    -- encryption_mode is itself immutable (workspaces_prevent_e2ee_field_change),
    -- so this check is stable. If §8 option 2 (client-side e2ee flip tooling)
    -- ever ships, that migration replaces this trigger.
    if new.encryption_mode = 'e2ee' then
        raise exception 'e2ee workspaces stay at properties_migration = cell (PR #288 §8)'
            using errcode = 'check_violation';
    end if;

    old_rank := case old.properties_migration
        when 'cell' then 0 when 'children' then 1 when 'cell-off' then 2 end;
    new_rank := case new.properties_migration
        when 'cell' then 0 when 'children' then 1 when 'cell-off' then 2 end;
    -- Forward-only by trigger. Rolling BACK a workspace is a migration, not
    -- a column write (drain + delete children, PR #288 §11 slice B rollback);
    -- the operator runbook drops this trigger for the duration if that day
    -- comes — a silent backward flip would strand recognized field rows.
    if new_rank < old_rank then
        raise exception 'workspaces.properties_migration transitions are forward-only (% -> %)',
            old.properties_migration, new.properties_migration
            using errcode = 'check_violation';
    end if;

    return new;
end;
$$;

drop trigger if exists workspaces_prevent_properties_migration_change_trg
    on public.workspaces;
create trigger workspaces_prevent_properties_migration_change_trg
    before update on public.workspaces
    for each row
    execute function public.workspaces_prevent_properties_migration_change();
