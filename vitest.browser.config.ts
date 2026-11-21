import {defineConfig} from 'vitest/config'
import base, {BROWSER_TESTS} from './vitest.config.ts'

/** Only the tests that drive real browsers through Playwright. They need browser
 *  binaries (`pnpm exec playwright install chromium webkit firefox`), so they run
 *  with `pnpm test:browser` and in their own CI job, not in the gate.
 *  `KM_BOUNDARY_ENGINES=chromium` narrows a local run to what is installed. */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // The base config's projects would replace this include with the whole suite.
    projects: undefined,
    setupFiles: [],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    include: [BROWSER_TESTS],
    exclude: ['**/node_modules/**'],
  },
})
