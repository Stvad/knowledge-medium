import {resolve} from 'node:path'
import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  envDir: false,
  plugins: [react()],
  // Let the CLI own stdin and shutdown instead of Vite's dev-server handlers.
  server: {middlewareMode: true},
  resolve: {alias: {'@': resolve(import.meta.dirname, '../../src')}},
})
