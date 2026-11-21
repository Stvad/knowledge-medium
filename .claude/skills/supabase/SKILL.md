---
name: supabase
description: Supabase CLI ops for this project — write/inspect migrations, push them to the linked Supabase project (`npx supabase db push`), and query the linked remote DB. Use for Supabase migrations, `db push` / `db pull` / `db query`, or schema changes to PowerSync-synced tables. (Deploying the PowerSync sync rules is the separate `powersync` skill.)
---

# Supabase ops

The repo is linked to a hosted Supabase project (and a PowerSync cloud instance — see the `powersync` skill for sync-rule deploys). Local Supabase (Docker-based) is not running by default; for normal schema work you don't need it.

## Supabase CLI

`supabase` is **not installed globally** — always invoke as `npx supabase ...` (auto-installs on first use).

```bash
npx supabase migration list                       # local vs remote migration timestamps
npx supabase db push                              # apply pending local migrations to remote
npx supabase db pull                              # pull remote schema into a new migration (rare)
npx supabase db query --linked "SELECT ..."       # run SQL against the linked remote DB
npx supabase db query --linked --output table ... # human-friendly output
```

## Using in a fresh git worktree

Migration / DB commands need the linked-project state in **`supabase/.temp/`** (gitignored), so a fresh worktree isn't linked — `migration list --linked` / `db push` fail with *"Cannot find project ref. Have you run supabase link?"*. Mirror it from the main checkout (copy, don't read its contents):

```bash
mkdir -p supabase/.temp && cp -n <main-checkout>/supabase/.temp/* supabase/.temp/
```

(or `npx supabase link --project-ref <ref>`). The login access token is stored globally, so it carries across worktrees.

## PowerSync

Deploying the sync rules (`powersync/sync-config.yaml`) to PowerSync Cloud is the **separate `powersync` skill** — `npx powersync@latest validate / deploy --skip-validations=connections`, with its own worktree gotcha (`powersync/cli.yaml`). Use it whenever you change what syncs.

## Adding a column to a synced table — three-layer change

`blocks`, `workspaces`, `workspace_members` are PowerSync-synced. A new column needs:

1. **Postgres migration** (`supabase/migrations/<UTC>_<verb>_<noun>.sql`) — additive (`add column if not exists`), with a `default` for non-null columns. Wrap in `begin; … commit;`.
2. **Local SQLite + raw-table mapping** — add to `BLOCK_STORAGE_COLUMNS` (or `WORKSPACE_COLUMNS` / `WORKSPACE_MEMBER_COLUMNS`) in `src/data/blockSchema.ts` / `workspaceSchema.ts`, plus parse helpers and the `BlockRow`/`WorkspaceRow`/etc. types.
3. **`BlockData` / `Workspace` / `WorkspaceMembership`** in `src/types.ts`.

Then run `pnpm gen:sync-config` — it regenerates `powersync/sync-config.yaml` from the TS column lists, so the sync-stream SELECT can't drift from the local-SQLite shape. **Don't hand-edit the YAML** — `pnpm run check` runs `check:sync-config` and will fail CI on hand-edits.

For dev databases that already exist, also add an `ALTER TABLE … ADD COLUMN` block in `repoInstance.ts` after `CREATE_BLOCKS_TABLE_SQL` (use `PRAGMA table_info(blocks)` to no-op when the column is already present).

## Writing migrations

- Always **additive** (`add column if not exists`, `create index if not exists`). Never edit an applied migration — write a follow-up.
- For new non-null columns, always specify a `default` so existing rows backfill cleanly.
- Wrap in `begin; … commit;`.

## Creating tables on the hosted DB — RLS is non-negotiable

**Every table in the `public` schema is exposed via PostgREST, and Supabase grants `anon` + `authenticated` full CRUD on public tables by default.** `CREATE TABLE` / `CREATE TABLE AS` do **not** enable RLS, so a freshly-created public table is **immediately world-readable and -writable with the anon key** (which ships in the client bundle) until you lock it down. This bit us once: an ad-hoc `blocks_ts_backup_*` snapshot (block ids + timestamps) sat in `public` with no RLS.

This applies to **ad-hoc / backup / snapshot / staging tables created via `db query` or `psql`**, not just app tables in migrations. Whenever you create a table on the hosted project:

```sql
begin;
create table public.my_helper as select ...;          -- or create table public.my_helper (...)
alter table public.my_helper enable row level security; -- RLS on, NO policy = default-deny to anon/authenticated
revoke all on public.my_helper from anon, authenticated; -- defense-in-depth; harmless if RLS is on
commit;
```

- A table that **no client should ever touch** (backups, staging) wants exactly this: RLS on, **no policy** (denies anon/authenticated entirely), grants revoked. The owning `postgres` role and `service_role` still bypass RLS for server-side work.
- For client-facing data, RLS on **plus** the appropriate policies — never RLS-off.
- Alternative for pure internal helpers: create them in a schema PostgREST doesn't expose (not in the project's exposed-schemas list) instead of `public`.

After any ad-hoc table creation or schema change on the hosted DB, **verify nothing is left exposed** — this should return zero rows:

```sql
select c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
```

(This is the same check Supabase's Security Advisor runs. To attribute past access to such a table, group `pg_stat_statements` by `userid` → role: any `anon`/`authenticated` rows referencing the table mean external API access actually happened.)

## Don't push/deploy to remote without explicit user approval

`supabase db push` and `npx powersync@latest deploy` both mutate shared state. Author the change locally, validate, and then **stop**. Wait for the user to say "push it" / "deploy it" for that specific run — pre-authorization for one push doesn't extend to the next.

For destructive operations (drop column/table, drop function with dependents) describe what will happen and get explicit go even on top of a generic "go ahead."

## Don't reach for these without asking

- `supabase db reset` — drops and re-applies all migrations (wipes data, requires Docker)
- `supabase start` / `supabase stop` — local stack, requires Docker
- Editing an already-applied migration file
