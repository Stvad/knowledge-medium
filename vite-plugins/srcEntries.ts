/** The app's own source files — what `vite.config.ts` turns into build entries
 *  and what `vendorImportMap.ts` scans for imported subpaths. One owner, so a
 *  file excluded from the build is also not "something the app imports". */
export const SRC_ENTRY_GLOB = 'src/**/*.{ts,tsx,js}'

export const SRC_ENTRY_EXCLUDE = [
  // `*.test.*` also covers the fuzz suites: docs/fuzzing.md fixes them
  // as `*.fuzz.test.ts`, so a bare `*.fuzz.*` pattern matched nothing.
  '**/test/**', '**/*.test.*', '**/*.d.ts',
  // Example sources are imported as TEXT (`?raw`) and already emitted
  // by that import. Adding them as entries compiles a second copy and
  // Rollup dedups the name to `<name>2.js` — pure duplication.
  '**/examples/**',
  // The service worker's own graph, built by vite.sw.config.ts. Scoped
  // to those four roots, NOT all of src/sw: previewDatabases.ts is
  // client-graph code (src/data/localDbStorage.ts imports it) and
  // excluding the directory wholesale left it emitting 3 of its 5
  // exports — the very bug the entry list exists to prevent.
  'src/sw/{sw,worker,ledger,preview}.ts',
]
