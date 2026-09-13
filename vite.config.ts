import {defineConfig, type Plugin} from 'vite'
import path from "path"
import {fileURLToPath} from "node:url"
import react, {reactCompilerPreset} from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import externalize from "vite-plugin-externalize-dependencies";
import wasm from "vite-plugin-wasm"
import {reactImportMapProductionPlugin} from './vite-plugins/reactImportMapMode'
import {unifySrcJsUrlsPlugin} from './vite-plugins/unifySrcJsUrls'
import {injectThemeBootDefaultsPlugin} from './vite-plugins/injectThemeBootDefaults'
import {resolveAppVersion} from './scripts/app-version'
import {globSync} from 'node:fs'
// import noBundlePlugin from 'vite-plugin-no-bundle';


/** Every internal module as a Rollup input, so an extension can import ANY of
 *  them at its stable `@/` path and get its full export surface. The boot
 *  graph itself is bundled into one chunk (`bootGraphChunk` below); each of
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
const allSrcEntries = (rootDir: string): Record<string, string> => {
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

/** The modules statically reachable from the app entry, recorded when the
 *  module graph is complete so the chunk assignment can bundle exactly the
 *  boot graph. Anything reached only through `import()` (babel, the media
 *  players, the authoring catalog, worker scripts) stays its own file, so a
 *  lazy boundary in the source is still a lazy boundary in the build. */
const bootGraph = new Set<string>()
const bootGraphChunk = (rootDir: string): Plugin => ({
    name: 'boot-graph-chunk',
    apply: 'build',
    buildEnd() {
        bootGraph.clear()
        const entry = path.resolve(rootDir, 'src/main.tsx')
        const queue = [entry]
        bootGraph.add(entry)
        while (queue.length > 0) {
            const id = queue.pop()!
            const info = this.getModuleInfo(id)
            if (!info) continue
            for (const dep of info.importedIds) {
                if (!bootGraph.has(dep)) {
                    bootGraph.add(dep)
                    queue.push(dep)
                }
            }
        }
        if (bootGraph.size < 100) {
            this.error(`boot graph walk found only ${bootGraph.size} modules; the app chunk would be empty`)
        }
    },
})

type RollupLogLike = {
    code?: string
    id?: string
    loc?: {
        file?: string
    }
    message: string
}

const isDashjsCommonjsVariableWarning = (log: RollupLogLike) => {
    if (log.code !== 'COMMONJS_VARIABLE_IN_ESM') return false

    return [log.id, log.loc?.file, log.message].some(value =>
        value?.includes('node_modules/dashjs/dist/modern/esm/dash.all.min.js'),
    )
}

const isReactImportExternal = (id: string): boolean =>
    id === 'react' ||
    id.startsWith('react/') ||
    id === 'react-dom' ||
    id.startsWith('react-dom/')

