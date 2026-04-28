---
name: supabase
description: Supabase + PowerSync CLI cheatsheet for this project. Use when writing or inspecting Supabase migrations, querying the linked Supabase DB, or changing what columns get synced via PowerSync.
disable-model-invocation: true
---

# Supabase + PowerSync ops

The repo is linked to a hosted Supabase project AND a PowerSync cloud instance. Local Supabase (Docker-based) is not running by default; for normal schema work you don't need it.

## Supabase CLI

`supabase` is **not installed globally** — always invoke as `npx supabase ...` (auto-installs on first use).

```bash
npx supabase migration list                       # local vs remote migration timestamps
npx supabase db push                              # apply pending local migrations to remote
npx supabase db pull                              # pull remote schema into a new migration (rare)
npx supabase db query --linked "SELECT ..."       # run SQL against the linked remote DB
npx supabase db query --linked --output table ... # human-friendly output
```

## PowerSync CLI

```bash
npx powersync@latest validate                                # validate sync-config.yaml locally
npx powersync@latest deploy --skip-validations=connections   # deploy sync-config to PowerSync cloud
```

`--skip-validations=connections` is needed because the local env has no `PS_DATABASE_URI` (it's a server-side secret). Schema + sync-config validations still run.

## Adding a column to a synced table — three-layer change

`blocks`, `workspaces`, `workspace_members` are PowerSync-synced. A new column needs:

1. **Postgres migration** (`supabase/migrations/<UTC>_<verb>_<noun>.sql`) — additive (`add column if not exists`), with a `default` for non-null columns. Wrap in `begin; … commit;`.
2. **Local SQLite + raw-table mapping** — add to `BLOCK_STORAGE_COLUMNS` (or `WORKSPACE_COLUMNS` / `WORKSPACE_MEMBER_COLUMNS`) in `src/data/blockSchema.ts` / `workspaceSchema.ts`, plus parse helpers and the `BlockRow`/`WorkspaceRow`/etc. types.
3. **`BlockData` / `Workspace` / `WorkspaceMembership`** in `src/types.ts`.

Then run `yarn gen:sync-config` — it regenerates `powersync/sync-config.yaml` from the TS column lists, so the sync-stream SELECT can't drift from the local-SQLite shape. **Don't hand-edit the YAML** — `yarn check` runs `check:sync-config` and will fail CI on hand-edits.

For dev databases that already exist, also add an `ALTER TABLE … ADD COLUMN` block in `repoInstance.ts` after `CREATE_BLOCKS_TABLE_SQL` (use `PRAGMA table_info(blocks)` to no-op when the column is already present).

## Writing migrations

- Always **additive** (`add column if not exists`, `create index if not exists`). Never edit an applied migration — write a follow-up.
- For new non-null columns, always specify a `default` so existing rows backfill cleanly.
- Wrap in `begin; … commit;`.

## Don't push/deploy to remote without explicit user approval

`supabase db push` and `npx powersync@latest deploy` both mutate shared state. Author the change locally, validate, and then **stop**. Wait for the user to say "push it" / "deploy it" for that specific run — pre-authorization for one push doesn't extend to the next.

For destructive operations (drop column/table, drop function with dependents) describe what will happen and get explicit go even on top of a generic "go ahead."

## Don't reach for these without asking

- `supabase db reset` — drops and re-applies all migrations (wipes data, requires Docker)
- `supabase start` / `supabase stop` — local stack, requires Docker
- Editing an already-applied migration file
