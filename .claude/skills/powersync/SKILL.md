---
name: powersync
description: PowerSync CLI ops for this project — validate and deploy sync rules (powersync/sync-config.yaml) to the linked PowerSync Cloud instance. Use when deploying sync-rule / sync-config changes, running `powersync validate` or `powersync deploy`, changing which columns/streams get synced, or fixing PowerSync CLI link/auth errors ("Linking is required before using this command").
---

# PowerSync CLI ops

The repo is linked to a hosted **PowerSync Cloud** instance. The CLI is **not installed globally** — always invoke as `npx powersync@latest ...` (auto-installs on first use).

## Deploy sync rules (the common case)

For a sync-rule / sync-config change, deploy **only the sync config** — use the `sync-config` subcommand, NOT a bare `deploy`:

```bash
npx powersync@latest validate --skip-validations=connections   # validate sync-config.yaml + schema locally
npx powersync@latest deploy sync-config                         # deploy ONLY the sync rules
```

- `deploy sync-config` touches only the sync rules — **not** the source-DB connection or auth — so it's safe to run with no `PS_DATABASE_URI` in your env. This is what you want ~always.
- `validate`'s `--skip-validations=connections` is required because the local env has no `PS_DATABASE_URI` (server-side secret), so the live-connection test can't run; schema + sync-config validations still run.
- It schedules the deployment, waits for it to go live (default 300 s), and triggers connected clients to re-sync.

## ⚠️ NEVER run a bare `powersync deploy` without `PS_DATABASE_URI`

A full `npx powersync@latest deploy` re-deploys the **service config** too (`powersync/service.yaml`), whose connection is `uri: !env PS_DATABASE_URI`. The CLI resolves `!env` against your **local shell**, where `PS_DATABASE_URI` is normally unset (it's a server-side secret). So a bare full deploy pushes an **empty connection URI and clobbers the source-DB connection config.**

Symptom (real incident 2026-06-03, diagnosed with PowerSync's maintainer): steady-state replication keeps running on the last-good connection, but **every subsequent `deploy` AND `compact` fails** with a generic *"Deploy failed / Operation failed. Check instance diagnostics… check your network connection."* — and `--skip-validations=connections` **hides** it by skipping the `Test Connections` check that would have caught the empty URI. The instance looks healthy in `status` the whole time.

If you genuinely need a full deploy (to set up or **repair** the connection):

1. Load `PS_DATABASE_URI` into the deploy process from the local `.env.local` **without echoing it** (inject into the child env; redact it from any captured output).
2. Run `npx powersync@latest deploy` **without** `--skip-validations=connections`, so `Test Connections ✓` actually validates the URI before it's pushed.

Recovery if the connection is already clobbered: re-run a full deploy with `PS_DATABASE_URI` set (Test Connections must pass) — that re-pushes a working connection — or fix it in the dashboard under **Database Connections**.

### Deploy timeout ≠ failure

`deploy` can exit with **"Deployment did not complete within 300 seconds. Check instance status and try again."** even when the deployment *succeeded* — that's the CLI's wait-for-go-live timing out, not a rejection (validations already passed at that point). **Verify the real state instead of blindly retrying:**

```bash
npx powersync@latest fetch config   # prints the LIVE deployed config — grep for your change
```

If the deployed sync rules already reflect your change, you're done. If not, retry with a longer wait: `npx powersync@latest deploy sync-config --deploy-timeout=600`.
- **`powersync/sync-config.yaml` is GENERATED** by `yarn gen:sync-config` from the TS column lists (`src/data/blockSchema.ts` / `workspaceSchema.ts`). **Never hand-edit it** — `yarn check` runs `check:sync-config` and fails on hand-edits.
- A synced-column change is a three-layer change (Postgres migration + local SQLite raw-table mapping + `src/types.ts`) — see the `supabase` skill.

## Using in a fresh git worktree

The CLI link state is **`powersync/cli.yaml`** (the linked instance / org / project IDs) and it is **gitignored**, so a fresh worktree won't have it — `validate` / `deploy` then fail with:

> Error: Linking is required before using this command.

Fix: mirror it from the main checkout (copy, don't read its contents):

```bash
cp <main-checkout>/powersync/cli.yaml powersync/cli.yaml
```

(or `npx powersync@latest link cloud` to re-link interactively). The Cloud auth **token** is stored globally by `npx powersync@latest login` — separate from `cli.yaml`, so it carries across worktrees.

`powersync/service.yaml` is the connection/auth config (`uri: !env PS_DATABASE_URI`, `client_auth.supabase: true`); it rarely changes — the sync rules are what you usually deploy.

## Don't deploy without explicit user approval

`npx powersync@latest deploy` mutates shared Cloud state and re-syncs every client. Author the change, `validate`, then **stop** and wait for the user to say "deploy it" for that specific run — one approval doesn't carry to the next deploy. (Same rule as `supabase db push`; see the `supabase` skill.)
