-- Add an explicit `deleted` flag to blocks. Block.delete() previously soft-
-- deleted by removing the id from the parent's child_ids_json without touching
-- the block row, leaving the row in storage indistinguishable (at the row
-- level) from a live block. Workspace-wide queries that bypass the tree
-- (e.g. SELECT_BLOCKS_BY_TYPE_SQL, used by dynamicExtensionsExtension) had no
-- way to filter those orphans, so deleted extension blocks kept loading and
-- registering duplicate facets/shortcuts after every reload.
--
-- The flag is what queries should filter on; the parent's child_ids_json
-- removal stays in place so the block-tree renderer doesn't need to change.
-- Eventual cleanup (hard-delete after some grace period) is a follow-up.
--
-- Partial index: nearly every reader wants live blocks only, and live blocks
-- are the bulk of the table; a partial WHERE NOT deleted index keeps
-- workspace scans fast without bloating from tombstones.

begin;

alter table public.blocks
  add column if not exists deleted boolean not null default false;

create index if not exists idx_blocks_workspace_active
  on public.blocks(workspace_id) where not deleted;

commit;
