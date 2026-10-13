-- Refuse anon-key calls to the block upload RPCs with PT401.
--
-- Both RPCs are SECURITY INVOKER and executable by `anon` (Supabase's default
-- function grants). A client whose session refresh failed sends its request
-- with the anon key, so the call runs as `anon`, RLS hides every row, and the
-- outcome reads as a data error: `apply_block_patches` reports its targets
-- missing (P0002) and `apply_block_creates` hits an RLS violation (42501). The
-- uploader classifies both as permanent and quarantines the write. PT401 makes
-- PostgREST answer HTTP 401, which the uploader retries until the session is
-- back.
--
-- The check is on the ROLE, not `auth.uid() IS NULL`: superuser and
-- service-role callers (pgTAP tests, backfills, admin fixes) call these with no
-- JWT. An authenticated caller who is not a writer still reaches the body and
-- still gets P0002 / 42501, because a lost permission is permanent.
--
-- Not `REVOKE EXECUTE ... FROM anon`: PostgREST answers that with 42501, which
-- the uploader also quarantines.
--
-- Bodies are otherwise verbatim from 20260803000000 (patches) and
-- 20260709000000 (creates).

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
  -- Refuse an anon-key call before RLS can disguise it (see this migration's header).
  IF current_user = 'anon' THEN
    RAISE EXCEPTION 'apply_block_patches: no authenticated user' USING ERRCODE = 'PT401';
  END IF;

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

    -- Scope the base to the single UPDATE above (see the header of 20260803000000_add_patch_base_version_drift_bump.sql).
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
  -- Refuse an anon-key call before RLS can disguise it (see this migration's header).
  IF current_user = 'anon' THEN
    RAISE EXCEPTION 'apply_block_creates: no authenticated user' USING ERRCODE = 'PT401';
  END IF;

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
    -- racing client gets an echo. See the header of 20260709000000_add_apply_block_creates_rpc.sql for why this is a no-op write.
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
