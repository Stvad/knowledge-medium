import { defineConfig } from 'vitest/config'
import base, { SUPABASE_STACK_TESTS } from './vitest.config.ts'

/** Only the tests that need a running Supabase stack. `pnpm check:db` starts
 *  one and runs this config with the stack's addresses in its environment. */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [SUPABASE_STACK_TESTS],
    exclude: ['**/node_modules/**'],
  },
})
