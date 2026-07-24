import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vitest/config'

const configDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': resolve(configDir, '../../agent-extensions/kernel-types/src'),
    },
  },
})
