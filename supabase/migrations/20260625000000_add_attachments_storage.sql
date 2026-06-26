-- Media attachments: the `attachments` Storage bucket + its RLS.
-- Design: docs/media-attachments/design.html §10 ("Storage layout & RLS").
--
-- Object path = <workspace_id>/<content-key>  (content-addressed, §10;
--   content-key = HMAC(K_id, sha256(plaintext)) for E2EE, sha256(bytes) for
--   plaintext). The path's FIRST segment is the workspace id, which is what
--   RLS gates on.
--
-- The mutation split (§10) — every operation is a DIRECT, RLS-gated client call;
-- there is NO mediating upload service (the §10.1 reversal, below):
--   READS   (select): member-gated — any workspace member may read.
--   WRITES  (insert): writer-gated — a workspace writer (owner/editor) uploads
--     directly to <workspace_id>/<content-key>. The WITH CHECK keys on the
--     path's first segment, so a writer can only write into a workspace they
--     actually write — there is no separate workspace param to spoof.
--   UPDATES         : NO policy → denied by default. THIS IS THE IMMUTABILITY
--     GUARANTEE: the path is content-addressed (§10), so an object is write-once.
--     A second upload to an existing path is rejected by Storage (HTTP 409),
--     which the client treats as first-write-wins idempotent dedup (§10.1).
--     Denying UPDATE also blocks upsert/overwrite (Storage needs INSERT+SELECT+
--     UPDATE to overwrite) and an in-place rename onto an existing object.
--   DELETES (delete): writer-gated — a delete removes an object, there is no
--     body to inspect; required so §16 GC and the §10.1 poison-correction can
--     reclaim objects (without it BlobStore.delete() is default-denied).
--
-- Why NO body-inspecting upload service (the §10.1 reversal — was: a sole-writer
-- Edge Function): a storage.objects policy/trigger can only ever see object
-- METADATA (path/owner/size), never the body bytes — the bytes live in S3 and
-- storage.objects is just a metadata row. So an E2EE `encb:v1:` ciphertext
-- shape-check cannot live in the database, and cannot be enforced on a direct
-- write at all; the only place it could run is a service that receives the
-- bytes and is the SOLE writer. We deliberately do NOT pay that (a per-upload
-- Edge Function on the write path) because the byte-confidentiality OUTCOME is
-- already closed downstream: the read side hash-verifies + AEAD-opens every
-- object (§5.1/§7.3) and fail-closes (broken-image placeholder, never plaintext
-- served). The only thing a write-time shape-guard adds is catching an HONEST
-- client that accidentally uploads plaintext — which an off-path periodic audit
-- (scripts/attachments-ciphertext-audit.mjs) turns into a loud alert without
-- sitting on the write path. The client encodes `encb:v1:` before upload (§9);
-- that is the byte-shape invariant. (A malicious writer holds the workspace key
-- and trivially forges an 8-byte magic prefix, so a write-time guard was never
-- an anti-malice control — see §17.)
--
-- storage.objects already has RLS enabled (owned by supabase_storage_admin);
-- we only add policies.

-- ── private-schema access for the policy's querying role (§10 warn box) ──────
-- The policies below call private.is_workspace_member / is_workspace_writer
-- (SECURITY DEFINER, search_path=''). An RLS USING / WITH CHECK expression runs
-- as the QUERYING role (authenticated), which therefore needs USAGE on `private`
-- + EXECUTE on those helpers. The consolidated baseline migration owns those
-- grants (added in "fix(supabase): make consolidated baseline replayable on
-- fresh PG17"), and this migration always runs after it — so they are
-- intentionally NOT repeated here, keeping a single owner for the grant. The new
-- INSERT policy uses the same is_workspace_writer the DELETE policy already does,
-- so it rides the same proven grant; no new grant is needed.

-- ── why this migration is guarded ───────────────────────────────────────────
-- storage.buckets / storage.objects are created by the Storage SERVICE, not by
-- the database image. On the hosted project (and any `db push`) they already
-- exist, so this provisions the bucket + policies. On a local `supabase start`
-- the Storage container boots AFTER user migrations run, so at apply time the
-- `storage` SCHEMA exists but its TABLES do not — referencing them unguarded
-- fails with `relation "storage.buckets" does not exist` and aborts the whole
-- bring-up. We guard on the table's presence and no-op when it is absent, so
-- `supabase start` succeeds on every stack while the bucket + policies still
-- apply on `db push`.
--
-- For LOCAL development the bucket is declared in config.toml
-- ([storage.buckets.attachments]) so the Storage service creates it on start
-- (config.toml cannot declare storage.objects RLS policies — those are applied
-- by this migration on `db push`, or run manually against the local stack once
-- Storage is up when exercising RLS locally).
--
-- CREATE POLICY runs through EXECUTE (dynamic SQL) so it is parsed only at run
-- time, inside the guard. No DROP POLICY is added — a migration applies once in
-- a transaction, and adding a DROP would need ownership `postgres` lacks.
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice
      'attachments: storage schema not initialised yet — skipping bucket + policies (applies on db push / once Storage is up)';
    return;
  end if;

  -- the bucket (PRIVATE; never public — E2EE bytes must not be world-readable).
  -- file_size_limit is the server-side hard ceiling (50 MiB), well above the
  -- client's ~10 MB capture cap (§11/§16); it replaces the old Edge Function's
  -- in-isolate MAX_UPLOAD_BYTES backstop now that uploads are direct.
  insert into storage.buckets (id, name, public, file_size_limit)
  values ('attachments', 'attachments', false, 52428800)
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

  -- RLS: insert by workspace writer (direct upload). First-write-wins is the
  -- absence of an UPDATE policy (above): a re-upload to an existing content path
  -- is a Storage 409 the client reads as idempotent dedup, never an overwrite.
  execute $pol$
    create policy "attachments insert by workspace writer"
    on storage.objects for insert to authenticated
    with check (
      bucket_id = 'attachments'
      and private.is_workspace_writer((storage.foldername(name))[1], (auth.uid())::text)
    )
  $pol$;

  -- RLS: delete by workspace writer (§16 GC + §10.1 poison-correction).
  execute $pol$
    create policy "attachments delete by workspace writer"
    on storage.objects for delete to authenticated
    using (
      bucket_id = 'attachments'
      and private.is_workspace_writer((storage.foldername(name))[1], (auth.uid())::text)
    )
  $pol$;
end $$;
