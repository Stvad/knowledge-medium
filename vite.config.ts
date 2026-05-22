import {defineConfig, ViteDevServer} from 'vite'
import path from "path"
import react, {reactCompilerPreset} from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import externalize from "vite-plugin-externalize-dependencies";
import wasm from "vite-plugin-wasm"
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
            isDev && {
                /**
                 * Make every `/src/**` module — whether imported by
                 * the kernel (static, Vite-transformed) or by a
                 * dynamic-extension blob (resolves via document
                 * importmap) — hit the *same* URL in the browser's
                 * module map. Otherwise they cache as separate entries,
                 * every module-scoped singleton (React `createContext`,
                 * stores, etc.) gets duplicated, and consumers of the
                 * "wrong" copy fail with errors like "useRepo must be
                 * used within a RepoContext". Prod doesn't have this
                 * problem because Rollup outputs `.js` for everything;
                 * dev needs help converging.
                 *
                 * Vite's default behavior: even when kernel source says
                 * `import x from '@/foo.js'`, Vite's resolver finds the
                 * real file (`foo.tsx`) and rewrites the import URL in
                 * served code to `/src/foo.tsx`. Extensions request
                 * `/src/foo.js` via the importmap. Two URLs → two
                 * module-map entries → broken.
                 *
                 * Two pieces together force convergence on `.js` URLs:
                 *
                 *   1. `transform` (post) rewrites Vite's emitted import
                 *      URLs from `.tsx` / `.ts` / `.jsx` back to `.js`
                 *      so kernel modules fetch `/src/foo.js`.
                 *   2. The `configureServer` middleware strips `.js`
                 *      from `req.url` so Vite's file resolver still
                 *      finds the actual `.tsx`/`.ts` source and serves
                 *      its transformed contents (the rewrite is purely
                 *      server-side; the browser still sees the `.js`
                 *      URL on the response, which is what we want for
                 *      module-map keying).
                 *
                 * Net effect: every `/src/**` import — kernel or
                 * extension — fetches `.js`, gets the right content,
                 * shares one module-map entry. Matches prod.
                 *
                 * Only matches `/src/`-prefixed URLs (not Vite-internal
                 * `/@id/...`, `/node_modules/...?v=...`, virtual
                 * modules) and only handles non-query suffixes
                 * (`.tsx` / `.ts` / `.jsx`) so HMR's `?t=...`,
                 * `?import`, `?v=...` markers pass through.
                 */
                name: 'unify-src-js-urls',
                configureServer(server: ViteDevServer) {
                    server.middlewares.use((req, res, next) => {
                        if (!req.url || !req.url.startsWith('/src/')) return next();

                        // Server-side rewrite so Vite's resolver finds the
                        // real TS source on disk and serves its transformed
                        // contents. Browser still sees the `.js` URL it
                        // requested, which is what we want for module-map
                        // keying.
                        if (req.url.endsWith('.js')) {
                            req.url = req.url.slice(0, -3);
                        }

                        // Wrap `res.end` to rewrite Vite's emitted import
                        // URLs from `.tsx` / `.ts` / `.jsx` back to `.js`
                        // before the body leaves the server. Vite uses a
                        // single end() call for module responses (no chunked
                        // streaming for dev-server transformed modules), so
                        // one-shot interception suffices. Match only
                        // `/src/`-prefixed URLs to avoid touching
                        // Vite-internal paths (`/@id/...`,
                        // `/node_modules/...?v=...`, virtual modules).
                        const origEnd = res.end.bind(res);
                        res.end = function (chunk?: unknown, ...rest: unknown[]) {
                            if (
                                typeof chunk === 'string'
                                || chunk instanceof Buffer
                                || chunk instanceof Uint8Array
                            ) {
                                const body = chunk instanceof Buffer || chunk instanceof Uint8Array
                                    ? Buffer.from(chunk).toString('utf-8')
                                    : chunk
                                const rewritten = body.replace(
                                    /(["'])(\/src\/[^"'?#]+)\.(?:tsx|ts|jsx)(["'?#])/g,
                                    '$1$2.js$3',
                                )
                                if (rewritten !== body) {
                                    const buf = Buffer.from(rewritten)
                                    if (!res.headersSent) {
                                        res.setHeader('Content-Length', buf.length)
                                    }
                                    return (origEnd as (b: Buffer, ...rest: unknown[]) => unknown)(buf, ...rest)
                                }
                            }
                            return (origEnd as (...args: unknown[]) => unknown)(chunk, ...rest)
                        } as typeof res.end

                        next();
                    });
                },
            },
        ].filter(Boolean),
        resolve: {
            alias: {
                '@': path.resolve(__dirname, './src'),
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
