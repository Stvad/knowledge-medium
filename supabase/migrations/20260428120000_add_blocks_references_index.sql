-- Backlink lookups ("Linked References" on a zoomed-in block) scan blocks
-- that actually carry outgoing references — most blocks have an empty
-- references_json, so the workspace-wide partial index already in place
-- (idx_blocks_workspace_active) over-fetches.
--
-- This partial index is keyed on workspace_id but only includes rows where
-- references_json is non-empty and the block isn't soft-deleted, mirroring
-- the same shape created locally in PowerSync (see repoInstance.ts).
-- SELECT_BACKLINKS_FOR_BLOCK_SQL filters on those exact predicates, so the
-- planner can use this index to narrow the scan to the link-bearing subset.

begin;

create index if not exists idx_blocks_workspace_with_references
  on public.blocks(workspace_id)
  where not deleted and references_json != '[]';

commit;
