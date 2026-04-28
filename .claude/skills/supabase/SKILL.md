---
name: supabase
description: Supabase CLI cheatsheet for this project. Use when writing or inspecting Supabase migrations, or running `supabase` commands.
disable-model-invocation: true
---

# Supabase ops

The repo is linked to a hosted Supabase project. Local Supabase (Docker-based) is not running by default; for normal schema work you don't need it.

## CLI

`supabase` is **not installed globally** — always invoke as `npx supabase ...` (auto-installs on first use).

```bash
npx supabase migration list   # show local vs remote migration timestamps
npx supabase db push          # apply pending local migrations to remote
npx supabase db pull          # pull remote schema into a new migration (rare)
```

## Writing a migration

- File: `supabase/migrations/<UTC-timestamp>_<verb>_<noun>.sql` (e.g. `20260428000000_add_blocks_deleted_column.sql`)
- Always **additive** (`add column if not exists`, `create index if not exists`). Never edit an applied migration — write a follow-up.
- For new non-null columns, always specify a `default` so existing rows backfill cleanly.
- Wrap in `begin; … commit;`.

## Don't push to remote without explicit user approval

`db push` mutates the shared hosted DB. Treat it like a deploy: only run it when the user directly asks ("push it", "apply the migration", "run db push"). Writing the migration file is fine; pushing it is not.

For destructive operations (drop column/table, drop function with dependents) get explicit authorization even with the user's go-ahead — describe what will happen first.

## Don't reach for these without asking

- `supabase db reset` — drops and re-applies all migrations (wipes data, requires Docker)
- `supabase start` / `supabase stop` — local stack, requires Docker
- Editing an already-applied migration file
