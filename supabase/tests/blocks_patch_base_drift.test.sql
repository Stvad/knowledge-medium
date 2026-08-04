-- Behavioral tests for the base-version drift bump added in
-- 20260803000000_add_patch_base_version_drift_bump.sql (issue #381). Run with:
--
--   pnpm check:db
--
-- pgTAP, self-wrapped in BEGIN/ROLLBACK so manual psql runs leave no residue.
--
-- What #381 was: `apply_block_patches` straight-assigns the client's proposed
-- `updated_at`, and the old content bump only guaranteed `> OLD.updated_at`. A
-- concurrent second editor whose stamp already exceeded `OLD + 1` therefore got
-- the merged row back at exactly its OWN stamp, which its reconcile gate reads
-- as "my own write came back" and skips — so that device kept content the
-- server had merged someone else's edit under, permanently.
--
-- The fix carries the answer explicitly: the client stamps each PATCH with
-- `base_updated_at` (the version it edited against) and the server bumps past
-- the proposed stamp whenever that base no longer matches the row.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO public, extensions;

SELECT plan(18);

CREATE TEMP TABLE drift_test_ctx AS
SELECT
  'test-ws-' || extensions.gen_random_uuid()::text AS workspace_id,
  extensions.gen_random_uuid()::text               AS user_id,
  -- Ten seconds in the past, so the future-clamp never touches these.
  (extract(epoch from now()) * 1000)::bigint - 10000 AS then_ms,
  (extract(epoch from now()) * 1000)::bigint         AS now_ms;

INSERT INTO public.workspaces (id, name, owner_user_id, create_time, update_time)
SELECT workspace_id, 'test', user_id, now_ms, now_ms FROM drift_test_ctx;

INSERT INTO public.workspace_members (id, workspace_id, user_id, role, create_time)
SELECT extensions.gen_random_uuid()::text, workspace_id, user_id, 'owner', now_ms
FROM drift_test_ctx;

-- Seed a block whose row-version is exactly `p_updated`.
CREATE OR REPLACE FUNCTION pg_temp.seed_block(p_id text, p_updated bigint, p_content text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE c drift_test_ctx%rowtype;
BEGIN
  SELECT * INTO c FROM drift_test_ctx;
  INSERT INTO public.blocks (
    id, workspace_id, parent_id, order_key, content,
    properties_json, created_at, updated_at, user_updated_at, created_by, updated_by
  ) VALUES (
    p_id, c.workspace_id, NULL, 'k0', p_content,
    '{}', c.then_ms, p_updated, c.then_ms, c.user_id, c.user_id
  );
END $$;

-- One patch through the real RPC. `p_base` NULL omits the key entirely, which
-- is what an old client sends.
CREATE OR REPLACE FUNCTION pg_temp.patch_block(
  p_id text, p_content text, p_proposed bigint, p_base bigint DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE patch jsonb;
BEGIN
  patch := jsonb_build_object('id', p_id, 'content', p_content,
                              'updated_at', p_proposed::text);
  IF p_base IS NOT NULL THEN
    patch := patch || jsonb_build_object('base_updated_at', p_base::text);
  END IF;
  PERFORM public.apply_block_patches(jsonb_build_array(patch));
END $$;

-------------------------------------------------------------------------
-- 1. UN-DRIFTED patch: the proposed stamp is accepted verbatim.
--    This is the cost floor — the author's echo comes back at its own stamp
--    and is skipped, so a clean edit costs no re-materialization anywhere.
-------------------------------------------------------------------------
SELECT pg_temp.seed_block('d-clean', (SELECT then_ms FROM drift_test_ctx), 'old');
SELECT pg_temp.patch_block('d-clean', 'new',
  (SELECT then_ms + 5000 FROM drift_test_ctx),
  (SELECT then_ms FROM drift_test_ctx));

SELECT is(
  (SELECT updated_at FROM public.blocks WHERE id = 'd-clean'),
  (SELECT then_ms + 5000 FROM drift_test_ctx),
  'un-drifted patch keeps the client-proposed stamp'
);

-------------------------------------------------------------------------
-- 2. DRIFTED patch: the row moved under the edit, so the merged row carries
--    content this author has never seen. Its stamp must clear BOTH the old
--    server version and the author's own proposed stamp.
-------------------------------------------------------------------------
SELECT pg_temp.seed_block('d-drift', (SELECT then_ms FROM drift_test_ctx), 'theirs');
SELECT pg_temp.patch_block('d-drift', 'mine',
  (SELECT then_ms + 5000 FROM drift_test_ctx),
  (SELECT then_ms - 5000 FROM drift_test_ctx));

SELECT cmp_ok(
  (SELECT updated_at FROM public.blocks WHERE id = 'd-drift'), '>',
  (SELECT then_ms + 5000 FROM drift_test_ctx),
  'drifted patch bumps past the author-proposed stamp'
);
SELECT cmp_ok(
  (SELECT updated_at FROM public.blocks WHERE id = 'd-drift'), '>',
  (SELECT then_ms FROM drift_test_ctx),
  'drifted patch bumps past the old server version'
);

-------------------------------------------------------------------------
-- 3. THE COINCIDENT-VALUE CASE. Drifted, but the patch writes a value the
--    merged row ALREADY holds (both devices soft-deleted the same block, both
--    re-set the same property), so no content column changes. A content-gated
--    bump does not fire here: the row came back at the author's own stamp and
--    that device silently kept whatever ELSE the other one changed. This is
--    why the drift bump is unconditional rather than content-gated.
-------------------------------------------------------------------------
SELECT pg_temp.seed_block('d-same', (SELECT then_ms FROM drift_test_ctx), 'same');
SELECT pg_temp.patch_block('d-same', 'same',
  (SELECT then_ms + 5000 FROM drift_test_ctx),
  (SELECT then_ms - 5000 FROM drift_test_ctx));

SELECT cmp_ok(
  (SELECT updated_at FROM public.blocks WHERE id = 'd-same'), '>',
  (SELECT then_ms + 5000 FROM drift_test_ctx),
  'drifted patch that changes NO content column still bumps'
);

-------------------------------------------------------------------------
-- 4. FAST CLOCK. The bump is computed from the PRE-clamp proposal, so it is
--    exactly one past the author's own stamp. Bumping from the post-clamp
--    value would yield server_now + 1, which for a client one millisecond
--    ahead lands back ON the author's stamp and re-opens #381.
-------------------------------------------------------------------------
-- 60s ahead: a realistic fast clock, comfortably inside the trusted-skew bound
-- that test 9 exercises the far side of.
SELECT pg_temp.seed_block('d-fast', (SELECT then_ms FROM drift_test_ctx), 'theirs');
SELECT pg_temp.patch_block('d-fast', 'mine',
  (SELECT now_ms + 60000 FROM drift_test_ctx),
  (SELECT then_ms - 5000 FROM drift_test_ctx));

SELECT is(
  (SELECT updated_at FROM public.blocks WHERE id = 'd-fast'),
  (SELECT now_ms + 60000 + 1 FROM drift_test_ctx),
  'fast-clock drifted patch bumps to proposed + 1 (pre-clamp)'
);
-- The display stamp is NOT dragged along: it stays clamped to server now.
SELECT cmp_ok(
  (SELECT user_updated_at FROM public.blocks WHERE id = 'd-fast'), '<=',
  (extract(epoch from now()) * 1000)::bigint + 1000,
  'the drift bump does not lift user_updated_at into the future'
);

-------------------------------------------------------------------------
-- 5. The `0` pristine sentinel carries no drift information — every device
--    stamps a speculative deterministic-id mint 0 independently, so equality
--    at 0 is shared by construction. Must read as drifted.
-------------------------------------------------------------------------
SELECT pg_temp.seed_block('d-zero', 0, 'template');
SELECT pg_temp.patch_block('d-zero', 'edited',
  (SELECT then_ms + 5000 FROM drift_test_ctx), 0);

SELECT cmp_ok(
  (SELECT updated_at FROM public.blocks WHERE id = 'd-zero'), '>',
  (SELECT then_ms + 5000 FROM drift_test_ctx),
  'base = 0 (pristine sentinel) reads as drifted'
);

-------------------------------------------------------------------------
-- 6. An old client sends no base at all. Unknown base ⇒ assume drift, so the
--    fleet is CORRECT from the moment this deploys; those clients just pay one
--    echo per edit until they upgrade.
-------------------------------------------------------------------------
SELECT pg_temp.seed_block('d-old', (SELECT then_ms FROM drift_test_ctx), 'old');
SELECT pg_temp.patch_block('d-old', 'new', (SELECT then_ms + 5000 FROM drift_test_ctx));

SELECT cmp_ok(
  (SELECT updated_at FROM public.blocks WHERE id = 'd-old'), '>',
  (SELECT then_ms + 5000 FROM drift_test_ctx),
  'a patch with no base_updated_at reads as drifted'
);

-------------------------------------------------------------------------
-- 7. THE #244 GUARANTEE. `apply_block_creates`' ON CONFLICT branch is a
--    deliberate no-op TOUCH: it must re-deliver the row WITHOUT advancing its
--    version, or every deterministic-id collision re-materializes on every
--    device. It reaches the same trigger as a patch, so the base signal must
--    not leak into it — including when a patch ran earlier in the SAME
--    transaction, which is exactly the case here (pgTAP wraps the file in one).
-------------------------------------------------------------------------
SELECT pg_temp.seed_block('d-touch', (SELECT then_ms FROM drift_test_ctx), 'keep');
UPDATE public.blocks SET updated_at = blocks.updated_at WHERE id = 'd-touch';

SELECT is(
  (SELECT updated_at FROM public.blocks WHERE id = 'd-touch'),
  (SELECT then_ms FROM drift_test_ctx),
  'a non-patch no-op UPDATE after a patch still preserves the version (#244)'
);

-------------------------------------------------------------------------
-- 8. Per-patch scoping inside one RPC batch: a drifted patch must not make a
--    later clean patch in the same call look drifted.
-------------------------------------------------------------------------
SELECT pg_temp.seed_block('d-batch-a', (SELECT then_ms FROM drift_test_ctx), 'a');
SELECT pg_temp.seed_block('d-batch-b', (SELECT then_ms FROM drift_test_ctx), 'b');
SELECT public.apply_block_patches(jsonb_build_array(
  jsonb_build_object('id', 'd-batch-a', 'content', 'a2',
    'updated_at', (SELECT (then_ms + 3000)::text FROM drift_test_ctx),
    'base_updated_at', (SELECT (then_ms - 5000)::text FROM drift_test_ctx)),
  jsonb_build_object('id', 'd-batch-b', 'content', 'b2',
    'updated_at', (SELECT (then_ms + 4000)::text FROM drift_test_ctx),
    'base_updated_at', (SELECT then_ms::text FROM drift_test_ctx))
));

SELECT cmp_ok(
  (SELECT updated_at FROM public.blocks WHERE id = 'd-batch-a'), '>',
  (SELECT then_ms + 3000 FROM drift_test_ctx),
  'the drifted patch in a batch bumps'
);
SELECT is(
  (SELECT updated_at FROM public.blocks WHERE id = 'd-batch-b'),
  (SELECT then_ms + 4000 FROM drift_test_ctx),
  'a clean patch following a drifted one in the same batch is unaffected'
);

-------------------------------------------------------------------------
-- 9. The drift branch steps around the future-clamp, so it carries its own
--    bound. `apply_block_patches` is SECURITY INVOKER and granted to
--    `authenticated`: unbounded, any workspace writer could send bigint max and
--    pin the version there, after which every later `+ 1` raises 22003 and the
--    row is permanently uneditable (and the value is past JS's safe-integer
--    range, so the client cannot represent it either).
-------------------------------------------------------------------------
SELECT pg_temp.seed_block('d-huge', (SELECT then_ms FROM drift_test_ctx), 'v0');
SELECT pg_temp.patch_block('d-huge', 'v1', 9223372036854775806, 0);

SELECT cmp_ok(
  (SELECT updated_at FROM public.blocks WHERE id = 'd-huge'), '<=',
  (extract(epoch from now()) * 1000)::bigint + 3600000 + 1000,
  'a crafted far-future stamp is bounded to ~server now + the trusted skew'
);
SELECT cmp_ok(
  (SELECT updated_at FROM public.blocks WHERE id = 'd-huge'), '<',
  9007199254740991::bigint,
  'the bounded version stays inside JS safe-integer range'
);

-- ...and the row is still editable afterwards, which is the failure that made
-- this a data-loss bug rather than a cosmetic one.
SELECT lives_ok(
  $$ SELECT public.apply_block_patches(jsonb_build_array(jsonb_build_object(
       'id', 'd-huge', 'content', 'v2', 'updated_at', '1', 'base_updated_at', '1'))) $$,
  'a row that received a crafted stamp is still editable'
);

-------------------------------------------------------------------------
-- 10. A malformed base must not be mistaken for "not a patch write". The
--     trigger reads NULL/'' as "this UPDATE did not come from the RPC" and
--     runs pre-#381 behavior; if an empty string reached it, a caller could
--     make its PATCH indistinguishable from a backfill and opt out of the
--     drift check entirely. The RPC normalizes anything non-numeric to '0'.
-------------------------------------------------------------------------
SELECT pg_temp.seed_block('d-empty', (SELECT then_ms FROM drift_test_ctx), 'v0');
SELECT public.apply_block_patches(jsonb_build_array(jsonb_build_object(
  'id', 'd-empty', 'content', 'v1',
  'updated_at', (SELECT (then_ms + 5000)::text FROM drift_test_ctx),
  'base_updated_at', '')));

SELECT cmp_ok(
  (SELECT updated_at FROM public.blocks WHERE id = 'd-empty'), '>',
  (SELECT then_ms + 5000 FROM drift_test_ctx),
  'an empty base_updated_at reads as drifted, not as a non-patch write'
);

-------------------------------------------------------------------------
-- 11. Non-numeric / over-wide bases must not raise. The cast lives in the
--     trigger, so a raise would roll back the whole RPC — and the client
--     classifies 22xxx as permanent, quarantining the entire crud
--     transaction over one bad key rather than retrying it.
-------------------------------------------------------------------------
SELECT pg_temp.seed_block('d-junk', (SELECT then_ms FROM drift_test_ctx), 'v0');
SELECT lives_ok(
  $$ SELECT public.apply_block_patches(jsonb_build_array(jsonb_build_object(
       'id', 'd-junk', 'content', 'v1', 'updated_at', '1', 'base_updated_at', 'abc'))) $$,
  'a non-numeric base does not raise (and so cannot quarantine the batch)'
);
SELECT lives_ok(
  $$ SELECT public.apply_block_patches(jsonb_build_array(jsonb_build_object(
       'id', 'd-junk', 'content', 'v2', 'updated_at', '1',
       'base_updated_at', '99999999999999999999'))) $$,
  'an over-wide base does not overflow the cast'
);

-------------------------------------------------------------------------
-- 12. The cap boundary. Capping the INPUT costs the property the branch
--     rests on: a proposal exactly one past the cap makes least() return the
--     cap, so `+ 1` hands back that same proposal — the author's own stamp,
--     the equal stamp the echo skip keys on. The result must never equal the
--     proposal.
-------------------------------------------------------------------------
-- Returns 1 if the server handed the row back at the author's own proposed
-- stamp (the collision), 0 otherwise. A plain function rather than a DO block
-- because `PERFORM ok(...)` registers the assertion but never emits its TAP
-- line, leaving the file one line short of its plan.
CREATE OR REPLACE FUNCTION pg_temp.cap_boundary_collision() RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  server_now bigint := (extract(epoch from now()) * 1000)::bigint;
  proposed   bigint;
  got        bigint;
BEGIN
  proposed := server_now + 3600000 + 1;
  PERFORM pg_temp.seed_block('d-boundary', server_now - 10000, 'theirs');
  PERFORM pg_temp.patch_block('d-boundary', 'mine', proposed, server_now - 20000);
  SELECT updated_at INTO got FROM public.blocks WHERE id = 'd-boundary';
  RETURN CASE WHEN got = proposed THEN 1 ELSE 0 END;
END $$;

SELECT is(
  pg_temp.cap_boundary_collision(), 0,
  'a drifted patch at the cap boundary never returns the author''s own stamp'
);

SELECT * FROM finish();
ROLLBACK;
