import {defineConfig} from 'vite'
import path from "path"
import react, {reactCompilerPreset} from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import externalize from "vite-plugin-externalize-dependencies";
import wasm from "vite-plugin-wasm"
import {unifySrcJsUrlsPlugin} from './vite-plugins/unifySrcJsUrls'
// import noBundlePlugin from 'vite-plugin-no-bundle';

// https://vite.dev/config/
export default defineConfig(({command}) => {
    const isDev = command === 'serve';
    const base = process.env.APP_BASE_PATH?.trim() || '/';

    return ({
        base,
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
            // See vite-plugins/unifySrcJsUrls.ts for the full rationale.
            // Tests in vite-plugins/test/unifySrcJsUrls.test.ts.
            isDev && unifySrcJsUrlsPlugin(),
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
