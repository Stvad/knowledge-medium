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
    // Minified like the app bundle — the SW ships to every user, so the bytes
    // matter. The post-build stamp (scripts/inject-sw-build-id.ts) is written to
    // survive minification: it substitutes the bare `__BUILD_ID__` token
    // (quote-agnostic) and replaces each `JSON.parse("__…__")` call by matching
    // the placeholder STRING LITERAL — whose contents a minifier preserves
    // verbatim — not the `JSON.parse` identifier (which a minifier may alias).
    // Its guards (no placeholder may survive + `new Function` must parse the
    // result) turn any minifier interaction that DID perturb a placeholder into
    // a loud build failure, never a silently-shipped dead worker.
    minify: true,
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
