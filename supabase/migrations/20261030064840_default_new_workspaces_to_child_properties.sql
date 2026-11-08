-- Existing workspaces retain their stored migration state.
ALTER TABLE public.workspaces
  ALTER COLUMN properties_migration SET DEFAULT 'children';
