# Malleable Thought Medium

## Supabase + Electric Setup

This repo now expects:
- Supabase hosted Postgres for the source database
- Supabase Auth for app sessions (email OTP, with anonymous as a fallback)
- Electric Cloud for shape streams into local SQLite, reached through an app-owned shape proxy

Sign-in flow:
- Primary: enter your email, Supabase emails a 6-digit code, type it back in the app
- Fallback: "Continue without an account" button performs an anonymous sign-in (per-device session, can't invite or be invited until you sign in with email)

### Fresh Supabase + Electric Deployment

These steps are written for a new Supabase project. The migration history is squashed into `supabase/migrations/20260510222352_consolidated_initial.sql`; do not use this path against an already-applied production migration history without repairing Supabase's migration table first.

Keep secrets out of shell history and logs. Put real secret values in local ignored `.env.*` files or shell variables, do not run these commands with `--debug`, and do not paste CLI output that includes database URLs, source secrets, or service-role keys into chat.

1. Log in and pick the Supabase org:

```bash
npx supabase login
npx supabase orgs list --output json
```

2. Create and link the Supabase project. Store the generated database password in a password manager and pass it via a shell variable so it is not written literally into command history.

```bash
printf "Supabase DB password: "
read -rs SUPABASE_DB_PASSWORD
printf "\n"
npx supabase projects create knowledge-medium \
  --org-id <org-id> \
  --region us-west-1 \
  --db-password "$SUPABASE_DB_PASSWORD" \
  --output json
npx supabase link --project-ref <project-ref> --password "$SUPABASE_DB_PASSWORD" --yes
unset SUPABASE_DB_PASSWORD
```

3. Before pushing config, set the production app origin in `supabase/config.toml` under `[auth].site_url` and `additional_redirect_urls`. Keep the loopback URLs for local development.

4. Push the schema and Supabase config:

```bash
npx supabase db push --linked
npx supabase config push --project-ref <project-ref> --yes
```

The initial migration creates the workspace/block schema, RLS policies, RPCs, `blocks.write_id`, and `REPLICA IDENTITY FULL` on the Electric-synced tables. It does not create a PowerSync publication.

5. Get the browser-safe API key locally. The command may also show secret keys; copy only the anon/publishable key into frontend configuration and never use a service-role key in browser env.

```bash
npx supabase projects api-keys --project-ref <project-ref> --output json
```

6. Create an Electric Cloud Postgres Sync service connected to the Supabase database. The service needs a direct Supabase Postgres connection string for logical replication, not the transaction pooler. If using the Electric CLI, keep the DB URL in an environment variable:

```bash
npx @electric-sql/cli auth login
printf "Supabase direct DB URL: "
read -rs SUPABASE_DIRECT_DB_URL
printf "\n"
npx @electric-sql/cli projects create --name knowledge-medium --json
npx @electric-sql/cli environments create --project <electric-project-id> --name production --json
npx @electric-sql/cli services create postgres \
  --environment <electric-environment-id> \
  --database-url "$SUPABASE_DIRECT_DB_URL" \
  --region us-west-1 \
  --json
unset SUPABASE_DIRECT_DB_URL
npx @electric-sql/cli services get-secret <electric-service-id>
```

The Electric dashboard is fine for this step too. Either way, copy the service/source ID and secret into the Edge Function secret file below. `services get-secret` prints the source secret, so run it only in a private terminal. If Electric Cloud cannot reach the direct Supabase host over IPv6, enable Supabase's IPv4 add-on or choose a compatible direct connection option.

7. Create an ignored local file such as `.env.supabase-edge`:

```dotenv
ELECTRIC_URL=https://api.electric-sql.cloud
ELECTRIC_SOURCE_ID=<electric-source-id>
ELECTRIC_SOURCE_SECRET=<electric-source-secret>
ELECTRIC_SHAPE_ALLOWED_ORIGINS=https://your-app.example.com
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<anon-or-publishable-key>
```

Then set Edge Function secrets without putting secret values in the command line:

```bash
npx supabase secrets set --env-file .env.supabase-edge --project-ref <project-ref>
```

8. Deploy the Supabase Edge shape proxy:

```bash
npx supabase functions deploy electric-shape --project-ref <project-ref>
```

The proxy provides three named endpoints:
   - `/blocks`
   - `/workspaces`
   - `/workspace_members`

   The browser sends the Supabase access token as `Authorization: Bearer <jwt>`. The proxy validates that token through Supabase PostgREST, keeps the Electric source secret server-side, and enforces the table/workspace predicates server-side instead of accepting arbitrary table or SQL params from the browser.

9. Fill frontend env vars in `.env.local` or your frontend host's production env:
   - `VITE_SUPABASE_URL`: `https://<project-ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY`: Supabase anon/publishable key
   - `VITE_ELECTRIC_SHAPE_PROXY_URL`: base URL for the shape proxy, without a trailing shape name. For Supabase Edge, use `https://<project-ref>.supabase.co/functions/v1/electric-shape`.

10. Verify and start the app:

```bash
yarn run check
yarn dev
```

### Notes

- Local writes land in the durable SQLite `outbox` table and upload through Supabase. Electric owns the ordered read path back into SQLite.
- The `write_id` column on `blocks` lets the Electric subscriber skip echoes while the matching outbox row is still pending.
- Because the starter graph is seeded in the remote database, the app will now wait briefly for the first remote sync before falling back to local example data.
- V1 workspace membership changes can require a reload after join/create so the Electric shape streams reconnect with the expanded workspace set; the production fix is tracked in `docs/follow-ups.md`.

### Safe Mode
- Add `?safeMode` to URL to disable dynamic renderer loading
- Only default renderers will be used
- Useful for debugging or when custom renderers are problematic

## Agent Runtime Access

The app exposes a first-class runtime bridge for coding agents. The browser app connects to a local relay, and agents submit commands to that relay from the terminal. Commands execute inside the live app runtime, with access to the current `Repo`, active workspace, local SQLite database, resolved runtime facets, block helpers, and arbitrary JavaScript execution.

Start the app:

```bash
yarn dev
```

Then use the CLI from another terminal. If the local relay is not running, the CLI starts it in the background before submitting the command:

```bash
yarn agent connect
yarn agent ping
yarn agent sql all "SELECT id, content FROM blocks LIMIT 5"
yarn agent create-block '{"parentId":"<block-id>","content":"Created by agent"}'
yarn agent eval 'return { workspaceId: repo.activeWorkspaceId, user: repo.user }'
```

`yarn agent connect` prints an app URL, opens the token dialog when that URL is loaded, then waits for the copied token to be pasted back into the terminal. After that one-time pairing, normal `yarn agent ...` commands use the stored token automatically.

Available runtime-code bindings include `repo`, `db`, `runtime`, `safeMode`, `sql`, `block`, `getBlock`, `getSubtree`, `createBlock`, `updateBlock`, `installExtension`, `actions`, `renderers`, `refreshAppRuntime`, `React`, `ReactDOM`, `window`, and `document`.

By default the bridge uses `http://127.0.0.1:8787`. The bridge secret is stored in the local config file (`~/.config/knowledge-medium/agent-bridge.json` by default), so pairing is normally one-time per browser profile and app origin. Run `yarn agent pair-url` or foreground the relay with `yarn agent:server` to get a bridge-only pairing URL. Override the pairing target with `AGENT_RUNTIME_APP_URL`, the browser endpoint with `VITE_AGENT_RUNTIME_URL`, and the CLI endpoint with `AGENT_RUNTIME_URL`.

The bridge only accepts browser origins from loopback hosts and configured app origins. Add comma-separated entries with `AGENT_RUNTIME_ALLOWED_ORIGINS`; browser origins do not include URL paths, so GitHub Pages is allowed as `https://stvad.github.io`. Detailed `/health` output requires the bridge secret header; the CLI reads the persisted local secret automatically for `yarn agent status`.

---

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type aware lint rules:

- Configure the top-level `parserOptions` property like this:

```js
export default tseslint.config({
  languageOptions: {
    // other options...
    parserOptions: {
      project: ['./tsconfig.node.json', './tsconfig.app.json'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
})
```

- Replace `tseslint.configs.recommended` to `tseslint.configs.recommendedTypeChecked` or `tseslint.configs.strictTypeChecked`
- Optionally add `...tseslint.configs.stylisticTypeChecked`
- Install [eslint-plugin-react](https://github.com/jsx-eslint/eslint-plugin-react) and update the config:

```js
// eslint.config.js
import react from 'eslint-plugin-react'

export default tseslint.config({
  // Set the react version
  settings: { react: { version: '18.3' } },
  plugins: {
    // Add the react plugin
    react,
  },
  rules: {
    // other rules...
    // Enable its recommended rules
    ...react.configs.recommended.rules,
    ...react.configs['jsx-runtime'].rules,
  },
})
```
