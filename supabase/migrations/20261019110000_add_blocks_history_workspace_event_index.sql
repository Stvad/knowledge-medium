-- The e2ee conversion's recovery-bundle export and re-seal verify page a
-- workspace's history by event_id, and its purge deletes by workspace_id
-- (20261019120000_add_workspace_e2ee_conversion.sql).
--
-- Its own migration, so the build's SHARE lock on blocks_history, which every
-- block write needs to insert history, is held for the build alone. To avoid
-- even that on a large table, build it beforehand with
--   create index concurrently if not exists idx_blocks_history_ws_event
--       on public.blocks_history (workspace_id, event_id);
-- and this statement is a no-op.
create index if not exists idx_blocks_history_ws_event
    on public.blocks_history (workspace_id, event_id);
