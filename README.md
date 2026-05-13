# Malleable Thought Medium

## Supabase + Electric Setup

This repo now expects:
- Supabase hosted Postgres for the source database
- Supabase Auth for app sessions (email OTP, with anonymous as a fallback)
- Electric Cloud for shape streams into local SQLite, reached through an app-owned shape proxy

Sign-in flow:
- Primary: enter your email, Supabase emails a 6-digit code, type it back in the app
- Fallback: "Continue without an account" button performs an anonymous sign-in (per-device session, can't invite or be invited until you sign in with email)

### One-Time Setup

1. Create a local env file from `.env.example`.
2. Log into Supabase:

```bash
npx supabase login
```

3. Create a hosted project, then link this repo to it:

```bash
npx supabase orgs list
npx supabase projects create knowledge-medium --org-id <org-id> --region us-west-1 --db-password <db-password>
npx supabase link --project-ref <project-ref> --password <db-password>
```

4. Push the committed schema and auth config:

```bash
npx supabase db push
npx supabase config push
```

5. Fill client env vars:
   - `VITE_SUPABASE_URL`: Supabase project URL
   - `VITE_SUPABASE_ANON_KEY`: Supabase publishable / anon key

6. Create an Electric Cloud source connected to the Supabase Postgres database. The committed migrations add `blocks.write_id` and set `REPLICA IDENTITY FULL` on the synced tables so Electric can emit full update/delete rows.

7. Deploy the Supabase Edge shape proxy in front of Electric Cloud:

```bash
supabase secrets set ELECTRIC_URL=https://api.electric-sql.cloud
supabase secrets set ELECTRIC_SOURCE_ID=<electric-source-id>
supabase secrets set ELECTRIC_SOURCE_SECRET=<electric-source-secret>
# Optional: restrict browser origins instead of the default "*"
supabase secrets set ELECTRIC_SHAPE_ALLOWED_ORIGINS=https://your-app.example.com
supabase functions deploy electric-shape
```

If your Supabase project does not automatically expose `SUPABASE_URL` and `SUPABASE_ANON_KEY` to Edge Functions, set those as function secrets too.

The proxy provides three named endpoints:
   - `/blocks`
   - `/workspaces`
   - `/workspace_members`

   The browser sends the Supabase access token as `Authorization: Bearer <jwt>`. The proxy validates that token through Supabase PostgREST, keeps the Electric source secret server-side, and enforces the table/workspace predicates server-side instead of accepting arbitrary table or SQL params from the browser.

8. Fill the remaining env var:
   - `VITE_ELECTRIC_SHAPE_PROXY_URL`: base URL for that shape proxy, without a trailing shape name. For the Supabase Edge deployment, this is usually `https://<project-ref>.functions.supabase.co/electric-shape` or `https://<project-ref>.supabase.co/functions/v1/electric-shape`.

9. Start the app:

```bash
yarn dev
```

### Notes

- Local writes land in the durable SQLite `outbox` table and upload through Supabase. Electric owns the ordered read path back into SQLite.
- The `write_id` column on `blocks` lets the Electric subscriber skip echoes while the matching outbox row is still pending.
- Because the starter graph is seeded in the remote database, the app will now wait briefly for the first remote sync before falling back to local example data.

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
