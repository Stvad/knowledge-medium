import {globSync} from 'node:fs'

/** The app's own source files — the build entries `vite.config.ts` emits and
 *  the sources `vendorImportMap.ts` scans for imported subpaths. One owner, so
 *  a file that is not a build entry is also not "something the app imports". */
const SRC_ENTRY_GLOB = 'src/**/*.{ts,tsx,js}'

const SRC_ENTRY_EXCLUDE = [
  // `*.test.*` covers the fuzz suites too (`*.fuzz.test.ts`, docs/fuzzing.md).
  '**/test/**', '**/*.test.*', '**/*.d.ts',
  // Example sources are imported as TEXT (`?raw`) and already emitted by that
  // import; an entry would compile a second copy.
  '**/examples/**',
  // The service worker's four roots only (vite.sw.config.ts builds them).
  // NOT all of src/sw: previewDatabases.ts is client-graph code
  // (src/data/localDbStorage.ts imports it) and must stay an entry.
  'src/sw/{sw,worker,ledger,preview}.ts',
]

/** Repo-relative paths of the source entries, platform separators as globbed. */
export const srcEntryFiles = (rootDir: string): string[] =>
  globSync(SRC_ENTRY_GLOB, {cwd: rootDir, exclude: SRC_ENTRY_EXCLUDE})
