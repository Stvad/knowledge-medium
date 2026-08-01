import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import react from '@vitejs/plugin-react'
import {defineConfig} from 'vitest/config'

const configDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  test: {
    // `node` by default — most of this extension is pure logic (engine,
    // parser, readers) and a per-file DOM instance is the bulk of a suite's
    // wall-clock. Files that need a DOM opt in with a
    // `// @vitest-environment happy-dom` docblock on line 1, which is the
    // app's own long-standing convention. A `.test.tsx` that forgets it fails
    // loudly in node rather than silently passing.
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // `test/integration/**` runs under vitest.integration.config.ts instead
    // — it imports RUNTIME `@/data/*` modules that only exist as `.d.ts`
    // stubs here (see that config's docblock), so collecting it under this
    // config fails at import time rather than merely being redundant.
    exclude: ['test/integration/**'],
  },
  resolve: {
    alias: [
      // `@/` normally resolves to the kernel-type STUBS — declarations only,
      // which is all `src/` needs, because every `@/` import there is
      // type-only except in the modules that actually call into the app.
      // Those few get a runtime fake here, so the React half is testable at
      // all rather than being reviewed by eye.
      {find: /^@\/utils\/dialogs\.js$/, replacement: resolve(configDir, 'test/kernel/dialogs.ts')},
      {find: /^@\/utils\/navigation\.js$/, replacement: resolve(configDir, 'test/kernel/navigation.ts')},
      {find: /^@\/hooks\/block\.js$/, replacement: resolve(configDir, 'test/kernel/blockHooks.ts')},
      {find: /^@\/data\/properties\.js$/, replacement: resolve(configDir, 'test/kernel/properties.ts')},
      {find: /^@\/shortcuts\/types\.js$/, replacement: resolve(configDir, 'test/kernel/shortcutTypes.ts')},
      {find: /^@\/(.*)$/, replacement: resolve(configDir, '../kernel-types/src/$1')},
    ],
  },
})
