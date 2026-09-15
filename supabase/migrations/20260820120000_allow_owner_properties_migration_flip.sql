-- The properties-as-blocks flip becomes owner-triggerable (issue #671).
--
-- PR #386's trigger made every transition service-role-only, and said why:
-- "the runbook is the gate (no attestation RPC; encoding the checklist in an
-- RPC is armor for an operator this fleet doesn't have)". That held while the
-- runbook was backfill-THEN-flip, where the flip is the last step and a human
-- at a SQL console is the natural place for it. Under flip-then-backfill the
-- flip is the FIRST step of an operator gesture that otherwise runs entirely
-- in the client, and a step needing service-role credentials cannot be part of
-- one.
--
-- WHAT RELAXES: the workspace OWNER may advance 'cell' -> 'children'.
--
-- WHAT DOES NOT:
--   * Every other transition stays service-role. 'children' -> 'cell-off' in
--     particular: it retires the cell as a synced fallback, which is only safe
--     once EVERY device has migrated — a fleet-wide fact no single client can
--     attest to.
--   * Forward-only, for everyone, service role included. Rolling back is still
--     a migration (drop this trigger, drain, delete children), not a column
--     write.
--   * E2EE workspaces are still refused outright. §8's option 2 needs two
--     client-side pieces because the server cannot read e2ee keys — the
--     one-time backfill and orphan-definition synthesis — and only the first
--     exists, so "option 2 is not built yet" remains the correct encoding.
--   * Members who are not the owner. RLS lets any workspace WRITER update this
--     table (workspaces_update -> is_workspace_writer), so the owner check has
--     to live here; flipping changes how the whole workspace stores properties,
--     for everyone in it. That check only means anything because the sibling
--     migration in this push makes owner_user_id immutable to clients — an
--     editor could otherwise PATCH themselves into the column it reads.

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

    -- Every raise here uses errcode 23514 (check_violation): a PERMANENT
    -- SQLSTATE, so a stale or buggy client PATCH lands in the upload-rejection
    -- quarantine instead of retrying forever. Same convention as
    -- workspaces_prevent_e2ee_field_change.
    if current_user not in ('postgres', 'service_role') then
        -- Load-bearing precondition: `owner_user_id` is immutable to clients
        -- (workspaces_prevent_owner_change, same push). Without it this check is
        -- decorative — RLS admits any workspace WRITER, so an editor would just
        -- PATCH the column this reads and then flip. auth.uid() is NULL outside a
        -- JWT session, and `is distinct from` makes that a refusal, not a match.
        if old.owner_user_id is distinct from auth.uid()::text then
            raise exception 'workspaces.properties_migration is writable by the workspace owner (% -> %)',
                old.properties_migration, new.properties_migration
                using errcode = 'check_violation';
        end if;
        if not (old.properties_migration = 'cell'
                and new.properties_migration = 'children') then
            raise exception 'a client may only advance workspaces.properties_migration from cell to children (% -> %)',
                old.properties_migration, new.properties_migration
                using errcode = 'check_violation';
        end if;
    end if;

    -- E2EE workspaces never flip (PR #288 §8): unchanged from PR #386, and
    -- deliberately NOT narrowed to the client path — the runbook gate alone is
    -- one fat-fingered service-role UPDATE away from a leak. encryption_mode is
    -- itself immutable (workspaces_prevent_e2ee_field_change), so this check is
    -- stable. If §8 option 2 ships, that migration replaces this trigger.
    if new.encryption_mode = 'e2ee' then
        raise exception 'e2ee workspaces stay at properties_migration = cell (PR #288 §8)'
            using errcode = 'check_violation';
    end if;

    old_rank := case old.properties_migration
        when 'cell' then 0 when 'children' then 1 when 'cell-off' then 2 end;
    new_rank := case new.properties_migration
        when 'cell' then 0 when 'children' then 1 when 'cell-off' then 2 end;
    -- Forward-only by trigger. Rolling BACK a workspace is a migration, not a
    -- column write (drain + delete children, PR #288 §11 slice B rollback); the
    -- operator runbook drops this trigger for the duration if that day comes —
    -- a silent backward flip would strand recognized field rows.
    if new_rank < old_rank then
        raise exception 'workspaces.properties_migration transitions are forward-only (% -> %)',
            old.properties_migration, new.properties_migration
            using errcode = 'check_violation';
    end if;

    return new;
end;
$$;
