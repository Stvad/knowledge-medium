-- Issue #381: a merged echo could come back carrying the author's OWN
-- row-version, so the author's reconcile gate equal-stamp-skipped it and that
-- device permanently kept content that had been merged under someone else's
-- write.
--
-- Mechanism (pre-fix): `apply_block_patches` straight-assigns the client's
-- proposed `updated_at`, and the clamp trigger's content bump only guarantees
-- `> OLD.updated_at`. When the author's proposed stamp already exceeds
-- `OLD.updated_at + 1` — the common case for a genuinely-later concurrent edit
-- — `greatest()` returns the PROPOSED stamp unchanged, so the merged server row
-- (their content + the author's columns) lands at exactly the stamp the author
-- already holds locally. The echo is then indistinguishable from "my own write
-- came back" and is skipped (invariant I1 in
-- src/data/internals/syncObserver/reconcile.ts).
--
-- The fix is to stop inferring "does the author need this row?" from content
-- and start carrying the answer explicitly. The client stamps every PATCH with
-- `base_updated_at` — the row-version the edit was made against, captured from
-- `OLD.updated_at` inside the same local write tx (see `blockUploadPatchJsonSql`
-- in src/data/internals/clientSchema.ts). If that differs from the server's
-- current `updated_at`, the row drifted under the edit: the merged result is
-- content this author has never seen, so its version must clear the author's
-- own proposed stamp and force the echo to materialize.
--
-- Why the bump must NOT be content-gated (this is the part that was subtle):
-- comparing the merged row's content to OLD answers the wrong question. Two
-- devices that write the SAME value to a column — both soft-deleting the same
-- block, both re-setting a property — produce a merged row identical to OLD, so
-- a content-gated bump does not fire, the floor hands back the author's own
-- proposed stamp, and the author silently keeps whatever ELSE the other device
-- changed in the same burst (a rename that rode along with their delete). The
-- content test cannot see that, because equality with OLD says nothing about
-- equality with the AUTHOR'S row. Drift is the real signal; content is a proxy
-- that leaks. Same reason this also seals the metadata-only PATCH (a patch that
-- touches no content column at all, reachable via undo-to-identical-state):
-- drifted or not is decided without asking what changed.

