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
--     Storage requires UPDATE for EVERY overwrite verb — upsert (INSERT+SELECT+
--     UPDATE), move/rename (SELECT+UPDATE), and copy-onto-existing (the extra
--     UPDATE) — so with no UPDATE policy none of them can mutate an existing
--     object. A writer's only mutation is delete-then-insert (the accepted §17
--     poison), never a silent overwrite.
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
-- closed downstream: the read side (the Phase-3 resolver, §7.3 — not yet built;
-- now the sole byte-confidentiality control, so a hard acceptance gate)
-- hash-verifies + AEAD-opens every object (§5.1) and fail-closes (broken-image
-- placeholder, never plaintext served). The only thing a write-time shape-guard
-- adds is catching an HONEST
-- client that accidentally uploads plaintext — which an off-path periodic audit
-- (scripts/attachments-ciphertext-audit.ts) turns into a loud alert without
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
-- time, inside the guard. Each create is preceded by `drop policy if exists` so
-- the migration is RE-APPLIABLE: a bare CREATE POLICY aborts if the policy
-- already exists (the same "preexisting from ad-hoc/manual testing" case the
-- bucket converge above guards against), which would wedge the whole migration.
-- `postgres` CAN drop+recreate these: it is a MEMBER of supabase_storage_admin,
-- which OWNS storage.objects, and policy DDL requires table OWNERSHIP (not just
-- DML grants). Drop-then-create is the same convergence discipline the bucket's
-- `on conflict do update` uses.
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
  -- CONVERGE on conflict (don't just skip): if the bucket already exists from
  -- ad-hoc/manual testing, re-assert its security + functional config so the
  -- migration GUARANTEES the intended state, not whatever was left lying around.
  --   * public = false       — a leftover `true` would make every object
  --       world-readable via Storage's public URL path, bypassing the
  --       member-gated read policy entirely;
  --   * file_size_limit      — a looser/absent limit drops the upload backstop;
  --   * allowed_mime_types = NULL (accept any) — BlobStore.put always uploads
  --       application/octet-stream, so a stale allow-list omitting it would
  --       reject valid uploads; the real type is tracked on the media block
  --       (§11), not the bucket.
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('attachments', 'attachments', false, 52428800, null)
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  -- RLS: read by workspace member. Path's first segment = <workspace_id>.
  execute 'drop policy if exists "attachments read by workspace member" on storage.objects';
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
  -- The layout is FLAT: an object is exactly <workspace_id>/<content-key>, one
  -- folder level. `array_length(storage.foldername(name), 1) = 1` enforces that
  -- (foldername drops the filename; a flat name yields a 1-element array, a
  -- nested name 2+, a folderless name an empty array → NULL). Without it a writer
  -- could upload <ws>/sub/plaintext: RLS would still pass (first segment is their
  -- workspace), but the ciphertext audit's top-level listing skips nested
  -- entries, so plaintext could hide under an E2EE subfolder AND evade the audit.
  -- `right(name, 1) <> '/'` additionally rejects an EMPTY content-key (`<ws>/`,
  -- whose foldername is also a 1-element array so it would otherwise pass) —
  -- restoring the old upload guard's non-empty-key check (a junk plantable
  -- object, not content; the resolver keys on real content-key paths).
  execute 'drop policy if exists "attachments insert by workspace writer" on storage.objects';
  execute $pol$
    create policy "attachments insert by workspace writer"
    on storage.objects for insert to authenticated
    with check (
      bucket_id = 'attachments'
      and array_length(storage.foldername(name), 1) = 1
      and right(name, 1) <> '/'
      and private.is_workspace_writer((storage.foldername(name))[1], (auth.uid())::text)
    )
  $pol$;

  -- RLS: delete by workspace writer (§16 GC + §10.1 poison-correction).
  execute 'drop policy if exists "attachments delete by workspace writer" on storage.objects';
  execute $pol$
    create policy "attachments delete by workspace writer"
    on storage.objects for delete to authenticated
    using (
      bucket_id = 'attachments'
      and private.is_workspace_writer((storage.foldername(name))[1], (auth.uid())::text)
    )
  $pol$;
end $$;
