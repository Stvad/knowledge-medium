-- Trigger behavior tests for `blocks_history`. Run against a local DB
-- with the migration applied:
--
--   psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/blocks_history_trigger.test.sql
--
-- Wraps everything in BEGIN/ROLLBACK so it leaves no residue. ASSERTs
-- abort the transaction on the first failure with a clear message; a
-- "blocks_history trigger tests passed" NOTICE prints only on full
-- success.
--
-- Not auto-run by `yarn check`. Postgres-level migration logic isn't
-- exercised by the JS test suite, so this lives as a manual gate to run
-- alongside `supabase db reset` after touching the trigger.

BEGIN;

DO $$
DECLARE
  v_workspace_id text := 'test-ws-' || gen_random_uuid()::text;
  v_user_id      text := gen_random_uuid()::text;
  v_other_user   text := gen_random_uuid()::text;
  v_block_id     text := 'test-block-' || gen_random_uuid()::text;
  -- All client timestamps held one minute in the past so the
  -- `blocks_clamp_updated_at` BEFORE trigger never clamps them. Within the
  -- test we use v_then + small offsets; all comfortably below server now.
  v_then         bigint := (extract(epoch from now()) * 1000)::bigint - 60000;
  v_now          bigint := (extract(epoch from now()) * 1000)::bigint;
  v_count        int;
  v_row          public.blocks_history;
