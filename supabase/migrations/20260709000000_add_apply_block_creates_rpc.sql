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
--   * `blocks_record_history_trg` (AFTER UPDATE): when the touch is a true no-op
--     (NEW == OLD for every column) its identical-row guard (`changed_columns IS
--     NULL`) fires, so it records NO history row.
--
--   TWO NARROW CAVEATS to "true no-op" (both leave the touch SAFE — no clobber —
--   but would make it a real 1-row write + a stray history row):
--     - Unlike `updated_at`, `created_at` and `user_updated_at` have NO restoring
--       floor in the clamp — only a future-clamp. So a BACKWARD server-clock step
--       between the row's last write and this touch would shave them down. This
--       needs actual server-clock non-monotonicity (an infra anomaly, not anything
--       a client can trigger), so it's a documented tail, not an operational risk.
--     - The no-op assumes `user_updated_at` is already populated; the clamp does
--       `least(coalesce(NEW.user_updated_at, NEW.updated_at), now)`, so a row still
--       carrying NULL here would get it set (a one-time real change). The
--       20260612000000 backfill populated every existing row, and every write
--       since sets it, so no live row should be NULL — but it's why the pgTAP test
--       seeds `user_updated_at`.
--
-- RLS: `SECURITY INVOKER`, so the caller's policies apply. `blocks_write` is
-- `FOR ALL` gated on `is_workspace_writer(workspace_id)` for BOTH `USING` and
-- `WITH CHECK`. For a SAME-workspace collision (the only reachable case — every
-- deterministic id is uuidv5-hashed WITH its workspace_id, so a real collision is
-- always within one workspace) INSERT and the ON-CONFLICT UPDATE resolve to the
-- SAME `is_workspace_writer` check on the SAME value: no asymmetry. (A purely
-- hypothetical CROSS-workspace id collision — the PK is on `id` alone — where the
-- caller can write their workspace but not the existing row's would THROW on the
-- UPDATE's USING check, where `DO NOTHING` silently no-op'd; it degrades safely to
-- a permanent quarantine (42501), and is unreachable via any current id scheme.)
--
-- DELIVERY ORDERING: the touch's echo carries a FLAT (non-advancing) `updated_at`,
-- so it is the first echo type that doesn't self-order by stamp. Its safety (a
-- stale touch echo can't leapfrog a later real edit) rests on `blocks_synced`
-- being ONE ordered bucket per workspace (sync-config.yaml), so PowerSync delivers
-- a row's changes to every client in commit order. If that ever fragments across
-- buckets, re-examine this + the reconcile gate's stamp-monotonicity assumption.
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
    -- Deliberately a no-op, NOT `updated_at = <new>`: advancing the stamp would
    -- force every id collision (the common fresh-client bootstrap) to
    -- re-materialize on every device and would break the reconcile gate's
    -- "newer stamp <=> changed content" coupling. The residual equal-ms
    -- collision gap that leaves — and why the fix is systemMint, not a stamp
    -- bump here — is documented at the I1 gate in
    -- src/data/internals/syncObserver/reconcile.ts.
    ON CONFLICT (id) DO UPDATE SET updated_at = blocks.updated_at;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_block_creates(jsonb) TO authenticated;
