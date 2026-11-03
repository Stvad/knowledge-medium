---
name: local-dev-loop
description: Run the app from the working tree (`pnpm dev`) and drive that tab with the agent bridge, so a `src/` change is verifiable in seconds instead of merge → Pages deploy → CDN → reload. Use when you need to see a core change actually running — starting this worktree's own server without colliding with another worktree's, pairing a `localdev-<port>` CLI profile, choosing which account the dev tab is signed into, or testing service-worker / PWA / base-path behaviour with a real build. Also use when a `src/` edit you already reloaded seems to have no effect — a provider doesn't work, a context is null, state stopped syncing — since that can be an HMR module-identity split, not a bug in your change. NOT needed for pure logic changes a vitest run already covers.
---

# Local dev loop for core (`src/`) changes

Nothing here is new machinery: it's `pnpm dev` plus the existing agent-bridge
pairing, pointed at `http://localhost:<port>` instead of the hosted deploy. The
payoff is that every bridge verb — `eval`, `reload`, `install-extension`,
`run-action`, `sql` — targets a tab running YOUR working tree.

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

## One server per worktree

Many sessions run servers on this machine at once, each from its own worktree,
so the server already on a port is usually another branch's. Start your own and
use only that one.

- **Claude desktop app:** `preview_start` with `dev`. The app assigns the first
  free port from 5173 (skipping every chat's preview servers), passes it as
  `PORT`, and says which one it picked; `pnpm dev` binds exactly that port. Use
  the port and tab the result names.
- **Anywhere else** (Bash, Codex): `pnpm dev`. It takes the first free port
  from 5173, prints `http://localhost:<port>/` with your worktree and branch,
  and names the worktree behind each busy port it skipped. `pnpm dev --port
  <port>` asks for one port exactly and refuses, naming the holder, if it is
  taken; a `PORT` set in the environment counts the same. Run it in the
  background and keep the log in your scratchpad:
  `nohup pnpm dev > <scratchpad>/vite.log 2>&1 &`. In the Codex sandbox a bind
  needs elevated permissions, as the bridge tests do; without them every port
  reads as taken.
- **Before you use a port you did not just start**, ask who holds it:
  `pnpm dev:who <port>`. With no port, `pnpm dev:who` lists every server any
  checkout of this repository runs, including one whose worktree has since
  been deleted: port, kind, pid, age, worktree, branch. Stop only your own
  (`kill <pid>`).
- **Never edit `.claude/launch.json` to get a port.** Every entry
  (`dev`, `dev-preview`, `prod-preview`, `agent-server`) has `"autoPort": true`
  and follows `PORT`; a port collision there is a bug to fix in the entry, not
  per session.

`pnpm dev` and `pnpm preview` run `scripts/dev-server.mjs`, which wraps vite with
`--strictPort`: vite on its own moves to the next free port, which is how a
session ends up reading another branch's app at the port it assumed.

Two things care which port you get. The local Supabase stack's auth redirects
(`supabase/config.toml`) and the Maps API key's allowed referrers
(`docs/domain-onboarding.md`) name 5173, so a sign-in against the local stack or
a map that works on 5173 can fail on 5174. Local-only mode needs no particular
port.

**A port is an origin.** Each port has its own localStorage, local database,
agent tokens and extension approvals. A server that moved to another port starts
with an empty local store and needs its own pairing. A port that a different
worktree serves later still carries what the earlier one stored there.

## Pairing walkthrough

**1. Start the dev server** as in "One server per worktree" above, and note its
port.

**2. Open it in a browser profile that is NOT your main account** ← human step.
Go to `http://localhost:<port>/` and click **"Use without sync (local-only)"**
(or sign in as the throwaway account). `localhost:<port>` is a different
origin from the hosted app, so it has its own localStorage, its own
IndexedDB/OPFS database and its own agent tokens — being signed in on the
hosted app does not sign you in here, and that is the point.

**3. Pair a CLI profile to that tab** ← human step, one paste. A profile
reaches the tab of one origin, so name it after the port:

```bash
AGENT_RUNTIME_APP_URL=http://localhost:<port>/ pnpm agent connect --profile localdev-<port>
```

Open the printed URL **in the same browser profile**, approve "Connect to
local agent bridge?", generate a token, paste it back. Then:

```bash
pnpm agent whoami --profile localdev-<port>
pnpm agent eval --profile localdev-<port> 'return {ws: repo.activeWorkspaceId, origin: location.origin}'
```

Notes:

- The shared bridge (`127.0.0.1:8787`) serves every profile paired without
  `AGENT_RUNTIME_PORT`; it keys clients by token, so `default` / a sandbox
  profile / `localdev-<port>` coexist. **Always pass `--profile` explicitly.**
- A profile you paired earlier reaches whatever now serves its port. Check
  `pnpm dev:who <port>` before trusting it.
- `AGENT_RUNTIME_APP_URL` matters only to `connect` / `pair-url` — it decides
  which URL gets printed. Later commands use the saved token.
- No `AGENT_RUNTIME_ALLOWED_ORIGINS` needed: the bridge always accepts
  loopback origins (`packages/agent-cli/src/server.ts:loopbackOriginPattern`).
- Re-pair only if your server's port changes, you wipe that origin's storage,
  you switch accounts, or the origin was last paired to a private bridge (see
  "Your own bridge").
- The bridge secret rides inside the pairing URL — don't paste that URL
  anywhere but your own browser.

**The shared bridge.** Keep it shared: the user's live client and every
profile are paired to `127.0.0.1:8787`, so a bridge per worktree would mean
re-pairing all of them. Whichever checkout's `pnpm agent` (or the agent-dispatch
daemon) found it down started it, and it keeps running the build it loaded until
it is killed.
`pnpm dev:who 8787` shows that checkout, its age, and whether its code
(`server.js` and the modules it imports) is gone, was rebuilt after it started,
or differs from your build. A different
build matters when the bridge's own code changed in between: it enforces
read-only token scope from `protocol.ts`, so a bridge older than a new read-only
verb refuses that verb to a read-scoped token. Restarting it (`kill <pid>`)
drops every session's in-flight commands. The next `pnpm agent` from any
checkout, or the daemon, starts that checkout's build, so run one of yours right
after the kill. App tabs re-register at their next retry: within ~16s if the
bridge is back within half a minute, otherwise up to a minute, and at once when
the tab is focused. Do it only when its checkout is gone or you need the newer
build. To test a change to the bridge itself, run your own instead.

