# Malleable Thought Medium

## Supabase + PowerSync Setup

This repo now expects:
- Supabase hosted Postgres for the source database
- Supabase Auth for app sessions (email OTP, with anonymous as a fallback)
- PowerSync Cloud for syncing into local SQLite

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

6. Log into PowerSync and create a cloud instance:

```bash
npx powersync@latest login
npx powersync@latest link cloud --create --project-id <powersync-project-id>
npx powersync@latest validate
npx powersync@latest deploy
```

7. Fill the remaining env vars:
   - `PS_DATABASE_URI`: Supabase "Direct connection" URI copied from the Supabase Connect dialog
   - `VITE_POWERSYNC_URL`: PowerSync instance URL from the PowerSync dashboard / connect dialog

8. Start the app:

```bash
yarn dev
```

### Notes

- The fastest dev path is to use the Supabase direct connection URI as-is in `PS_DATABASE_URI`.
- For a hardened setup, create a dedicated `powersync_role` with replication privileges and replace the username/password in `PS_DATABASE_URI` before deploying PowerSync.
- Because the starter graph is seeded in the remote database, the app will now wait briefly for the first remote sync before falling back to local example data.

### Safe Mode
- Add `?safeMode` to URL to disable dynamic renderer loading
- Only default renderers will be used
- Useful for debugging or when custom renderers are problematic

## Agent Runtime Access

The app exposes a first-class runtime bridge for coding agents. The browser app connects to a local relay, and agents submit commands to that relay from the terminal. Commands execute inside the live app runtime, with access to the current `Repo`, active workspace, PowerSync SQLite database, resolved runtime facets, block helpers, and arbitrary JavaScript execution.

Start the relay and the app:

```bash
yarn agent:server
yarn dev
```

Then use the CLI from another terminal:

```bash
yarn agent ping
yarn agent sql all "SELECT id, content FROM blocks LIMIT 5"
yarn agent create-block '{"parentId":"<block-id>","content":"Created by agent"}'
yarn agent eval 'return { workspaceId: repo.activeWorkspaceId, user: repo.user }'
```

Available runtime-code bindings include `repo`, `db`, `runtime`, `safeMode`, `sql`, `block`, `getBlock`, `getSubtree`, `createBlock`, `updateBlock`, `installExtension`, `actions`, `renderers`, `refreshAppRuntime`, `React`, `ReactDOM`, `window`, and `document`.

By default the bridge uses `http://127.0.0.1:8787`. Override the browser endpoint with `VITE_AGENT_RUNTIME_URL` and the CLI endpoint with `AGENT_RUNTIME_URL`.

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
