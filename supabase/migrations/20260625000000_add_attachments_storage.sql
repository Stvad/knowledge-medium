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
-- EXECUTE on the functions. The public `blocks` policies call the same
-- functions and work today, so `authenticated` already holds some grant — but
-- it is NOT in any migration (likely a bootstrap / PUBLIC grant), so granting
-- explicitly here keeps a from-migrations rebuild self-contained rather than
-- depending on that out-of-band grant. Idempotent: a no-op if already held.
grant usage on schema private to authenticated;
grant execute on function private.is_workspace_member(text, text) to authenticated;
grant execute on function private.is_workspace_writer(text, text) to authenticated;

-- ── the bucket (PRIVATE; never public — E2EE bytes must not be world-readable) ─
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

-- ── RLS: read by workspace member ───────────────────────────────────────────
create policy "attachments read by workspace member"
on storage.objects for select to authenticated
using (
  bucket_id = 'attachments'
  and private.is_workspace_member(
        (storage.foldername(name))[1],   -- <workspace_id> (path's first segment)
        (auth.uid())::text)
);

-- ── RLS: delete by workspace writer (no insert/update — Edge Function only) ──
create policy "attachments delete by workspace writer"
on storage.objects for delete to authenticated
using (
  bucket_id = 'attachments'
  and private.is_workspace_writer(
        (storage.foldername(name))[1],   -- <workspace_id>
        (auth.uid())::text)
);
