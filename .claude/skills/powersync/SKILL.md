---
name: powersync
description: PowerSync CLI ops for this project — validate and deploy sync rules (powersync/sync-config.yaml) to the linked PowerSync Cloud instance. Use when deploying sync-rule / sync-config changes, running `powersync validate` or `powersync deploy`, changing which columns/streams get synced, or fixing PowerSync CLI link/auth errors ("Linking is required before using this command").
---

# PowerSync CLI ops

The repo is linked to a hosted **PowerSync Cloud** instance. The CLI is **not installed globally** — always invoke as `npx powersync@latest ...` (auto-installs on first use).

## Deploy sync rules

```bash
npx powersync@latest validate --skip-validations=connections   # validate sync-config.yaml + schema locally
npx powersync@latest deploy   --skip-validations=connections   # deploy sync config to PowerSync Cloud
```

- **`--skip-validations=connections` is required** — the local env has no `PS_DATABASE_URI` (it's a server-side secret), so the live-connection test can't run. Schema + sync-config validations still run.
- `deploy` schedules the deployment, waits for it to go live (default 300 s), and triggers connected clients to re-sync.

### Deploy timeout ≠ failure

`deploy` can exit with **"Deployment did not complete within 300 seconds. Check instance status and try again."** even when the deployment *succeeded* — that's the CLI's wait-for-go-live timing out, not a rejection (validations already passed at that point). **Verify the real state instead of blindly retrying:**

```bash
npx powersync@latest fetch config   # prints the LIVE deployed config — grep for your change
```

If the deployed sync rules already reflect your change, you're done. If not, retry with a longer wait: `npx powersync@latest deploy --skip-validations=connections --deploy-timeout=600`.
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
