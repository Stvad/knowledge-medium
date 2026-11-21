import react from '@vitejs/plugin-react'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vite'

const configDir = dirname(fileURLToPath(import.meta.url))

const isReactExternal = (id: string): boolean =>
  id === 'react' ||
  id.startsWith('react/') ||
  id === 'react-dom' ||
  id.startsWith('react-dom/')

const isExtensionRuntimeExternal = (id: string): boolean =>
  isReactExternal(id) ||
  id.startsWith('@/')

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    lib: {
      entry: resolve(configDir, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'Strength Tracker.js',
    },
    rollupOptions: {
      external: isExtensionRuntimeExternal,
      output: {
        codeSplitting: false,
      },
    },
  },
})
