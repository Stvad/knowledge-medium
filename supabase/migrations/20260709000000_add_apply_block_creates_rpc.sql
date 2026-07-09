-- Non-silent insert-or-skip for client-originated CREATEs (issue #336 / #244).
--
-- THE BUG this fixes: a deterministic-id CREATE (matrix-message ingest, daily
-- notes, prefs/ui-state bootstrap) can collide with a row the server already
-- has. The old upload path shipped these as PostgREST
-- `.upsert(..., {onConflict:'id', ignoreDuplicates:true})` = `ON CONFLICT (id)
-- DO NOTHING`. That preserves the server's authoritative row (correct — we must
-- NOT clobber it), but it writes NO heap tuple, so Postgres emits no WAL change,
-- PowerSync replicates nothing, and the client that raced the create is never
-- sent an echo. Its local `blocks` row sits ahead of an unchanged `blocks_synced`
-- forever — the "insert-or-skip phantom" (#244: matrix messages diverge across
-- clients). The whole client-side self-heal apparatus existed only to synthesize
-- that missing echo.
--
-- THE FIX: make the skip non-silent. On conflict, TOUCH the existing row instead
-- of doing nothing — `DO UPDATE SET updated_at = blocks.updated_at`. This changes
-- NO data (it re-assigns a column to its own value; see "why safe" below), but it
-- writes a new heap tuple → WAL → logical replication → PowerSync re-sends the
-- authoritative row down to every client, INCLUDING the one that raced. The
-- observer reconciles the phantom against it via the normal sync path. No outbox,
-- no synthetic echo, no triggers.
--
-- WHY THE TOUCH IS SAFE (no clobber, no version churn, no history spam):
--   * Only `updated_at` is in the SET, and it's set to `blocks.updated_at` (the
--     existing value) — the client's proposed content/metadata is DISCARDED on
--     conflict, exactly as `DO NOTHING` discarded it. The server row is preserved.
--   * `blocks_clamp_updated_at` (BEFORE UPDATE): no content column changed, so the
--     content-change `+1` bump is skipped and the monotonic floor is
--     `greatest(OLD.updated_at, OLD.updated_at)` = OLD — `updated_at` is unchanged.
--     The echo therefore carries the server's existing row-version; the reconcile
--     gate applies it server-over-local regardless of stamp direction (a phantom's
--     local stamp is not equal to it, so it is not skip-staled).
--   * `blocks_prevent_workspace_change` (BEFORE UPDATE): the touch never changes
--     `workspace_id`, so it passes.
--   * `blocks_record_history_trg` (AFTER UPDATE): its identical-row guard
--     (`changed_columns IS NULL`) fires, so a touch records NO history row.
--
-- RLS: `SECURITY INVOKER`, so the caller's policies apply. `blocks_write` is
-- `FOR ALL` gated on `is_workspace_writer(workspace_id)` for BOTH `USING` and
-- `WITH CHECK`, so a caller who may INSERT a row into a workspace may also touch
-- it on conflict — there is no INSERT-allowed-but-UPDATE-denied asymmetry. A
-- deterministic-id collision against a row the caller cannot write (a foreign
-- workspace) is denied, exactly as a plain INSERT there would be.
--
-- ORDERING: the `blocks_workspace_id_parent_id_fkey` self-FK is DEFERRABLE
-- INITIALLY DEFERRED, so parent-before-child ordering inside this function's
-- implicit transaction is not required (checked at function commit). The client
-- still chunks in topological order so a child never lands in an earlier chunk
-- (separate RPC = separate transaction) than its parent.
--
-- Per-row loop (mirrors apply_block_patches) rather than one INSERT ... SELECT:
-- robust to a duplicate id in the array (a single-statement multi-row upsert
-- raises 21000 "cannot affect row a second time"), and the per-write triggers
-- fire identically either way.

CREATE OR REPLACE FUNCTION public.apply_block_creates(creates jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  rec record;
  c jsonb;
BEGIN
  FOR rec IN
    SELECT value, ordinality
    FROM jsonb_array_elements(creates) WITH ORDINALITY
    ORDER BY ordinality
  LOOP
    c := rec.value;

    INSERT INTO blocks (
      id, workspace_id, parent_id, order_key, content,
      properties_json, references_json, created_at, updated_at,
      user_updated_at, created_by, updated_by, deleted
    ) VALUES (
      c->>'id',
      c->>'workspace_id',
      c->>'parent_id',
      c->>'order_key',
      c->>'content',
      c->>'properties_json',
      c->>'references_json',
      (c->>'created_at')::bigint,
      (c->>'updated_at')::bigint,
      (c->>'user_updated_at')::bigint,
      c->>'created_by',
      c->>'updated_by',
      COALESCE((c->>'deleted')::boolean, false)
    )
    -- Insert-or-TOUCH: preserve the server row, but emit a WAL change so the
    -- racing client gets an echo. See the header for why this is a no-op write.
    ON CONFLICT (id) DO UPDATE SET updated_at = blocks.updated_at;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_block_creates(jsonb) TO authenticated;
