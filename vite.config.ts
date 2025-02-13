import {defineConfig, ViteDevServer} from 'vite'
import path from "path"
import react from '@vitejs/plugin-react'
import externalize from "vite-plugin-externalize-dependencies";
import wasm from "vite-plugin-wasm"
// import noBundlePlugin from 'vite-plugin-no-bundle';

// https://vite.dev/config/
export default defineConfig(({command}) => {
    const isDev = command === 'serve';

    return ({
        plugins: [
            react(),
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
                 * Tags that point at /react and don't resolve via import maps
                 */
                transformIndexHtml(html: string) {
                    // Remove any script tag whose src is not '/src/main.js'
                    return html.replace(
                      /<script\s+type="module" crossorigin .*?src="(?!\/src\/main\.js)[^"]*".*?><\/script>\s*/g,
                      '',
                    )
                },
            },
            isDev && {
                /**
                 * One of the things I want to do is to import @local/module from dynamic in-browser context
                 * In production those are served with .js url, but in dev they are served bare or with original
                 * ts/tsx extension
                 *
                 * I want to have a unified experience tho, so making the dev server rewrite the .js urls to bare here
                 * So I can do import @local/module.js in both dev and prod
                 */
                name: 'redirect-js-extension',
                configureServer(server: ViteDevServer) {
                    server.middlewares.use((req, _, next) => {
                        // Check if the request is for a .js file under /src/
                        if (req.url && req.url.startsWith('/src/') && req.url.endsWith('.js')) {
                            // Rewrite URL by removing the trailing ".js"
                            req.url = req.url.slice(0, -3);
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
        build: {
            rollupOptions: {
                //     // Mark react and react-dom as external to rely on the import map
                external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
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
