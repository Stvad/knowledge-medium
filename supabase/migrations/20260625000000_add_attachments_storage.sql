-- Media attachments: the `attachments` Storage bucket + its RLS.
-- Design: docs/media-attachments/design.html §10 ("Storage layout & RLS").
--
-- Object path = <workspace_id>/<content-key>  (content-addressed, §10;
--   content-key = HMAC(K_id, sha256(plaintext)) for E2EE, sha256(bytes) for
--   plaintext). The path's FIRST segment is the workspace id, which is what
--   RLS gates on.
--
-- The mutation split (§10 / §10.1):
--   READS  (select): direct, member-gated RLS.
--   WRITES (insert/update): DENIED to clients — there is NO insert/update
--     policy for `authenticated`. All uploads go through the body-inspecting
--     Edge Function (§10.1) which authorizes the caller, rejects bare
--     plaintext into an E2EE prefix, and writes with the service-role key
--     (which bypasses RLS). A direct client write would bypass the encb:v1:
--     ciphertext guard, so it must be impossible.
--   DELETES (delete): direct, writer-only RLS — a delete removes an object,
--     there is no body to inspect, so a writer-only policy is sufficient AND
--     required (without it BlobStore.delete() is default-denied, so §16 GC and
--     the §10.1 poison-correction could never reclaim objects).
--
-- storage.objects already has RLS enabled (owned by supabase_storage_admin);
-- we only add policies.

-- ── private-schema access for the policy's querying role (§10 warn box) ──────
-- The policies below call private.is_workspace_member / is_workspace_writer
-- (SECURITY DEFINER, search_path=''). An RLS USING expression runs as the
-- QUERYING role (authenticated), which therefore needs USAGE on `private` +
-- EXECUTE on those helpers. The consolidated baseline migration now owns those
-- grants (added in "fix(supabase): make consolidated baseline replayable on
-- fresh PG17"), and this migration always runs after it — so they are
-- intentionally NOT repeated here, keeping a single owner for the grant.

-- ── why this migration is guarded ───────────────────────────────────────────
-- storage.buckets / storage.objects are created by the Storage SERVICE, not by
-- the database image. On the hosted project (and any `db push`) they already
-- exist, so this provisions the bucket + policies. On a local `supabase start`
-- the Storage container boots AFTER user migrations run, so at apply time the
-- `storage` SCHEMA exists but its TABLES do not — referencing them unguarded
-- fails with `relation "storage.buckets" does not exist` and aborts the whole
-- bring-up. We guard on the table's presence and no-op when it is absent, so
-- `supabase start` succeeds on every stack while the bucket + policies still
-- apply on `db push`. (For a local bucket declare it in config.toml; local RLS
-- testing applies these same policies once Storage is up.)
--
-- CREATE POLICY runs through EXECUTE (dynamic SQL) so it is parsed only at run
-- time, inside the guard. The bucket insert + policy bodies are otherwise
-- unchanged from the unguarded version (which `db push` already proved `postgres`
-- may create on storage.objects); no DROP POLICY is added — a migration applies
-- once in a transaction, and adding a DROP would need ownership `postgres` lacks.
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice
      'attachments: storage schema not initialised yet — skipping bucket + policies (applies on db push / once Storage is up)';
    return;
  end if;

  -- the bucket (PRIVATE; never public — E2EE bytes must not be world-readable)
  insert into storage.buckets (id, name, public)
  values ('attachments', 'attachments', false)
  on conflict (id) do nothing;

  -- RLS: read by workspace member. Path's first segment = <workspace_id>.
  execute $pol$
    create policy "attachments read by workspace member"
    on storage.objects for select to authenticated
    using (
      bucket_id = 'attachments'
      and private.is_workspace_member((storage.foldername(name))[1], (auth.uid())::text)
    )
  $pol$;

  -- RLS: delete by workspace writer (no insert/update — Edge Function only).
  execute $pol$
    create policy "attachments delete by workspace writer"
    on storage.objects for delete to authenticated
    using (
      bucket_id = 'attachments'
      and private.is_workspace_writer((storage.foldername(name))[1], (auth.uid())::text)
    )
  $pol$;
end $$;