BEGIN
  -- Seed: workspace + owner membership so the FK on blocks.workspace_id holds.
  INSERT INTO public.workspaces (id, name, owner_user_id, create_time, update_time)
    VALUES (v_workspace_id, 'test', v_user_id, v_now, v_now);
  INSERT INTO public.workspace_members (id, workspace_id, user_id, role, create_time)
    VALUES (gen_random_uuid()::text, v_workspace_id, v_user_id, 'owner', v_now);

  -------------------------------------------------------------------------
  -- INSERT
  -------------------------------------------------------------------------
  INSERT INTO public.blocks (
    id, workspace_id, parent_id, order_key, content,
    created_at, updated_at, created_by, updated_by
  ) VALUES (
    v_block_id, v_workspace_id, NULL, 'a0', 'hello',
    v_then, v_then, v_user_id, v_user_id
  );

  SELECT count(*) INTO v_count
    FROM public.blocks_history WHERE block_id = v_block_id;
  ASSERT v_count = 1,
    format('INSERT: expected 1 history row, got %s', v_count);

  SELECT * INTO v_row FROM public.blocks_history
    WHERE block_id = v_block_id ORDER BY event_id DESC LIMIT 1;
  ASSERT v_row.op = 'I',                 format('INSERT: op=%L', v_row.op);
  ASSERT v_row.semantic_op = 'create',   format('INSERT: semantic_op=%L', v_row.semantic_op);
  ASSERT v_row.before_diff IS NULL,      'INSERT: before_diff should be NULL';
  ASSERT v_row.after_diff IS NOT NULL,   'INSERT: after_diff should be non-NULL';
  ASSERT v_row.after_diff ? 'id',        'INSERT: after_diff should contain full row';
  ASSERT v_row.after_diff ? 'content',   'INSERT: after_diff should contain content';
  ASSERT v_row.changed_columns IS NULL,  'INSERT: changed_columns should be NULL';
  ASSERT v_row.actor = v_user_id,        format('INSERT: actor=%L', v_row.actor);

  -------------------------------------------------------------------------
  -- UPDATE (non-deleted column)
  -------------------------------------------------------------------------
  UPDATE public.blocks
     SET content = 'world', updated_at = v_then + 1, updated_by = v_other_user
   WHERE id = v_block_id;

  SELECT count(*) INTO v_count
    FROM public.blocks_history WHERE block_id = v_block_id;
  ASSERT v_count = 2,
    format('UPDATE: expected 2 history rows total, got %s', v_count);

  SELECT * INTO v_row FROM public.blocks_history
    WHERE block_id = v_block_id ORDER BY event_id DESC LIMIT 1;
  ASSERT v_row.op = 'U',                              format('UPDATE: op=%L', v_row.op);
  ASSERT v_row.semantic_op = 'update',                format('UPDATE: semantic_op=%L', v_row.semantic_op);
  ASSERT v_row.changed_columns @> ARRAY['content'],   'UPDATE: changed_columns missing content';
  ASSERT v_row.changed_columns @> ARRAY['updated_at'],'UPDATE: changed_columns missing updated_at';
  ASSERT v_row.changed_columns @> ARRAY['updated_by'],'UPDATE: changed_columns missing updated_by';
  ASSERT NOT (v_row.changed_columns @> ARRAY['deleted']),
    'UPDATE: deleted should not be in changed_columns';
  ASSERT v_row.before_diff ->> 'content' = 'hello',   format('UPDATE: before_diff.content=%L', v_row.before_diff ->> 'content');
  ASSERT v_row.after_diff  ->> 'content' = 'world',   format('UPDATE: after_diff.content=%L',  v_row.after_diff  ->> 'content');
  ASSERT NOT (v_row.before_diff ? 'id'),
    'UPDATE: before_diff should not carry unchanged columns (id)';
  ASSERT v_row.actor = v_other_user,                  format('UPDATE: actor=%L', v_row.actor);

  -------------------------------------------------------------------------
  -- UPDATE — soft_delete (deleted false -> true)
  -------------------------------------------------------------------------
  UPDATE public.blocks
     SET deleted = TRUE, updated_at = v_then + 2
   WHERE id = v_block_id;

  SELECT * INTO v_row FROM public.blocks_history
    WHERE block_id = v_block_id ORDER BY event_id DESC LIMIT 1;
  ASSERT v_row.op = 'U',                            format('soft_delete: op=%L', v_row.op);
  ASSERT v_row.semantic_op = 'soft_delete',         format('soft_delete: semantic_op=%L', v_row.semantic_op);
  ASSERT v_row.changed_columns @> ARRAY['deleted'], 'soft_delete: changed_columns missing deleted';
  ASSERT (v_row.before_diff ->> 'deleted')::boolean IS FALSE,
    'soft_delete: before_diff.deleted should be false';
  ASSERT (v_row.after_diff  ->> 'deleted')::boolean IS TRUE,
    'soft_delete: after_diff.deleted should be true';

  -------------------------------------------------------------------------
  -- UPDATE — undelete (deleted true -> false)
  -------------------------------------------------------------------------
  UPDATE public.blocks
     SET deleted = FALSE, updated_at = v_then + 3
   WHERE id = v_block_id;

  SELECT * INTO v_row FROM public.blocks_history
    WHERE block_id = v_block_id ORDER BY event_id DESC LIMIT 1;
  ASSERT v_row.semantic_op = 'undelete',
    format('undelete: semantic_op=%L', v_row.semantic_op);
  ASSERT (v_row.before_diff ->> 'deleted')::boolean IS TRUE,
    'undelete: before_diff.deleted should be true';
  ASSERT (v_row.after_diff  ->> 'deleted')::boolean IS FALSE,
    'undelete: after_diff.deleted should be false';

  -------------------------------------------------------------------------
  -- UPDATE — no-op (identical values) should record NOTHING
  -------------------------------------------------------------------------
  SELECT count(*) INTO v_count FROM public.blocks_history WHERE block_id = v_block_id;
  UPDATE public.blocks
     SET content = content
   WHERE id = v_block_id;
  ASSERT (SELECT count(*) FROM public.blocks_history WHERE block_id = v_block_id) = v_count,
    'no-op UPDATE should not produce a history row';

  -------------------------------------------------------------------------
  -- DELETE
  -------------------------------------------------------------------------
  DELETE FROM public.blocks WHERE id = v_block_id;

  SELECT * INTO v_row FROM public.blocks_history
    WHERE block_id = v_block_id ORDER BY event_id DESC LIMIT 1;
  ASSERT v_row.op = 'D',                  format('DELETE: op=%L', v_row.op);
  ASSERT v_row.semantic_op = 'delete',    format('DELETE: semantic_op=%L', v_row.semantic_op);
  ASSERT v_row.before_diff IS NOT NULL,   'DELETE: before_diff should be the full prior row';
  ASSERT v_row.before_diff ? 'content',   'DELETE: before_diff should contain content';
  ASSERT v_row.after_diff IS NULL,        'DELETE: after_diff should be NULL';
  ASSERT v_row.changed_columns IS NULL,   'DELETE: changed_columns should be NULL';

  RAISE NOTICE 'blocks_history trigger tests passed';
END $$;

ROLLBACK;
