import {globSync, readFileSync} from 'node:fs'
import path from 'node:path'

/** Every internal module as a Rollup input, so an extension can import ANY of
 *  them at its stable `@/` path and get its full export surface. The boot
 *  graph itself is bundled into one chunk (`codeSplitting` below); each of
 *  these entries then emits as a thin facade re-exporting from it, so the
 *  importmap contract holds while the browser loads ~3 files at boot instead
 *  of ~1,500 (the per-file loader cost, not JS linking, was ~0.5 s of an
 *  iPhone cold launch).
 *
 *  `preserveEntrySignatures` protects ENTRY points only, so a non-entry module
 *  keeps just the exports something imports across a module boundary (the
 *  resulting silence is why scripts/check-dist-exports.ts exists). Globbed
 *  rather than driven off `apiCatalog`: that catalog is a discovery surface,
 *  not a whitelist. */
export const allSrcEntries = (rootDir: string): Record<string, string> => {
    const files = globSync('src/**/*.{ts,tsx,js}', {
        cwd: rootDir,
        exclude: [
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
            // exports — the very bug this input list exists to prevent.
            'src/sw/{sw,worker,ledger,preview}.ts',
        ],
        // Accepted: this also makes src/minimal-editor.tsx an entry, the script
        // for a second page that is not itself a build input, so it emits with
        // nothing importing it. Kept rather than special-cased — it IS an
        // internal module, and carving out page bootstraps would reintroduce
        // the per-file judgement this list exists to avoid. ~1 KB.
    })
    return Object.fromEntries(files.map((file: string) => {
        // globSync yields platform separators; the entry KEY becomes the emitted
        // path, which the page importmap resolves as a URL, so it must be POSIX.
        const posix = file.split(path.sep).join('/')
        // Strip .js too, not just .ts/.tsx: Rollup appends .js to the key, so
        // leaving it on a plain-JS module emits `<name>.js.js` and the importmap
        // path 404s — worse than the dropped export this list exists to prevent.
        return [posix.replace(/\.(tsx?|js)$/, ''), path.resolve(rootDir, file)]
    }))
}

export function readPageImports(rootDir: string): Record<string, string> {
    const html = readFileSync(path.join(rootDir, 'index.html'), 'utf8')
    const json = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1]
    if (!json) throw new Error('index.html has no <script type="importmap">')
    return (JSON.parse(json) as {imports: Record<string, string>}).imports
}

export function readExtensionImportManifest(rootDir: string) {
    return {
        sourceSpecifiers: Object.keys(allSrcEntries(rootDir))
            .map(entry => '@/' + entry.slice('src/'.length) + '.js'),
        exactPageImports: Object.fromEntries(
            Object.entries(readPageImports(rootDir)).filter(([specifier]) => !specifier.endsWith('/')),
        ),
    }
}
