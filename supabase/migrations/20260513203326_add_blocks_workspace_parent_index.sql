CREATE INDEX IF NOT EXISTS idx_blocks_workspace_parent_all
ON public.blocks (workspace_id, parent_id);