// Root the dev-server fs allow-list at the primary checkout. In a git worktree
// (.claude/worktrees/<name>) that's three levels up — the worktree has no
// node_modules of its own, so deps resolve upward to the main checkout; outside
// a worktree it's just this directory. Used only under VITE_TUNNEL (see below).
const configDir = path.dirname(fileURLToPath(import.meta.url))
const tunnelFsRoot = configDir.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`)
    ? path.resolve(configDir, '../../..')
    : configDir

// https://vite.dev/config/
export default defineConfig(({command}) => {
    const isDev = command === 'serve';
    const base = process.env.APP_BASE_PATH?.trim() || '/';
    const appVersion = resolveAppVersion();

    return ({
        base,
        // Opt-in via VITE_TUNNEL=1: allow a Tailscale-serve HTTPS *.ts.net
        // hostname to proxy into the dev server for real-device (iPad/iPhone)
        // testing — otherwise Vite's DNS-rebinding host check returns "Blocked
        // request". Off by default; the dev server still binds localhost only
        // (tailscaled forwards to it). See .claude/skills/ios-device-debug.
        // fs.allow widens the file-serving root to the primary checkout so a
        // worktree dev server can reach main's node_modules (see tunnelFsRoot
        // above) — otherwise Vite 403s the /@fs requests and the app hangs at
        // "Loading". We scope to the repo root rather than disabling strict mode
        // (fs.strict:false), which would serve ANY readable file — SSH keys,
        // cloud creds — over the tunnel URL. The allow-list keeps serving inside
        // the repo, and Vite's default deny-list still blocks .env/certs within it.
        server: process.env.VITE_TUNNEL
            ? {allowedHosts: ['.ts.net'], fs: {allow: [tunnelFsRoot]}}
            : undefined,
        // Baked into the bundle as a literal so the client can show which
        // build it's running (see src/appVersion.ts). The same object is
        // emitted as dist/version.json below for the deploy-time update check.
        define: {
            __APP_VERSION__: JSON.stringify(appVersion),
        },
        plugins: [
            react(),
            babel({presets: [reactCompilerPreset()]}),
            wasm(),
            externalize({
                externals: [isReactImportExternal],
            }),
            bootGraphChunk(__dirname),
            {
                name: 'only-main-entry',
                /**
                 * `allSrcEntries` makes every src/** file a Rollup input, so the HTML
                 * entry chunk is "entirely imports" and Vite inlines it, emitting a
                 * <script type="module"> tag for EVERY entry in the whole graph
                 * instead of just the real one. Keep only the one that actually
                 * boots the app — matched by path suffix so it works under any
                 * deploy base path, and never a module under src/, node_modules/
                 * or chunks/ (hundreds of those are literally named "index.js").
                 *
                 * `order: 'post'` so this runs after Vite has injected the tags
                 * (transformIndexHtml's default/"normal" tier already does, in this
                 * Vite version, but pin the order rather than rely on that).
                 */
                transformIndexHtml: {
                    order: 'post',
                    handler(html: string) {
                        return html.replace(/<script\s+type="module" crossorigin .*?src="([^"]*)".*?><\/script>\s*/g, (match, src) => {
                            // The real entry is either the HTML entry chunk at the
                            // deploy root (`<base>index.js`, when Vite does not inline
                            // it) or `src/main.js` (when it does); never a module
                            // under src/, node_modules/ or chunks/.
                            const isEntry =
                                /\/src\/main\.js(?:$|[?#])/.test(src) ||
                                (/(?:^|\/)index\.js(?:$|[?#])/.test(src) && !/\/(?:src|node_modules|chunks|assets)\//.test(src));
                            return isEntry ? match : '';
                        })
                    },
                },
            },
            reactImportMapProductionPlugin(),
            // Substitutes the theme-boot placeholder tokens in index.html's
            // pre-paint script with the source-of-truth values from
            // src/themeBootDefaults.ts — see that file and
            // vite-plugins/injectThemeBootDefaults.ts. Runs for both `pnpm
            // dev` (per-request) and `pnpm build` via transformIndexHtml.
            injectThemeBootDefaultsPlugin(),
            // See vite-plugins/unifySrcJsUrls.ts for the full rationale.
            // Tests in vite-plugins/test/unifySrcJsUrls.test.ts.
            isDev && unifySrcJsUrlsPlugin(),
            {
                // Publish the build version at <base>/version.json so a
                // future client-side update check can compare its baked-in
                // __APP_VERSION__ against the deployed one without a SW
                // round-trip. Build-only; dev reads the define directly.
                name: 'emit-version-json',
                apply: 'build',
                generateBundle() {
                    this.emitFile({
                        type: 'asset',
                        fileName: 'version.json',
                        source: JSON.stringify(appVersion, null, 2),
                    });
                },
            } satisfies Plugin,
        ].filter(Boolean),
        resolve: {
            alias: {
                '@': path.resolve(__dirname, './src'),
                // Resolve the kernel's import of the wire-protocol schemas
                // to the agent-cli source. The schemas live in the
                // publishable package; the kernel uses them at runtime
                // (bridge.ts validates incoming JSON with
                // knownAgentCommandSchema.safeParse) and at type time
                // (commands.ts narrows on the discriminated union).
                '@knowledge-medium/agent-cli/protocol': path.resolve(
                    __dirname,
                    './packages/agent-cli/src/protocol.ts',
                ),
            },
        },
        optimizeDeps: {
            exclude: [
                '@journeyapps/wa-sqlite',
                '@powersync/common',
                '@powersync/react',
                '@powersync/web',
            ],
        },
        worker: {
            format: 'es',
        },
        build: {
            rollupOptions: {
                onLog(level, log, defaultHandler) {
                    if (isDashjsCommonjsVariableWarning(log)) return
                    defaultHandler(level, log)
                },
                // Mark react and react-dom subpaths as external to rely on the import map.
                external: isReactImportExternal,
                input: {
                    index: path.resolve(__dirname, 'index.html'),
                    ...allSrcEntries(__dirname),
                },
                // input: '/src/main.tsx',
                // input: {
                //     index: path.resolve(__dirname, 'index.html'),
                //     If you need to also specify your main file explicitly:
                // main: path.resolve(__dirname, 'src/main.tsx'),
                // },
                output: {
                    // Entries (every src/** file, see allSrcEntries) keep their
                    // stable unhashed paths; the code itself lives in the `app`
                    // chunk they re-export from. Dynamic-only modules get
                    // rolldown's default chunking under chunks/.
                    entryFileNames: '[name].js',
                    chunkFileNames: 'chunks/[name]-[hash].js',
                    assetFileNames: '[name][extname]',
                    advancedChunks: {
                        minSize: 0,
                        minShareCount: 1,
                        groups: [{name: 'app', minSize: 0, test: (id: string) => bootGraph.has(id)}],
                    },
                },
                preserveEntrySignatures: 'strict', // Preserves the signature of the entry point
            },
            sourcemap: true,
            minify: true,
            target: 'esnext',
        },
    })
})
