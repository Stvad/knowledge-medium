verification:
- use `yarn run check` for verification unless otherwise stated
- bridge/server tests that bind `127.0.0.1` fail in the Codex sandbox with `listen EPERM`; run `yarn run check` or those specific tests with elevated permissions

secret handling:
- do not read `.env`, `.env.*`, or other local secret files unless the user explicitly asks for it
- do not print, echo, cat, grep, or otherwise reveal secrets or secret-bearing files in chat or command output
- when a task needs secret-backed config, infer variable names from code/docs and have the user provide or set values out of band
- if a command must touch a secret file, avoid outputting its contents and avoid relaying secret values back to the user

testing:
- don't add tests that just re-state the code (like testing what is our default shortcut binding is. this just duplicates the shortcut string for no benefit)
- share one DB per test file: open with `createTestDb()` once in module scope / `beforeAll`, reset with `resetTestDb()` in `beforeEach`. Don't call `createTestDb()` per test.
- don't `await new Promise(r => setTimeout(r, N))` to wait on a DB/subscription/BroadcastChannel round-trip — it's slow and flaky. Poll the outcome with `vi.waitFor`.
- proving a write does NOT fire/invalidate:
  - loader-backed query handles (`repo.query.*`): assert the invalidation counter, NOT `fired.length`. Subscriber notifications sit downstream of the loader's structural-diff dedup + mid-load coalescing, so an erroneous invalidation that re-resolves to an equal value (or coalesces with a later control write) is deduped and never reaches a subscriber — `fired` can't see it. Snapshot `env.repo.handleStore.metrics.loaderInvalidations`, do the no-op write, then assert it's unchanged: the post-commit fan-out is synchronous inside `repo.tx` and the counter increments before any dedup, so the count is complete the moment `tx` resolves — provided nothing can re-invalidate the handle a tick later (in the kernel tests that holds because the writes are local `blocks`-only, the post-commit processor registry is empty via `registerKernelProcessors: false`, and the default sync observer only reacts to `blocks_synced`). Keep a control-write fence (`vi.waitFor` a real change) as a liveness check. (see `src/data/internals/kernelQueries.test.ts`)
  - raw event listeners (BroadcastChannel / EventEmitter, no dedup layer): a FIFO fence IS sound — after the no-op signal, send a signal that DOES fire and `vi.waitFor` it; in-order delivery proves the no-op produced nothing. (see `src/sync/keys/flows/lockAndWipe.test.ts`)

cloud / remote sessions (Claude Code on the web):
- when running in a cloud/remote execution environment, open a pull request as soon as the branch has its first commit — don't wait to be asked — then subscribe to the PR's activity so review comments and CI failures come back into the session and can be addressed. (This standing authorization applies only to cloud sessions; local runs still default to not opening a PR unless asked.)

ui event channels (audit B3 — do not reintroduce the untyped window.CustomEvent UI bus):
- dialogs / pickers / one-shot prompts: `openDialog(Component, props)` from `@/utils/dialogs` (returns a promise; the component takes `resolve`/`cancel` via `DialogContextProps`). The plugin must pull in `dialogAppMountExtension` so DialogHost is mounted.
- toggle/open surfaces (palette, sidebar, search overlays): a module store from `createToggleStore` (`@/utils/toggleStore`) read with `useSyncExternalStore`; the action/header flips it directly. Cross-plugin or external callers trigger it via `runActionById(ACTION_ID)`, never by importing the store or an event name.
- request/response between components: a typed module registry of imperative handles (see `video-player/registry.ts`), not `respond()` callbacks in event detail.
- `window.dispatchEvent(new CustomEvent(...))` is reserved for GENUINE broadcast and is blocked in non-test `src/` by a `no-restricted-syntax` ESLint error — opt in per-site with `// eslint-disable-next-line no-restricted-syntax -- genuine broadcast: <why>`.
