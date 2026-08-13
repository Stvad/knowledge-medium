# Local dev loop for core (`src/`) changes

> **Status:** current — verified end to end against the code on 2026-08-12
> (Vite 8.0.10, agent-cli in `packages/agent-cli`). React Fast Refresh was
> found broken, root-caused, and then fixed (`vite-plugins/unifySrcJsUrls.ts`,
> upstream PR); see
> [Fast Refresh](#fast-refresh-the-hmr-payload-half-of-the-url-rewrite).

The default way to exercise a `src/` change is: PR → merge → GitHub Pages
deploy → CDN → reload. That has taken days. This is the loop that replaces it:
serve the app from the working tree, point a browser at it, pair a `pnpm agent`
profile to that tab, and see edits in **seconds**.

Nothing here is new machinery — it is the existing `pnpm dev` + agent-bridge
pairing, pointed at `http://localhost:<port>` instead of the hosted deploy.

---

## Safety: which account the local tab is logged into

A local dev server is a **build you are actively breaking**. If the tab it
serves is signed into the real account, PowerSync happily uploads whatever that
build writes. So:

| Mode | How | Use it for | Risk |
|---|---|---|---|
| **Local-only** (recommended default) | "Use without sync (local-only)" on the login screen, then any name | UI/rendering/keybinding/editor work, extension smoke tests | none — no Supabase, no PowerSync, no network writes at all |
| **Sandbox account** | Sign in as the throwaway account (`--profile test`'s account) | anything touching sync, workspaces, invites, attachments | confined to the throwaway workspace |
| **Main account** | — | **never** | real data corruption, uploaded |

Local-only is the better default for this loop: `src/components/Login.tsx`
routes to `LocalLogin` when `ftm.localOnly` is set, and `App.tsx` /
`repoProvider.ts` then pass `useRemoteSync: false` — the session makes **no**
PowerSync connect and **no** Supabase Storage request. You get a real repo, a
real local SQLite DB, real extensions — just no server. Pick the sandbox
account only when the thing you are testing *is* sync.

Note the local-only workspace is per-`(user id)` and starts empty (a Journal, a
daily note, the tutorial). It is not a copy of your sandbox data.

---

## One-time setup

### 1. Start the dev server (backgrounded)

```bash
cd /Users/spolakh/Library/CloudStorage/Dropbox/code/knowledge-medium
nohup pnpm dev --port 5180 --strictPort > /tmp/km-vite-dev.log 2>&1 &
```

**Port 5173 is already taken** on this machine by azimuth's long-running Vite,
so this loop uses **5180**. `--strictPort` makes a collision fail loudly
instead of silently drifting to another port (which would break the pairing
origin).

Stop it with:

```bash
lsof -nP -iTCP:5180 -sTCP:LISTEN -t | xargs -r kill
```

### 2. Open it in a browser profile that is NOT your main account  ← **human step**

Use the **sandbox Chrome profile** (the one already paired as
`--profile test`), or any other non-main profile. Open:

```
http://localhost:5180/
```

Then either click **"Use without sync (local-only)"** and enter any name
(recommended), or sign in as the throwaway account.

> `localhost:5180` is a **different origin** from `stvad.github.io`, so it has
> its own localStorage, its own IndexedDB/OPFS database and its own agent
> tokens. Being signed in on the hosted app does not sign you in here — this
> step cannot be automated away, and that is the point.

### 3. Pair a `pnpm agent` profile to that tab  ← **human step (one paste)**

```bash
AGENT_RUNTIME_APP_URL=http://localhost:5180/ pnpm agent connect --profile localdev
```

This prints a pairing URL. Open it **in the same browser profile** from step 2,
approve the "Connect to local agent bridge?" dialog, click **Generate** in the
token dialog, copy the token, paste it back into the waiting terminal.

Verify:

```bash
pnpm agent whoami --profile localdev
pnpm agent eval --profile localdev 'return {ws: repo.activeWorkspaceId, origin: location.origin}'
```

Three profiles now coexist on the one bridge (`127.0.0.1:8787`) — `default`
(main), `test` (hosted sandbox), `localdev` (this local server). The bridge
keys clients by token, so they do not interfere. **Always pass `-p` /
`--profile` explicitly.**

Notes:

- `AGENT_RUNTIME_APP_URL` is only needed for `connect` / `pair-url` (it decides
  which URL gets printed). Every later command uses the saved token.
- No `AGENT_RUNTIME_ALLOWED_ORIGINS` is needed: the bridge always accepts
  loopback origins (`server.ts:loopbackOriginPattern`).
- Re-pairing is only needed if you change the port, wipe that profile's
  storage, or switch accounts.

---

## The loop

```bash
# 1. edit any file under src/
# 2. push it into the tab (~1s command, ~4s app boot)
pnpm agent reload --profile localdev
# 3. assert on the result, headlessly
pnpm agent eval --profile localdev 'return document.body.innerText.slice(0, 400)'
```

Everything the agent bridge can do works against this tab —
`install-extension` / `enable-extension` / `run-action` / `sql` / `eval` /
`navigate`. Verified: installing `agent-extensions/fold-cycle.tsx` against the
local server compiles (`--verify` → `ok:true`) and, after `enable-extension`
plus a reload, its action shows up in `runtime` actions. So extension work can
be developed against a locally-patched core, which is the combination that was
previously impossible.

Fast Refresh now works for component-only modules (see below), so many
`src/` edits show up on their own within about a second. `pnpm agent reload`
remains the reliable fallback — it always propagates, regardless of module
shape — and is still whole-loop **seconds**, versus days.

---

## Fast Refresh: the HMR-payload half of the URL rewrite

Fast Refresh used to be dead repo-wide in dev: Vite *did* detect the edit and
push an HMR update (the dev-server log showed `hmr update /src/...tsx`, and
the module served over HTTP contained the new code), but the running page
silently ignored it. Only `/src/index.css` updates applied.

Root cause: `vite-plugins/unifySrcJsUrls.ts`. To make kernel modules and
importmap-loaded extension modules share one module-map entry, it rewrites
`/src/x.tsx` → `/src/x.js` **in served response bodies** — including inside
`__vite__createHotContext("/src/x.tsx")`. So the client registered every hot
module under `/src/x.js`. The HMR update payload, however, travels over the
**WebSocket**, never through that `res.end` rewrite, and still named
`/src/x.tsx`. The client looked up `.tsx` in `hotModulesMap`, missed, and
dropped the update with no warning. CSS was unaffected because `.css` URLs
aren't rewritten.

Fixed (`vite-plugins/unifySrcJsUrls.ts`, `rewriteSrcPath` + a `server.hot.send`
wrap): the same rewrite now runs on the WS payload's `updates[].path` /
`acceptedPath` before it's sent, so both sides agree on the URL. Verified
against this checkout after a dev-server restart: edited
`src/components/Header.tsx` (added then removed a marker element) and watched
the change appear and disappear in the live tab with no
`pnpm agent reload` and no page navigation — a `window` sentinel set before
the edits was still present after both, ruling out a full reload; the
dev-server log showed `hmr update /src/index.css, /src/components/Header.tsx`
for each edit.

A React Fast Refresh boundary only exists for modules whose exports are all
components — `TutorialBanner.tsx` also exports `tutorialBannerHeader`, so
edits there fall back to whatever Vite's propagation decides (often a full
reload). `pnpm agent reload` is still the reliable step for those; treat Fast
Refresh as a bonus that now actually pays out for component-only files.

Changing `vite.config.ts` or anything in `vite-plugins/` needs a **dev-server
restart**, not just a reload.

---

## What does NOT match production

Be honest about these before concluding "it works":

- **No service worker.** `registerServiceWorker()` returns early on
  `!import.meta.env.PROD` (`src/registerServiceWorker.ts:66`), so the dev tab
  is never SW-controlled (verified: `navigator.serviceWorker.controller ===
  null`). Nothing about precaching, offline boot, the update prompt, or PWA
  install behaves like production. Test those with a real build (below).
- **Base path.** Dev serves at `/`; Pages deploys under `/knowledge-medium/`
  (`APP_BASE_PATH` in `.github/workflows/deploy-pages.yml`). Anything
  path-sensitive (`import.meta.env.BASE_URL`, the SW scope, manifest) differs.
- **Module graph.** Dev serves unbundled ESM with the `/src/x.js` rewrite
  above; prod is a Rollup build. The `@/` importmap surface extensions use
  (`src/extensions/apiCatalog.ts`) is deliberately kept identical, but bundling
  bugs, tree-shaking and chunk-splitting problems will not reproduce in dev.
- **React comes from esm.sh in both dev and prod** (the importmap in
  `index.html`; `vite-plugins/reactImportMapMode.ts` swaps the `?dev` URLs for
  production ones at build). The dev server therefore still needs **internet**
  for the first React fetch — "local" does not mean offline.
- **React Compiler + StrictMode** are on in dev, so you will see double
  invocation of effects that production does not.
- **Local-only mode** has no Supabase at all: member management, invitations,
  attachment upload/fetch and anything gated on `useIsLocalOnly()` are inert.
- The dev tab is a **separate device** for the extension trust gate: extensions
  approved on the hosted origin are not approved here, and vice versa.

To test the SW / PWA / base-path behaviour, build and preview instead:

```bash
APP_BASE_PATH=/knowledge-medium/ pnpm build
pnpm preview --port 5181
```

`pnpm preview` serves `dist/`, so the SW registers and precaching runs.
The same pairing recipe applies to that origin (yet another origin → yet
another token).

---

## Related, if you want a deployed URL anyway

`.github/workflows/pr-preview.yml` already publishes every PR to
`https://stvad.github.io/knowledge-medium/pr-preview/pr-<N>/`. Still needs a
push and a CI run, but it does not need a merge — useful for testing on iOS,
where this localhost loop does not reach. (For iOS, the other option is
`VITE_TUNNEL=1 pnpm dev` plus a Tailscale-serve HTTPS hostname; see the
`ios-device-debug` skill.)

---

## Gotchas hit while setting this up

- `pnpm agent pair-url` does **not** add `agent-runtime-open-tokens=1`, so the
  URL it prints approves the bridge but never opens the token dialog. Use
  `pnpm agent connect` (which does), or append the flag by hand.
- The bridge secret lives in `~/.config/knowledge-medium/agent-bridge.json` and
  is embedded in the pairing URL — don't paste that URL anywhere but your own
  browser.
- Vite does **not** auto-restart on edits to `vite-plugins/*`; kill and restart.
- A dev-server restart drops the page's HMR socket; reload the tab
  (`pnpm agent reload --profile localdev`) after restarting.
