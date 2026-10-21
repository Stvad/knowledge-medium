-- The conversion's pages of a workspace's history (docs/workspace-e2ee-conversion.md
-- §6.3 steps 0 and 3): its blocks_history rows after one event and up to
-- another, in event order.
--
-- enable_sort = off leaves the planner only the ordered index scans, which stop
-- at the page's limit. A plan that reads the workspace's rows and sorts them
-- costs every remaining row on every page, so a large history would page past
-- the statement timeout; which plan wins otherwise depends on the statistics.
-- The owner check runs once, where the membership policy would run per row.
--
-- Owner-only, like the conversion RPCs it serves. Refusals are KMC01.

create function public.conversion_history_page(
        p_workspace_id text,
        p_after_event_id bigint,
        p_through_event_id bigint,
        p_limit integer
    )
    returns setof public.blocks_history
    language plpgsql
    security definer
    stable
    set search_path = ''
    set enable_sort = off
    as $$
begin
    if not private.is_workspace_owner(p_workspace_id, auth.uid()::text) then
        perform private.refuse_conversion(
            'conversion_history_page: only the workspace owner can read its history');
    end if;

    return query
        select h.*
        from public.blocks_history h
        where h.workspace_id = p_workspace_id
          and h.event_id > p_after_event_id
          and h.event_id <= p_through_event_id
        order by h.event_id
        limit p_limit;
end;
$$;

alter function public.conversion_history_page(text, bigint, bigint, integer) owner to postgres;
revoke all on function public.conversion_history_page(text, bigint, bigint, integer) from public, anon, service_role;
grant execute on function public.conversion_history_page(text, bigint, bigint, integer) to authenticated;
