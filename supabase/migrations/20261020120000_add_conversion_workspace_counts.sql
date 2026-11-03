-- The conversion flow's counts (docs/workspace-e2ee-conversion.md §6.3 steps
-- 3–5): how many block rows and history rows a workspace holds, and its last
-- history event, read in ONE statement, so all three come from one snapshot.
--
-- Counted through PostgREST the same numbers cost a row-level policy check per
-- row (`private.is_workspace_member` cannot be inlined), which runs past the
-- `authenticated` statement timeout at a few hundred thousand rows. Here the
-- owner check runs once and the counts are index-only scans, under the purge's
-- raised timeout.
--
-- Owner-only, like the conversion RPCs it serves. Refusals are KMC01.

create function public.conversion_workspace_counts(p_workspace_id text)
    returns table (block_count bigint, history_count bigint, max_event_id bigint)
    language plpgsql
    security definer
    stable
    set search_path = ''
    set statement_timeout = '5min'
    as $$
begin
    if not private.is_workspace_owner(p_workspace_id, auth.uid()::text) then
        perform private.refuse_conversion(
            'conversion_workspace_counts: only the workspace owner can count it');
    end if;

    return query
        select
            (select count(*) from public.blocks b where b.workspace_id = p_workspace_id),
            (select count(*) from public.blocks_history h where h.workspace_id = p_workspace_id),
            (select coalesce(max(h.event_id), 0) from public.blocks_history h where h.workspace_id = p_workspace_id);
end;
$$;

alter function public.conversion_workspace_counts(text) owner to postgres;
revoke all on function public.conversion_workspace_counts(text) from public, anon, service_role;
grant execute on function public.conversion_workspace_counts(text) to authenticated;
