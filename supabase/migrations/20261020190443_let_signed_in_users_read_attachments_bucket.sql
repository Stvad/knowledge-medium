-- Signed-in users may read the attachments bucket's row, so a client can read
-- its file_size_limit: the attachment cleaner refuses a sealed object over the
-- limit instead of uploading it (#1339). Nothing else of the bucket is private.
--
-- Guarded like 20260625000000_add_attachments_storage.sql: on a local
-- `supabase start` the Storage tables do not exist yet at migration time.
-- supabase_storage_admin owns storage.buckets; `postgres` may still create a
-- policy on it through supautils.policy_grants.
do $$
begin
    if to_regclass('storage.buckets') is null then
        raise notice 'attachments: storage schema not initialised yet; skipping the bucket read policy';
        return;
    end if;

    drop policy if exists "attachments bucket readable by signed-in users" on storage.buckets;
    create policy "attachments bucket readable by signed-in users"
        on storage.buckets for select to authenticated
        using (id = 'attachments');
end $$;
