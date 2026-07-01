import {defineConfig, type Plugin} from 'vite'
import path from "path"
import react, {reactCompilerPreset} from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import externalize from "vite-plugin-externalize-dependencies";
import wasm from "vite-plugin-wasm"
import {reactImportMapProductionPlugin} from './vite-plugins/reactImportMapMode'
import {unifySrcJsUrlsPlugin} from './vite-plugins/unifySrcJsUrls'
import {resolveAppVersion} from './scripts/app-version'
// import noBundlePlugin from 'vite-plugin-no-bundle';

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
        server: process.env.VITE_TUNNEL ? {allowedHosts: ['.ts.net']} : undefined,
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
                externals: [
                    'react', // Externalize "react", and all of its subexports (react/*), such as react/jsx-runtime
                    'react-dom',
                ],
            }),
            {
                name: 'only-main-entry',
                /**
                 * Reason for this is that when we have preserveModules, Vite will for some reason will inject
                 * script tags for all the modules in the project.
                 * Which is probably not an issue generally, but if we externalize react and react-dom, this results in
                 * tags that point at /react and don't resolve via import maps.
                 *
                 * Keep the actual entry script regardless of whether the app is deployed at / or under a subpath.
                 * Vite may emit a small index.js entry wrapper which imports src/main.js.
                 */
                transformIndexHtml(html: string) {
                    return html.replace(/<script\s+type="module" crossorigin .*?src="([^"]*)".*?><\/script>\s*/g, (match, src) => {
                        return /(^|\/)(index|src\/main)\.js(?:$|[?#])/.test(src) ? match : '';
                    })
                },
            },
            reactImportMapProductionPlugin(),
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
                //     // Mark react and react-dom as external to rely on the import map
                external: [
                    'react',
                    'react/compiler-runtime',
                    'react/jsx-dev-runtime',
                    'react/jsx-runtime',
                    'react-dom',
                    'react-dom/client',
                ],
                // input: '/src/main.tsx',
                // input: {
                //     index: path.resolve(__dirname, 'index.html'),
                //     If you need to also specify your main file explicitly:
                // main: path.resolve(__dirname, 'src/main.tsx'),
                // },
                output: {
                    preserveModules: true, // Preserves the module structure
                    preserveModulesRoot: process.cwd(),
                    // Set file naming without hashes.
                    entryFileNames: '[name].js',
                    chunkFileNames: '[name].js',
                    assetFileNames: '[name][extname]',
                },
                preserveEntrySignatures: 'strict', // Preserves the signature of the entry point
            },
            sourcemap: true,
            minify: false,
            target: 'esnext',
        },
    })
})
