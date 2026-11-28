import {resolve} from 'node:path'
import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

const src = resolve(import.meta.dirname, '../../src')

export default defineConfig({
  envDir: false,
  plugins: [react()],
  // Let the CLI own stdin and shutdown instead of Vite's dev-server handlers.
  server: {middlewareMode: true},
  resolve: {alias: [
    // The edge builds export the browser facade's API without a MessagePort
    // that would keep the Node daemon alive after shutdown.
    {find: '@/vendor/react-dom-server.js', replacement: resolve(src, 'vendor/react-dom-server-edge.js')},
    {find: '@/vendor/react-dom-static.js', replacement: resolve(src, 'vendor/react-dom-static-edge.js')},
    {find: '@', replacement: src},
  ]},
})
