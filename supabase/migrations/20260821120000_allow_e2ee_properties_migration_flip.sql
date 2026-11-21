-- E2EE workspaces may flip to child-backed properties (issue #690).
--
-- WHY THE REFUSAL EXISTED, and why it can go: block ids sync in the CLEAR, and a
-- synthesized property definition's id was a uuidv5 of the property NAME under a
-- namespace constant in the public client repo — so the server could hash a
-- guessed name and probe for the row. An encrypted workspace now derives that
-- namespace from `K_id`, a per-workspace HMAC subkey only its own devices hold,
-- and the id is no longer a value the server can recompute. That was the whole
-- objection; nothing else about an e2ee flip was ever in question.
--
-- WHAT RELAXES: `encryption_mode = 'e2ee'` is no longer, by itself, a reason to
-- refuse a `properties_migration` transition.
--
-- WHAT DOES NOT: nothing else. E2EE workspaces get exactly the rules a
-- plaintext one gets, and this function is otherwise byte-identical to its
-- predecessor —
--   * clients may only advance 'cell' -> 'children', and only the OWNER may;
--   * 'children' -> 'cell-off' stays service-role, because retiring the cell is
--     only safe once EVERY device has migrated — a fleet-wide fact no single
--     client can attest to, and encryption changes nothing about that;
--   * forward-only for everyone, service role included.
--
-- WHAT THIS TRIGGER NEVER CHECKED, and still doesn't: whether the workspace's
-- orphan keys actually have definitions. The server cannot read an e2ee
-- workspace's property names, so it could not check even in principle. That
-- gate is `flipBlockedBySynthesis` on the client, ahead of the PATCH — same
-- place it already was for plaintext workspaces, which the server equally never
-- checked.

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
        -- (workspaces_prevent_owner_change). Without it this check is
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
