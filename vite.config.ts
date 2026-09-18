import {defineConfig, type Plugin} from 'vite'
import path from "path"
import {fileURLToPath} from "node:url"
import react, {reactCompilerPreset} from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import wasm from "vite-plugin-wasm"
import {unifySrcJsUrlsPlugin} from './vite-plugins/unifySrcJsUrls'
import {injectThemeBootDefaultsPlugin} from './vite-plugins/injectThemeBootDefaults'
import {vendorImportMapPlugin} from './vite-plugins/vendorImportMap'
import {srcEntryFiles} from './vite-plugins/srcEntries'
import {resolveAppVersion} from './scripts/app-version'


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
const allSrcEntries = (rootDir: string): Record<string, string> => {
    // Accepted: this also makes src/minimal-editor.tsx an entry, the script
    // for a second page that is not itself a build input, so it emits with
    // nothing importing it. Kept rather than special-cased — it IS an
    // internal module, and carving out page bootstraps would reintroduce
    // the per-file judgement this list exists to avoid. ~1 KB.
    const files = srcEntryFiles(rootDir)
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
            // Bundled dependencies importable by bare name from dynamic
            // extensions (facades over the app chunk + importmap entries). See
            // vite-plugins/vendorImportMap.ts; tests in vite-plugins/test/.
            vendorImportMapPlugin({rootDir: __dirname}),
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
                input: {
                    index: path.resolve(__dirname, 'index.html'),
                    ...allSrcEntries(__dirname),
                    // vendorImportMapPlugin adds the vendor/<pkg> facade entries here.
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
                    codeSplitting: {
                        minSize: 0,
                        minShareCount: 1,
                        // The static closure of the entry: rolldown captures a matched
                        // module's static dependencies recursively by default and stops
                        // at import(), so a lazy boundary in the source is one in the
                        // build. The emitted shape is gated by scripts/check-dist-exports.ts.
                        groups: [{name: 'app', minSize: 0, test: (id: string) => id === path.resolve(__dirname, 'src/main.tsx')}],
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