**Your own bridge**, for a branch that changes `packages/agent-cli/src/server.ts`
or `protocol.ts`. Build it (`pnpm run compile:packages`), then start it:
`preview_start` with `agent-server` (first free port from 8788), or
`AGENT_RUNTIME_PORT=<port> pnpm agent:server` on a port `pnpm dev:who <port>`
calls free. Confirm `pnpm dev:who <port>` names it as this worktree's agent
bridge. Pass `AGENT_RUNTIME_PORT=<its port>` to every `pnpm agent` call,
including the `connect` that pairs your dev tab: the tab saves that bridge's URL
for its origin and talks only to it from then on. When you are done, re-run
`connect` without `AGENT_RUNTIME_PORT`, so the next worktree served on that port
finds the origin paired to the shared bridge again.

**The loop** is then: edit → `pnpm agent reload --profile localdev-<port>` →
assert headlessly with `pnpm agent eval --profile localdev-<port> '…'`. React Fast Refresh
also applies component-only modules on its own; `reload` is the fallback that
always propagates. Changes under `vite-plugins/` or to `vite.config.ts` need a
dev-server **restart** (Vite does not auto-restart for them), and a restart
drops the page's HMR socket — reload the tab afterwards. A restart can come back
on another port when another worktree took yours in between; the app's result or
the `[dev-server] dev for … http://localhost:<port>/` line says which, and a new
port means a new origin to pair.

## Kernel/extension module identity split after a hot update

