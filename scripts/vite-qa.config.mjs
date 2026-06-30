import { defineConfig, mergeConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import path from 'node:path'
import base from '../vite.config.ts'

// QA-only vite config for running a dev server INSIDE a git worktree.
//
// A worktree has no node_modules of its own — deps resolve up to the main
// checkout — so vite's default `server.fs.allow` (rooted at the worktree)
// rejects every parent-dependency request with 403 and the app hangs on
// "Loading…".
//
// Do NOT fix this by disabling `fs.strict`: that makes Vite serve ANY local
// file over `/@fs/...` (e.g. /etc/hosts, ~/.ssh, .env), which is a real hazard
// because this server is reached over the Tailscale tunnel during iPad testing
// (VITE_TUNNEL in vite.config.ts), not just localhost. Instead keep strict on
// and explicitly allow the worktree plus the checkout that actually holds
// node_modules — Vite's default deny list still blocks everything outside.
//
// Kept as plain .mjs (like webkit-qa.mjs) so `tsc -b` doesn't typecheck it
// against the app's vite config types.
//
//   node node_modules/vite/bin/vite.js \
//     --config scripts/vite-qa.config.mjs --port 5199 --strictPort
//
// (run from the worktree root; node resolves vite up to the main checkout.)
const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Walk up to the nearest ancestor whose node_modules holds REAL packages (the
// main checkout, when run from a worktree; the worktree itself for a normal
// checkout). A worktree's own node_modules is cache-only (.vite/.cache) — node
// resolves actual deps up the tree — so probe for `node_modules/vite` (the dev
// server we're running) rather than a bare node_modules dir. depsRoot contains
// the worktree, so allowing it covers both source and the resolved deps.
let depsRoot = worktreeRoot
while (
  !existsSync(path.join(depsRoot, 'node_modules', 'vite')) &&
  path.dirname(depsRoot) !== depsRoot
) {
  depsRoot = path.dirname(depsRoot)
}
// Fail CLOSED. If no ancestor has node_modules/vite, the loop above exits with
// depsRoot at the filesystem root — allow-listing `/` would re-open the very
// arbitrary-file-read hole this config exists to prevent. Refuse to start.
if (!existsSync(path.join(depsRoot, 'node_modules', 'vite'))) {
  throw new Error(
    `vite-qa.config: no ancestor of ${worktreeRoot} has node_modules/vite — ` +
      `refusing to start rather than allow-list the filesystem root. ` +
      `Run from a worktree nested under an installed checkout.`,
  )
}

export default defineConfig(async (env) => {
  const resolved = typeof base === 'function' ? await base(env) : base
  return mergeConfig(resolved, { server: { fs: { allow: [worktreeRoot, depsRoot] } } })
})
