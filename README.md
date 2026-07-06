# Knowledge Medium

**A malleable, offline-first medium for knowledge work.** &nbsp;·&nbsp; [**Try the live version →**](https://stvad.github.io/knowledge-medium/)

A Roam/Workflowy-like outliner where *everything is a block and everything is an
extension* — notes, daily notes, settings, even the renderers that draw the
screen. The app is a thin host that assembles itself from those blocks at
runtime, so you can reshape it from inside. It runs in the browser as an
installable PWA, is local-first (instant, offline-capable), and syncs across
devices via PowerSync + Supabase.

**The idea:** log in and you get an opinionated knowledge-management tool (think
Notion / Roam / Obsidian) you can be productive in immediately — but those
defaults are an *example, not a prescription*. They're assembled from a small set
of primitives, so you (or a coding agent on your behalf) can remix them into the
tool that fits how your mind works; "Notion" and "Roam" are just different views
over the same blocks. The hard, generic parts — sync, collaboration, offline,
storage, querying — are solved once and exposed as building blocks, so shaping
the app to you means composing components instead of rebuilding infrastructure.
(In the spirit of [malleable
software](https://www.inkandswitch.com/essay/malleable-software/).)

**What's different:** one universal `blocks` table for everything (pages, todos,
flashcards, places, settings, renderer source — set apart only by multi-valued
types + typed properties); the whole app is facet-based extensions you can author
live in-browser (no build step); config, prefs, and UI state live *in the
document* as blocks (so they sync and version with your notes); and a runtime
bridge lets agents/scripts drive the live app from your terminal.

**Features** (learn them in the built-in `[[Tutorial]]`): outlining with fold /
zoom / drag and vim or arrow-key motion · `[[wiki links]]`, block refs `((id))`,
inline embeds `!((id))`, and indexed backlinks · side panels + multi-select ·
QuickFind and workspace-wide find-and-replace · daily notes with quick capture ·
typed properties & user-defined types · first-class places & maps · todos and
SM-2.5 spaced repetition · Roam import, themes, and a touch-first mobile UI.

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

Available runtime-code bindings include `repo`, `db`, `runtime`, `safeMode`, `sql`, `block`, `getBlock`, `getSubtree`, `createBlock`, `updateBlock`, `moveBlock`, `installExtension`, `setExtensionEnabled`, `uninstallExtension`, `actions`, `renderers`, `refreshAppRuntime`, `React`, `ReactDOM`, `window`, and `document`.

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
