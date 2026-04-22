create table if not exists public.blocks (
  id text primary key,
  content text not null default '',
  properties_json text not null default '{}',
  child_ids_json text not null default '[]',
  parent_id text,
  create_time bigint not null,
  update_time bigint not null,
  created_by_user_id text not null,
  updated_by_user_id text not null,
  references_json text not null default '[]'
);

create index if not exists idx_blocks_parent_id
  on public.blocks (parent_id);

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.blocks to authenticated;

alter table public.blocks enable row level security;

drop policy if exists blocks_read_authenticated on public.blocks;
create policy blocks_read_authenticated
  on public.blocks
  for select
  to authenticated
  using (true);

drop policy if exists blocks_insert_authenticated on public.blocks;
create policy blocks_insert_authenticated
  on public.blocks
  for insert
  to authenticated
  with check (true);

drop policy if exists blocks_update_authenticated on public.blocks;
create policy blocks_update_authenticated
  on public.blocks
  for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists blocks_delete_authenticated on public.blocks;
create policy blocks_delete_authenticated
  on public.blocks
  for delete
  to authenticated
  using (true);

insert into public.blocks (
  id,
  content,
  properties_json,
  child_ids_json,
  parent_id,
  create_time,
  update_time,
  created_by_user_id,
  updated_by_user_id,
  references_json
) values
  (
    '00000000-0000-4000-8000-000000000001',
    'Welcome to Knowledge Medium',
    '{}',
    '["00000000-0000-4000-8000-000000000002","00000000-0000-4000-8000-000000000003","00000000-0000-4000-8000-000000000004"]',
    null,
    1745246400000,
    1745246400000,
    'system',
    'system',
    '[]'
  ),
  (
    '00000000-0000-4000-8000-000000000002',
    'This project now expects Supabase + PowerSync for shared storage.',
    '{}',
    '[]',
    '00000000-0000-4000-8000-000000000001',
    1745246400001,
    1745246400001,
    'system',
    'system',
    '[]'
  ),
  (
    '00000000-0000-4000-8000-000000000003',
    'Open the same graph in another browser after setup to verify live sync.',
    '{}',
    '[]',
    '00000000-0000-4000-8000-000000000001',
    1745246400002,
    1745246400002,
    'system',
    'system',
    '[]'
  ),
  (
    '00000000-0000-4000-8000-000000000004',
    'Anonymous Supabase auth is enabled for the lowest-friction dev setup.',
    '{}',
    '[]',
    '00000000-0000-4000-8000-000000000001',
    1745246400003,
    1745246400003,
    'system',
    'system',
    '[]'
  )
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1
    from pg_publication
    where pubname = 'powersync'
  ) then
    create publication powersync for table public.blocks;
  elsif not exists (
    select 1
    from pg_publication_tables
    where pubname = 'powersync'
      and schemaname = 'public'
      and tablename = 'blocks'
  ) then
    alter publication powersync add table public.blocks;
  end if;
end $$;
