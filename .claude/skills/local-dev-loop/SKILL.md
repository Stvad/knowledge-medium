---
name: local-dev-loop
description: Run the app from the working tree (`pnpm dev`) and drive that tab with the agent bridge, so a `src/` change is verifiable in seconds instead of merge → Pages deploy → CDN → reload. Use when you need to see a core change actually running — pairing a `localdev` CLI profile, choosing which account the dev tab is signed into, or testing service-worker / PWA / base-path behaviour with a real build. NOT needed for pure logic changes a vitest run already covers.
---

# Local dev loop for core (`src/`) changes

Nothing here is new machinery: it's the existing `pnpm dev` plus the existing
agent-bridge pairing, pointed at `http://localhost:<port>` instead of the
hosted deploy. The payoff is that every bridge verb — `eval`, `reload`,
`install-extension`, `run-action`, `sql` — targets a tab running YOUR working
tree.

## Safety: which account the dev tab is signed into

A local dev server is a build you are actively breaking. If its tab is signed
into the real account, PowerSync uploads whatever that build writes.

| Mode | How | Use it for | Risk |
|---|---|---|---|
| **Local-only** (default) | "Use without sync (local-only)" on the login screen, then any name | UI / rendering / keybinding / editor work, extension smoke tests | none — no PowerSync connect, no Supabase call |
| **Sandbox account** | Sign in as a throwaway account | anything whose subject *is* sync, workspaces, invites, attachments | confined to the throwaway workspace |
| **Main account** | — | **never** | real data corruption, uploaded |

Local-only is load-bearing, not a suggestion: `src/components/Login.tsx`
routes to its `LocalLogin` when the `ftm.localOnly` opt-in is set,
`src/App.tsx` then computes `useRemoteSync = hasRemoteSyncConfig && !localOnly`,
and `src/data/repoProvider.ts` returns before any remote connect when that's
false. The asset lane checks the same flag (`isRemoteSyncActive()` in
`src/plugins/attachments/assetResolver.ts`, `assetUpload.ts`,
`assetDownLane.ts`), so blob puts/gets stay local too. You get a real repo, a
real local SQLite DB, real extensions — no server.

The local-only workspace is per-user-id and starts empty. It is not a copy of
your sandbox data.

## Pairing walkthrough

**1. Start the dev server.** Pick a port you control and pin it —
`--strictPort` fails loudly instead of drifting to another port, which would
silently break the pairing origin.

```bash
nohup pnpm dev --port <port> --strictPort > /tmp/km-vite-dev.log 2>&1 &
# stop it later:
lsof -nP -iTCP:<port> -sTCP:LISTEN -t | xargs -r kill
```

**2. Open it in a browser profile that is NOT your main account** ← human step.
Go to `http://localhost:<port>/` and click **"Use without sync (local-only)"**
(or sign in as the throwaway account). `localhost:<port>` is a different
origin from the hosted app, so it has its own localStorage, its own
IndexedDB/OPFS database and its own agent tokens — being signed in on the
hosted app does not sign you in here, and that is the point.

**3. Pair a CLI profile to that tab** ← human step, one paste.

```bash
AGENT_RUNTIME_APP_URL=http://localhost:<port>/ pnpm agent connect --profile localdev
```

Open the printed URL **in the same browser profile**, approve "Connect to
local agent bridge?", generate a token, paste it back. Then:

```bash
pnpm agent whoami --profile localdev
pnpm agent eval --profile localdev 'return {ws: repo.activeWorkspaceId, origin: location.origin}'
```

Notes:

- One bridge (`127.0.0.1:8787`) serves every profile; it keys clients by
  token, so `default` / a sandbox profile / `localdev` coexist. **Always pass
  `--profile` explicitly.**
- `AGENT_RUNTIME_APP_URL` matters only to `connect` / `pair-url` — it decides
  which URL gets printed. Later commands use the saved token.
- No `AGENT_RUNTIME_ALLOWED_ORIGINS` needed: the bridge always accepts
  loopback origins (`packages/agent-cli/src/server.ts:loopbackOriginPattern`).
- Re-pair only if you change the port, wipe that profile's storage, or switch
  accounts.
- The bridge secret rides inside the pairing URL — don't paste that URL
  anywhere but your own browser.

**The loop** is then: edit → `pnpm agent reload --profile localdev` → assert
headlessly with `pnpm agent eval --profile localdev '…'`. React Fast Refresh
also applies component-only modules on its own; `reload` is the fallback that
always propagates. Changes under `vite-plugins/` or to `vite.config.ts` need a
dev-server **restart** (Vite does not auto-restart for them), and a restart
drops the page's HMR socket — reload the tab afterwards.

## What does NOT match production

Be honest about these before concluding "it works". Each was re-verified
against the code on 2026-08-14:

- **No service worker.** `registerServiceWorker()` returns early on
  `!import.meta.env.PROD` (`src/registerServiceWorker.ts`), so the dev tab is
  never SW-controlled. Precaching, offline boot, the update prompt and PWA
  install behave nothing like production.
- **Base path.** Dev serves at `/` (`vite.config.ts`:
  `process.env.APP_BASE_PATH?.trim() || '/'`); Pages deploys under
  `/knowledge-medium/` (`APP_BASE_PATH` in `.github/workflows/deploy-pages.yml`).
  Anything reading `import.meta.env.BASE_URL` — SW scope, manifest, asset URLs
  — differs.
- **Module graph.** Dev serves unbundled ESM through the
  `/src/x.tsx` → `/src/x.js` rewrite (`vite-plugins/unifySrcJsUrls.ts`); prod
  is a Rollup build. The `@/` importmap surface extensions consume
  (`src/extensions/apiCatalog.ts`) is deliberately identical, but bundling,
  tree-shaking and chunk-splitting bugs will not reproduce in dev.
- **React is fetched from esm.sh in both modes**, but dev uses the `?dev`
  builds pinned in `index.html`'s importmap and the build swaps in production
  URLs (`vite-plugins/reactImportMapMode.ts`). Two consequences: the dev
  server still needs **internet** for the first React fetch ("local" is not
  "offline"), and `StrictMode` (`src/main.tsx`, unconditional) double-invokes
  effects in dev only, because only the dev React build does that.
- **Local-only has no Supabase at all**: member management, invitations,
  attachment upload/fetch and anything gated on `useIsLocalOnly()`
  (`src/components/Login.tsx`) are inert. Sign into the sandbox account
  instead if that's what you're testing.
- **The dev tab is a separate device for the extension trust gate.** Approvals
  live in an origin-scoped IndexedDB store
  (`src/extensions/compiledModuleCache.ts`), so an extension approved on the
  hosted origin is unapproved here and vice versa — expect to re-run
  `enable-extension` against `--profile localdev`.

React Compiler is *not* on this list: `vite.config.ts` applies
`reactCompilerPreset()` unconditionally, so dev and prod agree.

## Testing the service worker / PWA / base path

The dev server can't tell you anything about those. Build and preview instead
— `pnpm preview` serves `dist/`, so the SW registers and precaching runs:

```bash
APP_BASE_PATH=/knowledge-medium/ pnpm build
pnpm preview --port <other-port>
```

That's yet another origin, so it needs its own pairing and its own profile if
you want to drive it from the CLI.
