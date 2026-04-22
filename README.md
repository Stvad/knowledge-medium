# Malleable Thought Medium

## Supabase + PowerSync Setup

This repo now expects:
- Supabase hosted Postgres for the source database
- Supabase Auth for app sessions
- PowerSync Cloud for syncing into local SQLite

The committed config is optimized for the lowest-friction dev setup:
- anonymous Supabase auth is enabled
- the PowerSync stream auto-subscribes the full `public.blocks` table
- the remote database is seeded with a starter block tree by the Supabase migration

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
