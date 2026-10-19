-- In-place plaintext -> E2EE conversion, server half (issue #1294).
-- Design: docs/workspace-e2ee-conversion.md §5 and §6.1.
--
-- The conversion relaxes "the encryption mode is immutable" by exactly one
-- transition, none -> e2ee, and walks a per-workspace phase forward through
-- three owner-only RPCs, each in its own transaction:
--
--   convert_workspace_to_e2ee   mode none -> e2ee, canary set, phase -> sealing
--   purge_workspace_history     phase sealing -> cleaning, history deleted
--   finish_conversion           phase cleaning -> NULL
--
-- Every refusal from the three RPCs raises SQLSTATE KMC01, so the client can
-- tell "the server said no" from a transport error. The flip's lock timeout
-- keeps its own SQLSTATE, 55P03: it means "retry", not "no".

begin;

-- ── conversion_phase ────────────────────────────────────────────────────
-- 'sealing': the server may still hold plaintext; no device may unlock.
-- 'cleaning': only attachment cleanup is left. NULL: no conversion running.
-- Members read it over PostgREST (workspaces_read already covers every
-- column). It is deliberately absent from the PowerSync sync config.
alter table public.workspaces
    add column conversion_phase text
        constraint workspaces_conversion_phase_valid
        check (
            conversion_phase is null
            or (conversion_phase in ('sealing', 'cleaning') and encryption_mode = 'e2ee')
        );

-- ── the admit ───────────────────────────────────────────────────────────
-- encryption_mode, wk_canary and conversion_phase change only along the
-- three steps below, and only inside a conversion RPC. An RPC is recognized
-- by both halves of the admit: it runs as its owner (current_user =
-- 'postgres', which no PostgREST role is) AND it has named this workspace in
-- the transaction-local km.conversion, which only those RPCs set
-- (PostgREST callers cannot call set_config). Anything else, service role
-- included, is refused.
--
-- e2ee -> none, and any canary change on an e2ee row, stay refused for
-- everyone.
create or replace function public.workspaces_prevent_e2ee_field_change()
    returns trigger
    language plpgsql
    set search_path = ''
    as $$
declare
    v_step text;
begin
    if old.encryption_mode is not distinct from new.encryption_mode
       and old.wk_canary is not distinct from new.wk_canary
       and old.conversion_phase is not distinct from new.conversion_phase then
        return new;
    end if;

    -- The steps as phase transitions. workspaces_conversion_phase_valid and
    -- workspaces_wk_canary_matches_mode settle the rest: a phase means e2ee
    -- with a well-formed canary, and e2ee with an unchanged canary cannot
    -- become none.
    v_step := case
        when old.encryption_mode = 'none' and new.conversion_phase = 'sealing'
            then 'flip'
        when old.conversion_phase = 'sealing' and new.conversion_phase = 'cleaning'
             and old.wk_canary is not distinct from new.wk_canary
            then 'purge'
        when old.conversion_phase = 'cleaning' and new.conversion_phase is null
             and old.wk_canary is not distinct from new.wk_canary
            then 'finish'
    end;

    if v_step is not null
       and current_user = 'postgres'
       and current_setting('km.conversion', true) = old.id then
        -- The admit is single-use: consumed by the row it admits, so no later
        -- statement in the transaction inherits it.
        perform set_config('km.conversion', '', true);
        return new;
    end if;

    -- 23514 (check_violation) is PERMANENT for the upload classifier, so a
    -- stale or buggy client PATCH of these columns is quarantined, not
    -- retried forever.
    raise exception 'workspaces.encryption_mode, wk_canary and conversion_phase change only through the conversion RPCs (mode % -> %, phase % -> %)',
        old.encryption_mode, new.encryption_mode,
        coalesce(old.conversion_phase, 'null'), coalesce(new.conversion_phase, 'null')
        using errcode = 'check_violation';
end;
$$;

-- ── a sealed block row ──────────────────────────────────────────────────
-- The one owner of "fully sealed": every content column is an enc:v1:
-- envelope. The ciphertext trigger refuses any other row in an e2ee
-- workspace, and the purge refuses while any row of the workspace is not
-- sealed. In public, beside is_enc_v1_envelope: the trigger runs as whoever
-- writes the block.
create function public.is_sealed_block(p_content text, p_properties_json text, p_references_json text)
    returns boolean
    language sql
    immutable
    set search_path = ''
    as $$
    select public.is_enc_v1_envelope(p_content)
       and public.is_enc_v1_envelope(p_properties_json)
       and public.is_enc_v1_envelope(p_references_json)
$$;

alter function public.is_sealed_block(text, text, text) owner to postgres;

create or replace function public.blocks_require_ciphertext_for_e2ee()
    returns trigger
    language plpgsql
    set search_path = ''
    as $$
begin
    if exists (
        select 1 from public.workspaces w
        where w.id = new.workspace_id and w.encryption_mode = 'e2ee'
    ) and not public.is_sealed_block(new.content, new.properties_json, new.references_json) then
        -- 23514 is PERMANENT for the upload classifier: the offending write
        -- is quarantined instead of jamming the queue.
        raise exception 'blocks in an e2ee workspace must carry a well-formed enc:v1: envelope in all content columns'
            using errcode = 'check_violation';
    end if;
    return new;
end;
$$;

-- ── refusals ────────────────────────────────────────────────────────────
-- The one owner of the conversion RPCs' refusal SQLSTATE. PostgREST maps an
-- unknown SQLSTATE to HTTP 400 and returns the code in the body.
create function private.refuse_conversion(p_message text)
    returns void
    language plpgsql
    set search_path = ''
    as $$
begin
    raise exception '%', p_message using errcode = 'KMC01';
end;
$$;

alter function private.refuse_conversion(text) owner to postgres;
revoke all on function private.refuse_conversion(text) from public, anon, authenticated, service_role;

-- ── the flip ────────────────────────────────────────────────────────────
-- LOCK TABLE blocks IN SHARE MODE conflicts with every block write's ROW
-- EXCLUSIVE lock. It waits for every in-flight write to commit, so each is
-- in blocks and in blocks_history before the mode changes, and it holds new
-- writes back until this transaction commits, so each of those sees e2ee in
-- blocks_require_ciphertext_for_e2ee, which reads the mode without a lock.
--
-- While the LOCK waits, every block write in the database queues behind it,
-- so the wait is capped by a short lock_timeout, and every refusal that does
-- not need the lock is decided before it.
create function public.convert_workspace_to_e2ee(p_workspace_id text, p_wk_canary text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    set lock_timeout = '2s'
    as $$
begin
    if not private.is_workspace_owner(p_workspace_id, auth.uid()::text) then
        perform private.refuse_conversion(
            'convert_workspace_to_e2ee: only the workspace owner can convert it');
    end if;
    if not coalesce(public.is_enc_v1_envelope(p_wk_canary), false) then
        perform private.refuse_conversion(
            'convert_workspace_to_e2ee: the canary is not an enc:v1: envelope');
    end if;
    if not exists (
        select 1 from public.workspaces
        where id = p_workspace_id and encryption_mode = 'none'
    ) then
        perform private.refuse_conversion(
            'convert_workspace_to_e2ee: the workspace is not plaintext');
    end if;

    begin
        lock table public.blocks in share mode;
    exception when lock_not_available then
        raise exception 'convert_workspace_to_e2ee: block writes are still in flight; retry'
            using errcode = 'lock_not_available';
    end;

    perform set_config('km.conversion', p_workspace_id, true);
    -- The mode is re-read under the row lock this UPDATE takes: a concurrent
    -- flip that won the race leaves nothing to match.
    update public.workspaces
        set encryption_mode = 'e2ee',
            wk_canary = p_wk_canary,
            conversion_phase = 'sealing'
        where id = p_workspace_id and encryption_mode = 'none';
    if not found then
        perform private.refuse_conversion(
            'convert_workspace_to_e2ee: the workspace is not plaintext');
    end if;
end;
$$;

alter function public.convert_workspace_to_e2ee(text, text) owner to postgres;
revoke all on function public.convert_workspace_to_e2ee(text, text) from public, anon, service_role;
grant execute on function public.convert_workspace_to_e2ee(text, text) to authenticated;

-- ── the purge ───────────────────────────────────────────────────────────
-- A history row is a re-seal write iff it is an UPDATE that touched nothing
-- but the content columns and the version, and wrote an envelope into each
-- content column it touched. The op needs no test of its own: I and D rows
-- carry no changed_columns, and the coalesce makes that NULL a refusal.
create function private.is_reseal_history_row(p_changed_columns text[], p_after_diff jsonb)
    returns boolean
    language sql
    immutable
    set search_path = ''
    as $$
    select coalesce(
        p_changed_columns <@ array['content', 'properties_json', 'references_json', 'updated_at']
        and (not (p_after_diff ? 'content')
             or public.is_enc_v1_envelope(p_after_diff ->> 'content'))
        and (not (p_after_diff ? 'properties_json')
             or public.is_enc_v1_envelope(p_after_diff ->> 'properties_json'))
        and (not (p_after_diff ? 'references_json')
             or public.is_enc_v1_envelope(p_after_diff ->> 'references_json')),
        false)
$$;

alter function private.is_reseal_history_row(text[], jsonb) owner to postgres;
revoke all on function private.is_reseal_history_row(text[], jsonb) from public, anon, authenticated, service_role;

-- p_through_event_id and p_archived_count come from the client's verified
-- recovery bundle: the last history event it archived (0 for an empty
-- history) and how many rows it archived up to there.
--
-- The count and re-seal checks run over the rows the DELETE removes, in the
-- same statement, so the set checked is exactly the set deleted. A history
-- row that commits after that statement's snapshot is not deleted, and holds
-- no plaintext: the sealed-blocks check before it saw every row of the
-- workspace sealed, and the ciphertext trigger keeps them so.
--
-- statement_timeout reaches an RPC call only because PostgREST hoists it
-- from the function's settings into the transaction (db-hoisted-tx-settings).
-- In a plain SQL session the session's timeout, already running, wins.
create function public.purge_workspace_history(
        p_workspace_id text,
        p_through_event_id bigint,
        p_archived_count bigint
    )
    returns void
    language plpgsql
    security definer
    set search_path = ''
    set statement_timeout = '5min'
    as $$
declare
    v_phase text;
    v_archived bigint;
    v_foreign bigint;
begin
    if not private.is_workspace_owner(p_workspace_id, auth.uid()::text) then
        perform private.refuse_conversion(
            'purge_workspace_history: only the workspace owner can purge its history');
    end if;

    select conversion_phase into v_phase
        from public.workspaces
        where id = p_workspace_id
        for no key update;
    if v_phase is distinct from 'sealing' then
        perform private.refuse_conversion(format(
            'purge_workspace_history: the conversion phase is %s, not sealing',
            coalesce(v_phase, 'null')));
    end if;
    if p_through_event_id is null then
        perform private.refuse_conversion(
            'purge_workspace_history: through_event_id is required (an empty history archives through 0)');
    end if;

    if exists (
        select 1 from public.blocks b
        where b.workspace_id = p_workspace_id
          and not public.is_sealed_block(b.content, b.properties_json, b.references_json)
    ) then
        perform private.refuse_conversion(
            'purge_workspace_history: a block row of the workspace is not fully sealed');
    end if;

    with deleted as (
        delete from public.blocks_history h
            where h.workspace_id = p_workspace_id
            returning h.event_id, h.changed_columns, h.after_diff
    )
    select count(*) filter (where event_id <= p_through_event_id),
           count(*) filter (where event_id > p_through_event_id
                              and not private.is_reseal_history_row(changed_columns, after_diff))
        into v_archived, v_foreign
        from deleted;

    if v_archived is distinct from p_archived_count then
        perform private.refuse_conversion(format(
            'purge_workspace_history: %s history row(s) up to event %s, but the bundle archived %s',
            v_archived, p_through_event_id, coalesce(p_archived_count::text, 'null')));
    end if;
    if v_foreign > 0 then
        perform private.refuse_conversion(format(
            'purge_workspace_history: %s history row(s) after event %s are not re-seal writes',
            v_foreign, p_through_event_id));
    end if;

    perform set_config('km.conversion', p_workspace_id, true);
    update public.workspaces
        set conversion_phase = 'cleaning'
        where id = p_workspace_id;
end;
$$;

alter function public.purge_workspace_history(text, bigint, bigint) owner to postgres;
revoke all on function public.purge_workspace_history(text, bigint, bigint) from public, anon, service_role;
grant execute on function public.purge_workspace_history(text, bigint, bigint) to authenticated;

-- ── the finish ──────────────────────────────────────────────────────────
-- The client calls this only after its attachment proof passes; the server
-- cannot check that proof.
create function public.finish_conversion(p_workspace_id text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $$
declare
    v_phase text;
begin
    if not private.is_workspace_owner(p_workspace_id, auth.uid()::text) then
        perform private.refuse_conversion(
            'finish_conversion: only the workspace owner can finish its conversion');
    end if;

    select conversion_phase into v_phase
        from public.workspaces
        where id = p_workspace_id
        for no key update;
    if v_phase is distinct from 'cleaning' then
        perform private.refuse_conversion(format(
            'finish_conversion: the conversion phase is %s, not cleaning',
            coalesce(v_phase, 'null')));
    end if;

    perform set_config('km.conversion', p_workspace_id, true);
    update public.workspaces
        set conversion_phase = null
        where id = p_workspace_id;
end;
$$;

alter function public.finish_conversion(text) owner to postgres;
revoke all on function public.finish_conversion(text) from public, anon, service_role;
grant execute on function public.finish_conversion(text) to authenticated;

-- ── export index ────────────────────────────────────────────────────────
-- The recovery-bundle export and the re-seal verify page a workspace's
-- history by event_id; the purge deletes by workspace_id.
create index if not exists idx_blocks_history_ws_event
    on public.blocks_history (workspace_id, event_id);

-- ── attachments bucket ──────────────────────────────────────────────────
-- A plaintext capture may be exactly 50 MiB (DEFAULT_MAX_CAPTURE_BYTES), and
-- sealing it adds BINARY_ENVELOPE_OVERHEAD_BYTES (36), rounded up to 64.
-- Guarded like 20260625000000_add_attachments_storage.sql: on a local
-- `supabase start` the Storage tables do not exist yet at migration time.
do $$
begin
    if to_regclass('storage.buckets') is null then
        raise notice 'attachments: storage schema not initialised yet; skipping the bucket limit raise';
        return;
    end if;

    update storage.buckets
        set file_size_limit = 50 * 1024 * 1024 + 64
        where id = 'attachments';
end $$;

commit;
