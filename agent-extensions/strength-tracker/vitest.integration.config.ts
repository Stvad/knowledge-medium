import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import react from '@vitejs/plugin-react'
import {defineConfig} from 'vitest/config'

const configDir = dirname(fileURLToPath(import.meta.url))

/** Second tier, alongside `vitest.config.ts`: that config aliases `@/` to
 *  the kernel-type STUBS (declarations only), which is enough for the
 *  extension's pure engine/parser/reader code but cannot execute anything
 *  that imports a runtime `@/data/*` module — `store.ts` does, because
 *  writing blocks means calling the real mutators, not describing their
 *  types. This config points `@/` at the actual app sources instead, so
 *  those modules run for real against a real `Repo` over a real
 *  `@powersync/node` database (the app's own `createTestDb` harness) —
 *  the only way to exercise what `store.ts` actually does to the tree,
 *  as opposed to what its callers assume it does.
 *
 *  Deliberately its own config rather than a second alias branch in
 *  `vitest.config.ts`: the two `@/` meanings (stubs vs. real sources) must
 *  never both apply to one test run, or a file picked up by both would
 *  resolve to different modules depending on collection order. `include`
 *  is scoped to `test/integration/**` so the split is enforced by directory,
 *  not by convention. Not part of `tsconfig.json`'s typecheck either — see
 *  that file's `exclude` — the kernel-type stubs have no declarations for
 *  the app's internal test harness (`@/data/test/*`), and shouldn't grow
 *  any: it isn't part of the extension-facing API the stubs exist to cover. */
export default defineConfig({
  plugins: [react()],
  test: {
    // Pinned, and it is load-bearing rather than tidiness. Several rules here
    // are timezone-sensitive by nature: `dayToDate` writes local NOON while the
    // app's date property editor writes UTC MIDNIGHT, and the gap between them
    // only misreads the day WEST of UTC. Run under UTC — which is what a CI
    // runner defaults to — a test for that difference passes whether the fix is
    // there or not. A fixed western zone makes the suite mean the same thing on
    // every machine. Verified by mutation: neutering `storedDate` fails here
    // and goes green under TZ=UTC.
    env: {TZ: 'America/Los_Angeles'},
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    // Same setup the app's own tests run with: L2 dev-assertion invariants
    // hard-throw on a derived-data contract violation instead of silently
    // producing a wrong answer, which is exactly the failure mode a wiring
    // bug in `store.ts` would otherwise hide.
    setupFiles: [resolve(configDir, '../../src/test/setup.ts')],
  },
  resolve: {
    alias: [
      {find: /^@\/(.*)$/, replacement: resolve(configDir, '../../src/$1')},
    ],
  },
})
