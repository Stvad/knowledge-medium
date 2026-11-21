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
--
-- KNOWN COST, on the retry path: upload is at-least-once, and a REPLAYED patch
-- carries the base it was built with while the row has already moved to what
-- the first delivery wrote — so it reads as drifted and bumps again. Before
-- this migration a replay was a true no-op. `applyBlockPatchesRpc` chunks at
-- MAX_PATCHES_PER_SUPABASE_RPC per transaction and PowerSync retries the whole
-- crud transaction, so a failure in chunk N re-delivers chunks 1..N-1 and each
-- of those rows takes one forced re-materialization fleet-wide (plus a
-- `blocks_history` row). No divergence and no loss — every device converges on
-- the same content — but the "zero echoes for an uncontended edit" property
-- holds only absent retries, which mostly means bulk imports and large offline
-- backlogs, since an ordinary batch is one chunk. Deliberately NOT special-
-- cased: the signature of a replay ("merged row identical to OLD AND proposed
-- = OLD.updated_at") is distinguishable, but adding a third branch here to save
-- cost on an error path is a poor trade against the risk of getting the version
-- rule wrong. Revisit if bulk-import echo churn ever shows up in practice.

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
  -- How far past server-now the drift bump is willing to trust a client's
  -- proposed stamp. Real clock skew is seconds; an hour is already generous.
  --
  -- Without this bound the drift branch would persist whatever a caller sent:
  -- `apply_block_patches` is SECURITY INVOKER and granted to `authenticated`,
  -- so any workspace writer (or a client with a wildly wrong clock) could send
  -- `updated_at` = bigint max and pin the row's version there. Every later
  -- write's `+ 1` then raises 22003 and the row becomes permanently uneditable
  -- — and the client classifies 22003 as permanent, so those edits are
  -- quarantined rather than retried. Such a value is also past JS's
  -- safe-integer range, which `BlockRow.updated_at` (a `number`) cannot
  -- represent. The pre-#381 code was immune only because it clamped every
  -- proposal to server-now; the drift branch deliberately steps around that
  -- clamp, so it has to carry its own bound.
  max_trusted_skew_ms constant bigint := 3600000;
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

  -- Accepted residual, widened by this migration and recorded rather than
  -- fixed. Once a row's version sits ABOVE server-now — which the drift bump
  -- below now arranges for up to `max_trusted_skew_ms` after any contended
  -- write — an UN-drifted patch from a clock-ahead client can converge on
  -- `updated_at` while permanently diverging on `user_updated_at`:
  --
  --   OLD.updated_at = 5001, server-now = 1002, the author's clock = 1500.
  --   Its proposed updated_at (5002, by I3) is future-clamped to 1002, then the
  --   floor and the content bump restore it to 5002 — equal to the author's own
  --   local stamp, so the echo is skipped. But `user_updated_at` was clamped
  --   from 1500 to 1002 on the way in, and the skipped echo is what would have
  --   carried that correction back.
  --
  -- Left alone deliberately: `user_updated_at` is display-only, so the cost is a
  -- slightly-off "last edited" on one device. Including it in the content-change
  -- test below would fix it, at the price of a version bump — and therefore a
  -- fleet-wide re-materialize — on every metadata-only write, which is a much
  -- worse trade. Note this does NOT violate I1 as reconcile.ts states it: the
  -- content columns are identical, and metadata is excluded from the version by
  -- design (20260612).

  if TG_OP = 'UPDATE' then
    base_setting := current_setting('km.patch_base_updated_at', true);

    if coalesce(base_setting, '') <> '' then
      -- This cast is total only because `apply_block_patches` is the sole
      -- writer of this GUC and normalizes to `^[0-9]{1,18}$` before setting it.
      -- Anything else that ever writes `km.patch_base_updated_at` must do the
      -- same, or a malformed value raises here and rolls back its whole
      -- transaction.
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
      -- Deliberate exception to the future-clamp above. `updated_at` is a pure
      -- row-version post-20260612 (display reads `user_updated_at`), so sitting
      -- ahead of wall-clock costs nothing — the floor already relies on that.
      --
      -- OLD is inside the greatest(), and that term is load-bearing rather than
      -- decorative: it is the ONLY thing keeping the version monotonic on this
      -- path, since the clamp this branch steps around cannot help here. Drop it
      -- and a row already sitting above server-now regresses by the whole cap.
      --
      -- The precise bound is `max(server_now + max_trusted_skew_ms + 2, OLD + 2)`
      -- — NOT `server_now + cap`, which an earlier version of this comment
      -- claimed. Two reasons: the collision guard below can add a second
      -- millisecond, and the OLD term ratchets +1 per drifted write with no
      -- ceiling, so a long enough run of them climbs without limit (one RPC may
      -- carry the same id many times). Measured, sustained drifted writes
      -- advance the version ~1.2s per wall-clock second — so the EXCESS over
      -- wall-clock is only ~0.2s/s, and it goes negative once many ids ride a
      -- single RPC (~0.9s/s). Either way reaching 2^53 from a 2026 stamp takes
      -- on the order of 10^5 years — safe in practice, but by measurement, not
      -- by construction. Do NOT clamp the result to recover the tidier bound:
      -- monotonicity is worth more than a neat ceiling.
      --
      -- Clearing `raw_proposed` (the PRE-clamp proposal) is what makes the echo
      -- materialize on the author's device, since that is the stamp it wrote
      -- locally. A client skewed further ahead than the cap gets the bound
      -- instead, so its echo lands BELOW its local stamp: the merged row still
      -- reaches disk, but the in-memory cache's LWW gate rejects it
      -- (`blockCache.ts` `applyIfNewer`, which drops any `<=` snapshot) and the
      -- UI keeps showing the pre-merge local row.
      --
      -- Be precise about what that costs, because the obvious comparison is
      -- wrong. A far-skewed client ALREADY has its stamps knocked down by the
      -- future-clamp on ordinary edits, and its cache already rejects those
      -- echoes — but invisibly, because the content agrees and only the stamps
      -- differ. Here the content does NOT agree: the rejected echo is the one
      -- carrying the other device's edit, so until reload the UI shows a row
      -- from before that edit. Same mechanism, worse consequence, and the cap
      -- is what introduces it (measured, not assumed).
      --
      -- Worse, in fact, than "stale until reload" would suggest. A reload does
      -- repaint from disk, but it cannot undo a write that already went out —
      -- and while the stale view is live, the
      -- ordinary read-modify-write shape (`block.peek()` then `setContent`, as
      -- in `plugins/video-player/actions.ts` `appendToBlock`) builds its next
      -- edit from the pre-merge string and ships THAT to the server. The other
      -- device's edit is then overwritten for the whole fleet, and no reload
      -- recovers it. Measured, not assumed.
      --
      -- Kept anyway, because the comparison that matters is against the old
      -- server, not against perfection: with this branch mutated out, the same
      -- sweep loses the peer's edit at EVERY skew, 0 included. The cap narrows
      -- that from "every clock-ahead client" to "clients more than an hour
      -- out", and the alternative to the cap is the unbounded ratchet it exists
      -- to stop, which ends in a row no write can ever touch again. Narrower
      -- hazard plus a bounded version is the better end of that trade — but it
      -- is a narrowing, not a fix. Closing it properly means the cache falling
      -- back to `setSnapshot` when it rejects a sync echo; every row reaching
      -- that path has already cleared the disk gate's in-tx `hasPendingUpload`
      -- check, so no unsent local edit would be clobbered by doing so.
      NEW.updated_at := greatest(
        server_now_ms,
        OLD.updated_at,
        least(raw_proposed, server_now_ms + max_trusted_skew_ms)
      ) + 1;

      -- Capping the input costs the one property the whole branch rests on.
      -- Before the cap, `raw_proposed` sat inside the greatest(), so the result
      -- was `>= raw_proposed + 1` for every input. With it, a proposal exactly
      -- one past the cap makes least() return the cap and `+ 1` hand back that
      -- same proposal — the author's own stamp, which is precisely the equal
      -- stamp the echo skip keys on, on a genuinely drifted merge. One more
      -- millisecond restores "the result never equals the proposal".
      if NEW.updated_at = raw_proposed then
        NEW.updated_at := NEW.updated_at + 1;
      end if;
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
-- Set immediately before the UPDATE it describes and cleared immediately after.
-- What the clear actually buys is the state left behind AFTER the loop: any
-- non-patch UPDATE later in the same transaction — a create-TOUCH above all —
-- must not see a leftover base and read as drifted (#244). Patch N+1 is already
-- safe from patch N without it, since it sets its own base first; the clear is
-- kept per-iteration rather than hoisted so that the invariant is "no statement
-- but the one it describes ever sees a base", which stays true if a future
-- edit adds a statement inside the loop. An absent key becomes '0' ("no usable
-- base"), which the trigger already treats as drifted.
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

    -- Normalize to a digit string the trigger can cast without raising. Absent,
    -- empty, malformed and over-wide all collapse to '0' ("no usable base" ⇒
    -- drift), which is the safe default. Two distinct hazards, both reachable
    -- because this RPC is SECURITY INVOKER and granted to `authenticated`:
    --
    --   * an EMPTY string would reach the trigger as the same value the clear
    --     below writes, i.e. "not a patch write" — so a caller could make its
    --     PATCH indistinguishable from a backfill and silently opt that write
    --     out of the drift check entirely. Verified by execution: with a raw
    --     COALESCE, a stale-based patch sent with `base_updated_at: ""` came
    --     back at the author's own stamp, i.e. #381 un-fixed for that patch.
    --   * any non-numeric text raises 22P02 inside the trigger, which rolls
    --     back the whole RPC — and the client classifies 22xxx as PERMANENT, so
    --     one bad key quarantines the entire crud transaction to
    --     `ps_crud_rejected` rather than retrying it. Scope note: this closes
    --     that hazard for `base_updated_at` ONLY. The UPDATE below still casts
    --     `updated_at`, `created_at`, `user_updated_at` and `deleted` straight
    --     from the payload, and a malformed value in any of those raises the
    --     same way. They are no worse than they were before this migration, and
    --     `base_updated_at` is guarded because this migration is what added it.
    --
    -- 18 digits is the widest value that cannot overflow bigint on cast; real
    -- stamps are 13.
    PERFORM set_config(
      'km.patch_base_updated_at',
      CASE
        WHEN patch->>'base_updated_at' ~ '^[0-9]{1,18}$' THEN patch->>'base_updated_at'
        ELSE '0'
      END,
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
