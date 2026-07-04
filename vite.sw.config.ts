import {defineConfig} from 'vite'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const configDir = path.dirname(fileURLToPath(import.meta.url))

// Dedicated build for the service worker.
//
// The SW is a CLASSIC worker — registered without {type:'module'} (see
// src/registerServiceWorker.ts) — so it must ship as a SINGLE, self-contained
// non-module file at dist/sw.js. We build it separately from the app: its own
// entry (src/sw/sw.ts), WebWorker types (tsconfig.sw.json), bundling the pure
// src/sw/*.ts helpers inline. scripts/inject-sw-build-id.ts then stamps the
// emitted dist/sw.js with the build id + precache lists.
//
// MUST run AFTER the app build: `vite build` empties dist/ and writes the app,
// then this build adds sw.js (emptyOutDir:false so it doesn't wipe the app).
export default defineConfig({
  // The SW resolves every URL against self.registration.scope at runtime, so
  // the app's base path is irrelevant to it; keep '/' to avoid URL rewriting.
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'esnext',
    // NOT minified. Unlike the app bundle, the stamped sw.js is dominated by the
    // injected precache URL LIST (data, which minification doesn't touch) — so
    // minifying just the ~5 kB of code buys almost nothing (a few kB after gzip,
    // fetched once per deploy and cached), while an unminified worker stays
    // readable in DevTools. That readability is worth keeping for a
    // correctness/security-critical worker (generation cache pinning + GC, the
    // "stuck load" failure class). The stamp (scripts/inject-sw-build-id.ts →
    // stampSwSource) is nonetheless written to survive minification — it keys off
    // each placeholder STRING LITERAL, not the JSON.parse call — so flipping this
    // to true later is safe and needs no stamp changes.
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: path.resolve(configDir, 'src/sw/sw.ts'),
      output: {
        // Classic (non-module) worker: a plain IIFE with the pure src/sw/*.ts
        // helpers inlined into one file. A single non-HTML entry already builds
        // with code-splitting off, so the output is a single dist/sw.js with no
        // sibling chunks (no dynamic imports in the SW anyway).
        format: 'iife',
        entryFileNames: 'sw.js',
      },
    },
  },
})
