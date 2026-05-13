-- Electric read-path sync streams these tables through Shapes. `write_id`
-- is stamped by the local outbox upload loop and round-tripped through the
-- blocks shape so clients can skip their own pending echoes.
ALTER TABLE public.blocks
  ADD COLUMN IF NOT EXISTS write_id text;

-- Electric needs full old/new row data for robust update/delete delivery.
ALTER TABLE public.blocks REPLICA IDENTITY FULL;
ALTER TABLE public.workspaces REPLICA IDENTITY FULL;
ALTER TABLE public.workspace_members REPLICA IDENTITY FULL;
