import {defineConfig, ViteDevServer} from 'vite'
import path from "path"
import fs from "node:fs"
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
                 * Make `import '@/foo.js'` work in dev, matching prod where
                 * everything is served as `.js`. The earlier implementation
                 * rewrote `req.url` server-side (`req.url = req.url.slice(0, -3)`)
                 * which served the right *content* but didn't change the URL
                 * the browser saw — so `import '@/foo.js'` and `import '@/foo.tsx'`
                 * resolved to two distinct module-map entries with identical
                 * content but separate identity. Every module-scoped singleton
                 * (most visibly React `createContext` calls — `useRepo` reading
                 * a fresh `RepoContext` that `<RepoProvider>` never wrote to)
                 * gets duplicated.
                 *
                 * Instead, issue a real HTTP 302 redirect to the on-disk
                 * canonical URL (`.tsx`, `.ts`, `.jsx`, or no-ext, matching
                 * what the kernel imports). The extension compiler
                 * (`canonicalizeExtensionImports` in compileExtensionModule.ts)
                 * uses this redirect to learn the canonical specifier and
                 * rewrite extension source *before* `import()` runs, so the
                 * browser's module map dedupes against the kernel's entry.
                 *
                 * The redirect alone doesn't give module identity on its own
                 * — Chrome/Vite-client both key the module map by *request*
                 * URL, not response URL — so the compiler-side rewrite is
                 * the load-bearing piece. The redirect's purpose is purely
                 * to publish a server-authoritative "what's canonical"
                 * signal.
                 */
                name: 'canonicalize-js-extension',
                configureServer(server: ViteDevServer) {
                    const srcRoot = path.resolve(__dirname, 'src');
                    // Order matters: probe in the order the kernel actually
                    // uses these suffixes, so a stray `.ts` next to a `.tsx`
                    // doesn't win the canonicalization.
                    const candidateExts = ['.tsx', '.ts', '.jsx', ''];

                    server.middlewares.use((req, res, next) => {
                        if (!req.url || !req.url.startsWith('/src/')) return next();

                        // Split off query/hash so the redirect preserves
                        // Vite's `?v=...` / `?import` HMR markers.
                        const queryIdx = req.url.search(/[?#]/);
                        const pathOnly = queryIdx >= 0 ? req.url.slice(0, queryIdx) : req.url;
                        const suffix = queryIdx >= 0 ? req.url.slice(queryIdx) : '';
                        if (!pathOnly.endsWith('.js')) return next();

                        const stripped = pathOnly.slice(0, -'.js'.length);
                        const relPath = stripped.slice('/src/'.length);

                        // If a real `.js` file exists on disk (genuine plain
                        // JS source), let Vite serve it normally — no rewrite.
                        const realJsPath = path.resolve(srcRoot, `${relPath}.js`);
                        if (fs.existsSync(realJsPath)) return next();

                        for (const ext of candidateExts) {
                            const probe = path.resolve(srcRoot, `${relPath}${ext}`);
                            if (!fs.existsSync(probe)) continue;
                            const canonical = `${stripped}${ext}${suffix}`;
                            res.writeHead(302, {Location: canonical});
                            res.end();
                            return;
                        }
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
