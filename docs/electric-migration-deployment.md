# ElectricSQL Migration and Deployment Summary

Status: shelved as of 2026-05-13. This branch contains the implementation and deployment notes, but the migration has not been deployed.

## Migration Shape

The proposed migration replaces PowerSync with Electric Cloud for the read path while keeping the app's data layer, local SQLite model, and Supabase-backed write path.

- Local SQLite is opened directly through `@journeyapps/wa-sqlite`.
- Local user writes still go through `repo.tx`, SQLite triggers, and the durable `outbox` table.
- The upload loop writes to Supabase and stamps each uploaded block row with `write_id`.
- Electric Cloud streams ordered Shapes for `blocks`, `workspaces`, and `workspace_members`.
- The local shape subscriber applies Electric rows into SQLite and skips local echoes while the matching `write_id` is still pending in `outbox`.
- The browser never talks to Electric Cloud directly. It talks to the app-owned Supabase Edge Function proxy, which validates the Supabase bearer token and pins the allowed table, columns, and workspace predicate server-side.

## Important Files

- [README.md](../README.md) has the fresh Supabase + Electric deployment commands.
- [supabase/functions/electric-shape/shapeProxy.ts](../supabase/functions/electric-shape/shapeProxy.ts) is the Electric Shape proxy.
- [supabase/migrations/20260510222352_consolidated_initial.sql](../supabase/migrations/20260510222352_consolidated_initial.sql) is the fresh-project Supabase setup migration.
- [src/services/sync/shapeSubscriber.ts](../src/services/sync/shapeSubscriber.ts) consumes Electric Shapes into local SQLite.
- [src/services/upload.ts](../src/services/upload.ts) owns the outgoing write loop.
- [src/data/internals/clientSchema.ts](../src/data/internals/clientSchema.ts) defines the local `outbox`, tx context, row events, and upload triggers.
- [docs/follow-ups.md](follow-ups.md) tracks the production follow-up for dynamic workspace membership changes.

## Deployment Guide

Use this only for a new Supabase project. The migration history has been squashed into a general initial migration; applying it to an existing deployed migration history requires repairing Supabase's migration table first.

1. Create and link the Supabase project with `npx supabase projects create` and `npx supabase link`.
2. Set the production app origin in `supabase/config.toml` before pushing auth config.
3. Push Supabase schema and config:

```bash
npx supabase db push --linked
npx supabase config push --project-ref <project-ref> --yes
```

4. Create an Electric Cloud Postgres Sync service connected to the Supabase direct Postgres connection string. Use the direct database URL for logical replication, not the transaction pooler.
5. Put Electric and Supabase proxy secrets in a local ignored file such as `.env.supabase-edge`, then set them with:

```bash
npx supabase secrets set --env-file .env.supabase-edge --project-ref <project-ref>
```

6. Deploy the Supabase Edge proxy:

```bash
npx supabase functions deploy electric-shape --project-ref <project-ref>
```

7. Configure frontend env:

```dotenv
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-or-publishable-key>
VITE_ELECTRIC_SHAPE_PROXY_URL=https://<project-ref>.supabase.co/functions/v1/electric-shape
```

8. Run `yarn run check`, deploy the frontend through the normal host, then smoke test sign-in, create/edit, reload persistence, and live cross-session sync.

## Secret Handling

- Do not put database URLs, Electric source secrets, or service-role keys in committed files.
- Do not run setup commands with `--debug` when secrets are in environment variables.
- Prefer `supabase secrets set --env-file` over passing secret values inline.
- The frontend must only receive `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_ELECTRIC_SHAPE_PROXY_URL`.

## Known Caveats Before Unshelving

- Dynamic membership freshness: existing Electric streams are scoped by the workspace IDs visible when the stream starts. V1 can tolerate reload-after-join; production should restart the subscriber after create/accept membership flows or implement a more dynamic proxy/client shape strategy.
- Electric Cloud source setup still needs live credentials from the Supabase project and should be done in a private terminal.
- The current backend remains Supabase-first. Moving Postgres to Neon would require replacing or bridging Supabase Auth, RLS/PostgREST authorization in the proxy, RPCs, and Edge Functions, so it is not part of this shelved migration.
- Fresh local databases are expected because the local SQLite filename/version was bumped for the Electric path.

## Unshelving Checklist

- Rebase the branch and rerun `yarn run check`.
- Reconfirm Supabase CLI and Electric CLI command shapes with `--help`.
- Create a throwaway Supabase project and run the README deployment sequence end to end.
- Verify the proxy endpoints with a real Supabase user token.
- Run a two-browser smoke test for cross-session edits.
- Decide whether reload-after-join is acceptable for the first rollout.
