-- Hydration staleness fix: split `blocks.updated_at` into a pure row-version
-- (`updated_at`, advances on every content-changing write, server-enforced
-- monotonic) and a user-facing "last edited" timestamp (`user_updated_at`).
-- See docs/hydration-staleness-fix-handoff.md.
--
-- Why server-side: `apply_block_patches` straight-assigns `updated_at`
-- (column-LWW), and the existing clamp only ratchets *future* stamps DOWN.
-- A slow-clock client or a `{skipMetadata}` write can therefore freeze or
-- regress the row-version while content changes — which the peer reconcile
-- gate reads as "not newer" and silently drops. The unconditional floor
-- below makes the row-version monotonic regardless of client clock skew,
-- same-ms collisions, or skipMetadata freezes.

-- 1. New column. NULLABLE on purpose: a NOT NULL would make old-client
--    CREATEs in the mixed-version window violate 23502, which the client
--    upload classifier treats as PERMANENT → the whole tx is quarantined
--    to `ps_crud_rejected` → silent data loss. Population is guaranteed
--    trigger-side (step 2) + a one-time backfill (step 4). Postgres can't
--    express `DEFAULT updated_at` (no cross-column defaults), hence the
--    trigger.
ALTER TABLE public.blocks
  ADD COLUMN IF NOT EXISTS user_updated_at bigint;

-- 2. Extend the clamp trigger: future-clamp (unchanged) → populate
--    `user_updated_at` for old-client / pre-split writes → (UPDATE only)
--    unconditional monotonic floor + content-change version bump.
CREATE OR REPLACE FUNCTION public.blocks_clamp_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  server_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  -- Future-clamp FIRST (both INSERT and UPDATE). Must precede the floor:
  -- flooring first then clamping would un-ratchet a stamp the server has
  -- legitimately pushed ahead of wall-clock under rapid writes.
  if NEW.updated_at > server_now_ms then
    NEW.updated_at := server_now_ms;
  end if;
  if NEW.created_at > server_now_ms then
    NEW.created_at := server_now_ms;
  end if;

  -- Populate AND future-clamp the user-facing stamp. Old clients (PUT/PATCH
  -- without the column) and pre-split rows fall back to NEW.updated_at (already
  -- clamped above). A present value from a fast-clock client is clamped to
  -- server-now so it can't pin a block at the top of recents or display a
  -- future "last edited" — matching the pre-split behavior, where display read
  -- the future-clamped updated_at. (user_updated_at is display-only — never a
  -- version — so clamping it down is always safe.)
  NEW.user_updated_at := least(coalesce(NEW.user_updated_at, NEW.updated_at), server_now_ms);

  if TG_OP = 'UPDATE' then
    -- Unconditional floor: the row-version can never regress, immune to
    -- client clock skew and to the RPC's straight assignment. This must be
    -- unconditional (not content-gated): a metadata-only PATCH from a
    -- slow-clock client would otherwise regress the stamp, and a later
    -- non-content write could un-ratchet a previously floored stamp —
    -- either breaks the "server row newer ⟺ content differs" invariant.
    NEW.updated_at := greatest(NEW.updated_at, OLD.updated_at);

    -- Content actually changed ⇒ the version is strictly newer. `+1`
    -- guarantees a peer sitting at OLD.updated_at sees a strictly-greater
    -- stamp even on same-ms / frozen-stamp writes. `user_updated_at`,
    -- `updated_by`, `created_*` are deliberately NOT in this test —
    -- metadata must not self-trigger a version bump.
    if (NEW.parent_id       is distinct from OLD.parent_id
        or NEW.order_key       is distinct from OLD.order_key
        or NEW.content         is distinct from OLD.content
        or NEW.properties_json is distinct from OLD.properties_json
        or NEW.references_json is distinct from OLD.references_json
        or NEW.deleted         is distinct from OLD.deleted) then
      NEW.updated_at := greatest(NEW.updated_at, OLD.updated_at + 1);
    end if;
  end if;

  return NEW;
end $$;

-- 3. Carry `user_updated_at` through the batched PATCH RPC. The RPC's UPDATE
--    is a closed column list — unknown patch keys are silently ignored, so
--    without this every new-client PATCH would DROP the column and the
--    user-facing half of the split would ship permanently frozen.
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
      user_updated_at = COALESCE((patch->>'user_updated_at')::bigint, user_updated_at),
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

-- 4. Backfill existing rows. Disable ONLY the history trigger around it —
--    `session_replication_role = replica` would also disable the clamp and
--    e2ee-validation triggers. Without this, one history row per block would
--    be written (the no-op-skip doesn't apply: the column genuinely changed).
--    The clamp trigger stays enabled and is a no-op here: `user_updated_at`
--    is excluded from the content-change test, so `updated_at` is not bumped.
ALTER TABLE public.blocks DISABLE TRIGGER blocks_record_history_trg;
UPDATE public.blocks SET user_updated_at = updated_at WHERE user_updated_at IS NULL;
ALTER TABLE public.blocks ENABLE TRIGGER blocks_record_history_trg;

-- The one-time `system:` cleanup (zero pristine rows' updated_at, strip the
-- `system:` author prefix) deliberately does NOT run here. It must run in the
-- post-upgrade recovery phase, after the fleet is fully on the new bundle —
-- otherwise an old client minting a deterministic-id row after this runs but
-- before it upgrades writes a fresh nonzero `system:` row the new gate would
-- never heal. See docs/hydration-staleness-fix-handoff.md step 7.
