import {defineConfig, type Plugin} from 'vite'
import path from "path"
import react, {reactCompilerPreset} from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import wasm from "vite-plugin-wasm"
import {unifySrcJsUrlsPlugin} from './vite-plugins/unifySrcJsUrls.ts'
import {injectThemeBootDefaultsPlugin} from './vite-plugins/injectThemeBootDefaults.ts'
import {resolveAppVersion} from './scripts/app-version.ts'
import {allSrcEntries, readExtensionImportManifest} from './vite-plugins/extensionImportManifest.ts'

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
        // File serving keeps Vite's default strict allow-list (this checkout)
        // and deny-list. Never set fs.strict:false here: it would serve ANY
        // readable file — SSH keys, cloud creds — over the tunnel URL.
        server: process.env.VITE_TUNNEL
            ? {allowedHosts: ['.ts.net']}
            : undefined,
        // Preview stands in for GitHub Pages when testing the service worker,
        // and Pages sends no `Vary: Origin`. Vite's default CORS answer adds
        // one, and module requests carry `Origin`, so every precached module
        // misses in the SW and an offline reload of a preview boots blank.
        preview: {cors: false},
        // Baked into the bundle as a literal so the client can show which
        // build it's running (see src/appVersion.ts). The same object is
        // emitted as dist/version.json below for the deploy-time update check.
        define: {
            __APP_VERSION__: JSON.stringify(appVersion),
            __EXTENSION_IMPORT_MANIFEST__: JSON.stringify(readExtensionImportManifest(import.meta.dirname)),
        },
        plugins: [
            react(),
            babel({presets: [reactCompilerPreset()]}),
            wasm(),
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
                '@': path.resolve(import.meta.dirname, './src'),
                // Resolve the kernel's import of the wire-protocol schemas
                // to the agent-cli source. The schemas live in the
                // publishable package; the kernel uses them at runtime
                // (bridge.ts validates incoming JSON with
                // knownAgentCommandSchema.safeParse) and at type time
                // (commands.ts narrows on the discriminated union).
                '@knowledge-medium/agent-cli/extensionImportSyntax': path.resolve(import.meta.dirname, './packages/agent-cli/src/extensionImportSyntax.ts'),
                '@knowledge-medium/agent-cli/freezeExtensionImports': path.resolve(import.meta.dirname, './packages/agent-cli/src/freezeExtensionImports.ts'),
                '@knowledge-medium/agent-cli/protocol': path.resolve(
                    import.meta.dirname,
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
                    index: path.resolve(import.meta.dirname, 'index.html'),
                    ...allSrcEntries(import.meta.dirname),
                },
                // input: '/src/main.tsx',
                // input: {
                //     index: path.resolve(import.meta.dirname, 'index.html'),
                //     If you need to also specify your main file explicitly:
                // main: path.resolve(import.meta.dirname, 'src/main.tsx'),
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
                        groups: [{name: 'app', minSize: 0, test: (id: string) => id === path.resolve(import.meta.dirname, 'src/main.tsx')}],
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