-- 1. Carry the base version from the RPC to the trigger.
--
-- The clamp trigger is row-level: it sees NEW/OLD, not the patch JSON, and
-- `base_updated_at` is a wire-only key with no column to ride in on. A
-- transaction-local GUC is the standard Postgres channel for exactly this.
--
-- Three states:
--
--   NULL / ''   this UPDATE did not come from `apply_block_patches`. Keep the
--               pre-#381 behavior verbatim. The insert-or-TOUCH branch of
--               `apply_block_creates` (ON CONFLICT DO UPDATE SET updated_at =
--               blocks.updated_at) is exactly this case and MUST stay
--               stamp-preserving: bumping it would re-materialize every
--               deterministic-id collision on every device and re-open #244.
--               Backfills and admin fixes land here too.
--   '0'         a patch with no usable base — either an old client that does
--               not send one, or the pristine sentinel (see the trigger).
--               Unknown base ⇒ assume drift. Old clients pay one echo per edit
--               until they upgrade, and are CORRECT from the moment this
--               deploys.
--   a number    compare it to OLD.updated_at.
--
-- The RPC CLEARS the setting back to '' immediately after each UPDATE, so the
-- signal is scoped to exactly one statement. `is_local => true` would already
-- confine it to the transaction, but that is not enough on its own: a caller
-- that ever wraps `apply_block_patches` in a larger transaction (a server-side
-- batch, a migration, a psql session) would otherwise leave the last patch's
-- base visible to every following UPDATE in that transaction — including a
-- create-TOUCH, silently regressing #244. Verified by execution: without the
-- clear, a plain `UPDATE blocks SET updated_at = blocks.updated_at` issued
-- after a patch in the same transaction bumps the version.
CREATE OR REPLACE FUNCTION public.blocks_clamp_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  server_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  -- The client's proposed row-version, captured BEFORE the future-clamp below
  -- rewrites it. The drift bump has to clear the AUTHOR'S OWN local stamp, and
  -- that is this raw number — the client wrote it to its local row and sent the
  -- same value up. Bumping from the CLAMPED value instead would re-open #381 on
  -- a fast client: proposed 1053 clamped to server-now 1052, bumped to 1053,
  -- which is the author's local stamp again — equal stamps, echo skipped,
  -- exactly the bug this migration exists to fix.
  raw_proposed bigint := NEW.updated_at;
  base_setting text;
  base_version bigint;
  drifted boolean := false;
  content_changed boolean;
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
  -- future "last edited". (user_updated_at is display-only — never a version —
  -- so clamping it down is always safe.)
  NEW.user_updated_at := least(coalesce(NEW.user_updated_at, NEW.updated_at), server_now_ms);

  if TG_OP = 'UPDATE' then
    base_setting := current_setting('km.patch_base_updated_at', true);

    if coalesce(base_setting, '') <> '' then
      base_version := base_setting::bigint;
      -- `0` is the pristine sentinel: a speculative deterministic-id mint that
      -- every device stamps 0 independently (see `systemMint` in txEngine.ts and
      -- the I2 exemption in reconcile.ts), and also what the RPC substitutes for
      -- an absent base. Equality at 0 is therefore shared by CONSTRUCTION across
      -- unrelated write chains and carries no information about drift — so treat
      -- it as drifted rather than trusting it. This is the server-side dual of
      -- the gate's stamp-0 exemption.
      drifted := base_version = 0
                 or base_version is distinct from OLD.updated_at;
    end if;

    if drifted then
      -- Deliberate, BOUNDED exception to the future-clamp above. The result can
      -- exceed server-now by at most (the author's own clock skew + 1ms) — it
      -- is never further ahead than the stamp that client already minted on its
      -- own row, so this cannot pin a row's version arbitrarily far in the
      -- future the way an unclamped proposal could. `updated_at` is a pure
      -- row-version post-20260612 (display reads `user_updated_at`), so being
      -- ahead of wall-clock costs nothing; the floor already relies on that.
      -- OLD is inside the greatest(), so this subsumes the monotonic floor.
      NEW.updated_at := greatest(server_now_ms, OLD.updated_at, raw_proposed) + 1;
    else
      -- Un-drifted (or not a patch write): pre-#381 behavior, verbatim.
      --
      -- Unconditional floor: the row-version can never regress, immune to
      -- client clock skew and to the RPC's straight assignment. This must be
      -- unconditional (not content-gated): a metadata-only PATCH from a
      -- slow-clock client would otherwise regress the stamp, and a later
      -- non-content write could un-ratchet a previously floored stamp.
      NEW.updated_at := greatest(NEW.updated_at, OLD.updated_at);

      -- Content actually changed ⇒ the version is strictly newer. `+1`
      -- guarantees a peer sitting at OLD.updated_at sees a strictly-greater
      -- stamp even on same-ms / frozen-stamp writes. `user_updated_at`,
      -- `updated_by`, `created_*` are deliberately NOT in this test — metadata
      -- must not self-trigger a version bump.
      content_changed := (NEW.parent_id       is distinct from OLD.parent_id
        or NEW.order_key       is distinct from OLD.order_key
        or NEW.content         is distinct from OLD.content
        or NEW.properties_json is distinct from OLD.properties_json
        or NEW.references_json is distinct from OLD.references_json
        or NEW.deleted         is distinct from OLD.deleted);
      if content_changed then
        NEW.updated_at := greatest(NEW.updated_at, OLD.updated_at + 1);
      end if;
    end if;
  end if;

  return NEW;
end $$;

-- 2. Publish each patch's base version to the trigger, per row.
--
-- Set immediately before the UPDATE it describes and cleared immediately after,
-- so patch N's base can never be read by patch N+1 — nor by any non-patch
-- UPDATE that follows in the same transaction. An absent key becomes '0'
-- ("no usable base"), which the trigger already treats as drifted.
--
-- `base_updated_at` itself never reaches the column list: the UPDATE below is a
-- closed set of real columns and unknown patch keys are ignored, which is also
-- what makes a new-client PATCH safe against an old server.
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

    PERFORM set_config(
      'km.patch_base_updated_at',
      COALESCE(patch->>'base_updated_at', '0'),
      true
    );

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

    -- MUST read ROW_COUNT before anything else runs: it reflects the most
    -- recent SQL statement, and the `set_config` below is itself a SELECT that
    -- would reset it to 1 — silently disabling the missing-id detection that
    -- raises P0002.
    GET DIAGNOSTICS affected = ROW_COUNT;

    -- Scope the base to the single UPDATE above (see the header).
    PERFORM set_config('km.patch_base_updated_at', '', true);

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
