# Knowledge Medium

**A malleable, offline-first medium for knowledge work.** &nbsp;·&nbsp; [**Try the live version →**](https://stvad.github.io/knowledge-medium/)

A Roam/Workflowy-like outliner where *everything is a block and everything is an
extension* — notes, daily notes, settings, even the renderers that draw the
screen. The app is a thin host that assembles itself from those blocks at
runtime, so you can reshape it from inside. It runs in the browser as an
installable PWA, is local-first (instant, offline-capable), and syncs across
devices via PowerSync + Supabase.

---

## What makes it different

- **One universal data model.** There is exactly one node type. A single
  `blocks` table holds pages, daily notes, todos, flashcards, places, settings,
  and renderer source — distinguished only by their (multi-valued) `types` and
  typed properties. Nesting, ordering (via fractional indices), references, and
  backlinks all work the same way for every kind of block.

- **The whole app is extensions.** The default block renderer, the vim plugin,
  daily notes, find-and-replace, maps — all of it ships as facet-based
  extensions. You can author your own: write a TS/JSX module in a block typed
  `extension`, enable it from Extensions settings, and it's compiled and loaded
  live (Babel-in-the-browser) with error boundaries around it. No build step, no
  redeploy.

- **State lives in the document.** Rather than hiding configuration in
  app-specific stores, Knowledge Medium stores UI state, user preferences,
  keyboard bindings, and block behavior *as blocks* — so your setup syncs,
  versions, and is inspectable like any other content. Credentials and secrets
  are the deliberate exception and stay out of the document.

- **Local-first, genuinely offline.** Reads and writes hit a local SQLite
  mirror (`wa-sqlite` in IndexedDB) first, so the app stays fast and usable with
  no network. PowerSync streams changes to and from hosted Postgres (Supabase)
  in the background, converging your devices when connectivity returns.

- **Typed properties and user-defined types.** Properties are typed key/value
  pairs with codecs and change-scopes; types are multi-valued and can be
  user-defined (a type is itself just a block). This is what lets a plain
  outline grow domain structure — tasks, spaced-repetition cards, places — without
  schema migrations.

- **Scriptable from your terminal.** A first-class runtime bridge lets coding
  agents and scripts run commands *inside the live app* — same `Repo`, same
  workspace, same SQLite, same resolved extensions — to query, mutate, or drive
  the workspace programmatically.

---

## A tour of what's inside

The fastest way to learn the app is the built-in **`[[Tutorial]]`** page, seeded
into every fresh workspace (it links to a `[[Tutorial (no vim)]]` variant for
mouse/arrow-key users). The highlights:

- **Outlining.** Bullets are blocks; blocks nest. Fold, indent/outdent, drag,
  zoom into any block (treat it as the root of the view), and move around with
  vim keys or arrow keys.
- **Pages, links & embeds.** `[[Wiki links]]` link to (or create) pages; a
  block ref `((id))` points at one specific block anywhere; an embed `!((id))`
  renders that block — and its children — inline.
- **Backlinks.** Every reference is indexed, so each page shows who links to it,
  with a grouped-references view that organizes backlinks by their surrounding
  context.
- **Side panels & multi-select.** Open blocks side by side, each with its own
  focus and zoom; modifier-clicks route links into new panels or a sidebar
  stack. Select multiple blocks and apply any block-level action at once.
- **Search.** QuickFind matches page names first, then block content, with
  full-text search (required words, `"exact phrases"`, `OR`, `-exclusions`) and a
  workspace-wide find-and-replace.
- **Daily notes.** A journal of date-titled pages is the default landing page,
  with quick capture into today's note from anywhere.
- **Properties & types.** Attach typed properties to any block; tag blocks with
  built-in or user-defined types to give them behavior.
- **Places & maps.** Real-world locations are first-class Place blocks (backed
  by Google Places). Type `@` to drop a location, share one Place across many
  notes, and tag any block `map` to render an inline map of every place in its
  subtree.
- **Tasks & spaced repetition.** Todos and SM-2.5 flashcards are just typed
  blocks with scheduling in their properties — review cards land on the daily
  note that's due.
- **Roam import, themes, mobile.** Import an existing Roam graph, switch themes,
  and use it as a touch-first PWA with a mobile keyboard toolbar and bottom nav.

Everything above is an extension you can toggle, study, or replace — see the
seeded **`[[extensions]]`** page for working examples and a renderer demo.

---

## Supabase + PowerSync Setup

This repo expects:
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

### Local Database Migration Tests

Run the SQL migration test suite with:

```bash
yarn check:db
```

This starts a local Supabase Postgres test container, applies
`supabase/migrations/*.sql` as `supabase_admin`, runs every pgTAP test in
`supabase/tests`, and then removes the test database container so the next run
starts clean. It is not part of `yarn check`; the pre-commit gate stays JS-only
and does not require a container runtime.

For Apple Container, install `container` and `socktainer`. `yarn check:db`
uses the shared runtime helper and starts the Apple container system plus a
managed Socktainer process when `DOCKER_HOST` is unset:

```bash
yarn check:db
```

The runtime helper is also available directly:

```bash
yarn db:runtime:apple
```

That starts Apple Container/Socktainer and prints the Docker host it prepared.
If `DOCKER_HOST` is already set, `yarn check:db` respects it. To force the
default Docker runtime, set `CHECK_DB_CONTAINER_RUNTIME=docker`.

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

For an agent-facing orientation to the data model, run `yarn agent data-model`.

By default the bridge uses `http://127.0.0.1:8787`. The bridge secret is stored in the local config file (`~/.config/knowledge-medium/agent-bridge.json` by default), so pairing is normally one-time per browser profile and app origin. Run `yarn agent pair-url` or foreground the relay with `yarn agent:server` to get a bridge-only pairing URL. Override the pairing target with `AGENT_RUNTIME_APP_URL`, the browser endpoint with `VITE_AGENT_RUNTIME_URL`, and the CLI endpoint with `AGENT_RUNTIME_URL`.

The bridge only accepts browser origins from loopback hosts and configured app origins. Add comma-separated entries with `AGENT_RUNTIME_ALLOWED_ORIGINS`; browser origins do not include URL paths, so GitHub Pages is allowed as `https://stvad.github.io`. Detailed `/health` output requires the bridge secret header; the CLI reads the persisted local secret automatically for `yarn agent status`.

---

## Development

```bash
yarn dev      # start the app (Vite)
yarn check    # the verification gate: typecheck, lint, and tests
yarn build    # production build
```

See [`AGENTS.md`](./AGENTS.md) for verification, testing, and contribution
conventions, and [`docs/`](./docs) for design notes (treat these as dated
intent — the code and tests are authoritative).

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

## License

This repository is licensed under the [Elastic License 2.0](./LICENSE). In
short: you can use, copy, modify, and self-host the software freely; you may
**not** offer it to third parties as a hosted or managed service that
replicates a substantial part of its functionality.

The `packages/agent-cli` sub-package is licensed separately under the
[MIT License](./packages/agent-cli/LICENSE) so it can be used as an open
integration surface by third-party tooling.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for contribution terms, including
the license grant that preserves the project's ability to relicense future
versions.
