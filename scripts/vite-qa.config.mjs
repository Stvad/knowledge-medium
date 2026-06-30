import { defineConfig, mergeConfig } from 'vite'
import base from '../vite.config.ts'

// QA-only vite config for running a dev server INSIDE a git worktree.
//
// A worktree has no node_modules of its own — deps resolve up to the main
// checkout — so vite's default `server.fs.allow` (rooted at the worktree)
// rejects every dependency request with 403 and the app hangs on "Loading…".
// Relaxing `fs.strict` lets the harness server serve those parent deps. Dev/QA
// only; never use for a build or a server exposed beyond localhost.
//
// Kept as plain .mjs (like webkit-qa.mjs) so `tsc -b` doesn't typecheck it
// against the app's vite config types.
//
//   node node_modules/vite/bin/vite.js \
//     --config scripts/vite-qa.config.mjs --port 5199 --strictPort
//
// (run from the worktree root; node resolves vite up to the main checkout.)
export default defineConfig(async (env) => {
  const resolved = typeof base === 'function' ? await base(env) : base
  return mergeConfig(resolved, { server: { fs: { strict: false } } })
})
