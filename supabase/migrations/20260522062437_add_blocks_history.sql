-- blocks_history: server-side per-row change log for `public.blocks`.
-- Data substrate for a future point-in-time-recovery (PITR) feature
-- (separate follow-up will add read + restore RPCs).
--
-- Resolution is sync-checkpoint, not per-edit. Client-side
-- `compactBlockCrudEntries` (src/services/powersync.ts) merges per-id
-- uploads, so an offline client that edited a row 50 times sends ONE
-- merged PATCH to Supabase. Per-commit fidelity lives in the client-side
-- `row_events` log (src/data/internals/clientSchema.ts); this server-side
-- log is the canonical, device-loss-resistant complement.
--
-- This table is intentionally NOT exposed via PowerSync. `gen-sync-config.ts`
-- reads `blockSchema.ts` / `workspaceSchema.ts`, so as long as blocks_history
-- is absent from those (it is), it stays out of `powersync/sync-config.yaml`.
-- Clients will read history via RPC, not via sync streams — syncing every
-- history row to every client would balloon bucket sizes for no benefit.
--
-- Storage shape: "symmetric changed-columns diff" (Option B).
--   INSERT: before_diff = NULL,                       after_diff = full row
--   UPDATE: before_diff = {changed cols -> OLD vals}, after_diff = {changed cols -> NEW vals}
--   DELETE: before_diff = full row,                   after_diff = NULL
-- Bookend events (I, D) carry the full row so PITR can anchor on them
-- without walking history. Mid-stream U events carry only the diff, which
-- keeps the table compact when most updates touch one or two columns.

CREATE TABLE IF NOT EXISTS public.blocks_history (
  event_id        BIGSERIAL PRIMARY KEY,
  block_id        TEXT NOT NULL,
  workspace_id    TEXT NOT NULL,
  op              TEXT NOT NULL CHECK (op IN ('I', 'U', 'D')),
  -- Derived in the trigger:
  --   'create'       (I)
  --   'soft_delete'  (U, OLD.deleted=false -> NEW.deleted=true)
  --   'undelete'     (U, OLD.deleted=true  -> NEW.deleted=false)
  --   'update'       (U, anything else)
  --   'delete'       (D)
  semantic_op     TEXT NOT NULL CHECK (semantic_op IN ('create', 'update', 'soft_delete', 'undelete', 'delete')),
  -- NULL on I and D; populated on U.
  changed_columns TEXT[],
  -- TEXT, not UUID: `blocks.created_by` / `updated_by` are TEXT in this
  -- schema (UUID-shaped values stored as text via `auth.uid()::text`).
  -- Casting to UUID in the trigger would risk a write failure if a future
  -- row ever held a non-UUID identifier; matching the source column's
  -- type keeps the trigger total.
  actor           TEXT,
  event_time      TIMESTAMPTZ NOT NULL DEFAULT now(),
  before_diff     JSONB,
  after_diff      JSONB
);

ALTER TABLE public.blocks_history OWNER TO postgres;

CREATE INDEX IF NOT EXISTS idx_blocks_history_ws_time
  ON public.blocks_history (workspace_id, event_time DESC);

CREATE INDEX IF NOT EXISTS idx_blocks_history_block_time
  ON public.blocks_history (block_id, event_time DESC);