Unlike the `vite-plugins/`/`vite.config.ts` case above, this throws **no
error** — state silently stops crossing the kernel/extension boundary (a
provider/context reads as `null`, a store looks reset, sync "stops
working"), reading as "my change has no effect," and can also surface later
as a thrown `useRepo must be used within a RepoContext`.

Detect from eval before chasing a phantom bug — compare a **known singleton
export**, not the bare namespace object (two URLs always produce two distinct
namespace wrappers, even when unaffected). This probes one importer/module
pair only — swap in the module path and a known importer of it to check a
different pair; an untested edge can be split while this reports `false`.
(`import.meta` isn't available in eval scope, hence `fetch`-and-regex below
instead of reading `import.meta.hot` directly.)

```js
// adapt the module path + a known importer of it
const importerSrc = await (await fetch('/src/App.js')).text()
const stamped = importerSrc.match(/\/src\/context\/repo\.js(\?t=\d+)?/)[0]
const [ext, kernel] = await Promise.all([
  import('/src/context/repo.js'),  // what an extension's importmap resolves to
  import(stamped),                 // what the kernel graph currently uses
])
return {split: ext.RepoContext !== kernel.RepoContext, stamped}
```

Same fix as the `vite-plugins/`/`vite.config.ts` case above — a dev-server
**restart**, but with no error telling you one's needed. Reloading,
reverting the edit, or re-editing either module again all fail — the
stamped specifier lives in the process's in-memory graph; only a new
process resets it.

**Mechanism**: `unifySrcJsUrls.ts` keeps kernel and extension imports of a
module on one URL so singletons stay one instance (see "Module graph"
below for what it does). Editing ANY already-loaded `src/` module reachable
from the kernel's static import graph stamps every kernel importer's
specifier `?t=<timestamp>` from then on — regardless of export shape:
confirmed on a component-only module Fast Refresh *did* self-accept
(`src/components/BlockComponent.tsx`) and a pure-function module with no JSX
(`src/utils/routing.ts`), both splitting identically. The timestamp itself keeps changing on further
edits — the only load-bearing fact is that it never cleans until restart.
Usage instead gates whether the split is *observable*: it surfaces as a bug
only when something compares identity across the boundary — `createContext()`,
a singleton store/Map, `instanceof`, a function or component used as a
Map/registry key, React comparing element types (a component reached through
both URLs remounts instead of updating). Exports that are only ever *called*
across the boundary split just the same and show nothing. (One round of
testing; untested: new-file, delete, rename cases.)

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
- **React's development build runs in dev**, served by Vite's dependency
  optimizer; the build bundles the production one into the app chunk.
  Extensions reach either through the `src/vendor/` facades the importmap
  names. `StrictMode` (`src/main.tsx`, unconditional) double-invokes effects
  in dev only, because only the development build does that.
- **Local-only has no Supabase at all**: member management, invitations,
  attachment upload/fetch and anything gated on `useIsLocalOnly()`
  (`src/components/Login.tsx`) are inert. Sign into the sandbox account
  instead if that's what you're testing.
- **The dev tab is a separate device for the extension trust gate.** Approvals
  live in an origin-scoped IndexedDB store
  (`src/extensions/compiledModuleCache.ts`), so an extension approved on the
  hosted origin is unapproved here and vice versa, and so is each local
  port — expect to re-run `enable-extension` against `--profile localdev-<port>`.

React Compiler is *not* on this list: `vite.config.ts` applies
`reactCompilerPreset()` unconditionally, so dev and prod agree.

## Testing the service worker / PWA / base path

The dev server can't tell you anything about those. Build and preview instead
— `pnpm preview` serves `dist/`, so the SW registers and precaching runs. It
takes the first free port from 4173, like `pnpm dev` does from 5173. In the
desktop app the `prod-preview` entry builds and previews in one step, at base
`/`; for the Pages base path, use the commands below.

```bash
APP_BASE_PATH=/knowledge-medium/ pnpm build
pnpm preview
```

That's yet another origin, so it needs its own pairing and its own profile if
you want to drive it from the CLI.
