-- Batches per-row PATCH updates into a single RPC call so the uploader
-- ships N narrow UPDATEs as one HTTP round trip. Each element of `patches`
-- writes its specified columns to the row with the matching id. Semantics
-- are column-LWW per row — identical to what PostgREST `.update()` already
-- gives the client today, just packed into one transport hop.
--
-- Per-key `properties_json` merge is intentionally out of scope here (see
-- the separate plan in #51). The `blocks_clamp_updated_at` BEFORE trigger
-- still fires on every UPDATE, so wall-clock clamping is preserved without
-- any work in this function.
--
-- Atomicity: if any patch targets a row that doesn't exist (or is
-- RLS-hidden), `RAISE EXCEPTION` aborts the function's implicit
-- transaction so none of the sibling UPDATEs commit. Without that, the
-- client wrapper would observe a `missing` array, throw a permanent
-- error, and the orchestrator would quarantine the tx — but the
-- already-committed sibling updates couldn't be undone. SQLSTATE
-- `P0002` (`no_data_found`) is the closest standard PL/pgSQL exception
-- for "the rows you asked for don't exist"; the client classifier
-- recognises it as permanent.

CREATE OR REPLACE FUNCTION public.apply_block_patches(patches jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  rec record;
  affected int;
  missing text[] := '{}';
  patch jsonb;
  patch_id text;
BEGIN
  FOR rec IN
    SELECT value, ordinality
    FROM jsonb_array_elements(patches) WITH ORDINALITY
    ORDER BY ordinality
  LOOP
    patch := rec.value;
    patch_id := patch->>'id';

    UPDATE blocks SET
      workspace_id    = COALESCE(patch->>'workspace_id', workspace_id),
      parent_id       = CASE WHEN patch ? 'parent_id' THEN patch->>'parent_id' ELSE parent_id END,
      order_key       = COALESCE(patch->>'order_key', order_key),
      content         = COALESCE(patch->>'content', content),
      properties_json = COALESCE(patch->>'properties_json', properties_json),
      references_json = COALESCE(patch->>'references_json', references_json),
      created_at      = COALESCE((patch->>'created_at')::bigint, created_at),
      updated_at      = COALESCE((patch->>'updated_at')::bigint, updated_at),
      created_by      = COALESCE(patch->>'created_by', created_by),
      updated_by      = COALESCE(patch->>'updated_by', updated_by),
      deleted         = COALESCE((patch->>'deleted')::boolean, deleted)
    WHERE id = patch_id;

    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected = 0 THEN
      missing := array_append(missing, patch_id);
    END IF;
  END LOOP;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'apply_block_patches: missing block ids: %', array_to_string(missing, ',')
      USING ERRCODE = 'P0002';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_block_patches(jsonb) TO authenticated;