-- Per-column-touched queries ("when did `content` last change for this
-- block?") will use this. Cheap to maintain at our write rate.
CREATE INDEX IF NOT EXISTS idx_blocks_history_changed_columns
  ON public.blocks_history USING GIN (changed_columns);


-- SECURITY DEFINER: the trigger fires in the writer's session (typically
-- `authenticated` for PowerSync CRUD-apply). `authenticated` has no
-- INSERT privilege on blocks_history (intentionally — only the trigger
-- writes), so without DEFINER the INSERT here would fail under RLS.
-- search_path is pinned to '' so qualified names cannot be hijacked.
CREATE OR REPLACE FUNCTION public.blocks_record_history()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $$
DECLARE
  v_op             text;
  v_semantic_op    text;
  v_changed_cols   text[];
  v_before_diff    jsonb;
  v_after_diff     jsonb;
  v_actor          text;
  v_workspace_id   text;
  v_block_id       text;
  v_before_full    jsonb;
  v_after_full     jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_op           := 'I';
    v_semantic_op  := 'create';
    v_changed_cols := NULL;
    v_before_diff  := NULL;
    v_after_diff   := to_jsonb(NEW);
    v_actor        := NEW.created_by;
    v_workspace_id := NEW.workspace_id;
    v_block_id     := NEW.id;

  ELSIF TG_OP = 'UPDATE' THEN
    v_op           := 'U';
    v_actor        := NEW.updated_by;
    v_workspace_id := NEW.workspace_id;
    v_block_id     := NEW.id;

    IF OLD.deleted IS FALSE AND NEW.deleted IS TRUE THEN
      v_semantic_op := 'soft_delete';
    ELSIF OLD.deleted IS TRUE AND NEW.deleted IS FALSE THEN
      v_semantic_op := 'undelete';
    ELSE
      v_semantic_op := 'update';
    END IF;

    v_before_full := to_jsonb(OLD);
    v_after_full  := to_jsonb(NEW);

    SELECT array_agg(key ORDER BY key)
      INTO v_changed_cols
      FROM jsonb_object_keys(v_after_full) AS key
      WHERE v_before_full -> key IS DISTINCT FROM v_after_full -> key;

    -- Identical UPDATEs (PowerSync occasionally re-applies an unchanged
    -- row; the BEFORE clamp trigger can also leave OLD == NEW). Skip
    -- recording — history rows would be noise.
    IF v_changed_cols IS NULL OR array_length(v_changed_cols, 1) IS NULL THEN
      RETURN NULL;
    END IF;

    SELECT jsonb_object_agg(key, v_before_full -> key)
      INTO v_before_diff
      FROM unnest(v_changed_cols) AS key;
    SELECT jsonb_object_agg(key, v_after_full -> key)
      INTO v_after_diff
      FROM unnest(v_changed_cols) AS key;

  ELSIF TG_OP = 'DELETE' THEN
    v_op           := 'D';
    v_semantic_op  := 'delete';
    v_changed_cols := NULL;
    v_before_diff  := to_jsonb(OLD);
    v_after_diff   := NULL;
    -- No `deleted_by` column on blocks; soft-deletes go through UPDATE,
    -- where updated_by captures the actor. A hard DELETE has no recorded
    -- actor in the current schema.
    v_actor        := NULL;
    v_workspace_id := OLD.workspace_id;
    v_block_id     := OLD.id;
  END IF;

  INSERT INTO public.blocks_history (
    block_id, workspace_id, op, semantic_op, changed_columns,
    actor, before_diff, after_diff
  ) VALUES (
    v_block_id, v_workspace_id, v_op, v_semantic_op, v_changed_cols,
    v_actor, v_before_diff, v_after_diff
  );

  RETURN NULL;  -- AFTER trigger: return value is ignored.
END $$;

ALTER FUNCTION public.blocks_record_history() OWNER TO postgres;

-- The function is SECURITY DEFINER and only intended to fire via the
-- trigger. Revoke direct EXECUTE from PUBLIC so it cannot be invoked
-- standalone (e.g. via PostgREST RPC). Triggers fire as the function
-- owner regardless of caller EXECUTE grants.
REVOKE EXECUTE ON FUNCTION public.blocks_record_history() FROM PUBLIC;

DROP TRIGGER IF EXISTS blocks_record_history_trg ON public.blocks;
CREATE TRIGGER blocks_record_history_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.blocks
  FOR EACH ROW EXECUTE FUNCTION public.blocks_record_history();


-- RLS: mirrors `blocks_read`. A user can SELECT a history row iff they're
-- a member of the workspace it belongs to. No INSERT/UPDATE/DELETE
-- policies — only the trigger writes (which it does as the DEFINER owner,
-- bypassing RLS for the write).
ALTER TABLE public.blocks_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY blocks_history_read ON public.blocks_history
  FOR SELECT
  USING (private.is_workspace_member(workspace_id, (auth.uid())::text));


-- Grants: SELECT for authenticated/service_role (RLS still gates rows).
-- anon gets nothing — history is never anonymous, and the read path will
-- always be an authenticated RPC. No INSERT/UPDATE/DELETE grants;
-- writes go exclusively through the trigger.
GRANT SELECT ON TABLE public.blocks_history TO authenticated;
GRANT ALL    ON TABLE public.blocks_history TO service_role;

GRANT USAGE, SELECT ON SEQUENCE public.blocks_history_event_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.blocks_history_event_id_seq TO service_role;
