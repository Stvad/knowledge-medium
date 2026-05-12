import {defineConfig, ViteDevServer} from 'vite'
import type {IncomingMessage, ServerResponse} from 'node:http'
import path from "path"
import react, {reactCompilerPreset} from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import externalize from "vite-plugin-externalize-dependencies";
import wasm from "vite-plugin-wasm"
// import noBundlePlugin from 'vite-plugin-no-bundle';

const openaiRealtimeTokenPath = '/api/openai/realtime-client-secret'
const openaiRealtimeWhisperModel = 'gpt-realtime-whisper'

const sendJson = (
    res: ServerResponse,
    status: number,
    body: Record<string, unknown>,
) => {
    res.writeHead(status, {'content-type': 'application/json'})
    res.end(JSON.stringify(body))
}

const readJsonBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(Buffer.from(chunk)))
        req.on('end', () => {
            if (chunks.length === 0) {
                resolve({})
                return
            }
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                resolve(typeof parsed === 'object' && parsed !== null ? parsed : {})
            } catch (error) {
                reject(error)
            }
        })
        req.on('error', reject)
    })

const openaiRealtimeClientSecretDevServer = () => ({
    name: 'openai-realtime-client-secret-dev-server',
    configureServer(server: ViteDevServer) {
        server.middlewares.use(openaiRealtimeTokenPath, async (req, res, next) => {
            if (req.method === 'OPTIONS') {
                res.writeHead(204, {
                    'access-control-allow-methods': 'POST,OPTIONS',
                    'access-control-allow-headers': 'content-type',
                })
                res.end()
                return
            }
            if (req.method !== 'POST') {
                next()
                return
            }

            const apiKey = process.env.OPENAI_API_KEY?.trim()
            if (!apiKey) {
                sendJson(res, 501, {
                    error: 'OPENAI_API_KEY is not configured for the Vite dev server',
                })
                return
            }

            try {
                const body = await readJsonBody(req)
                const model = typeof body.model === 'string' && body.model.trim()
                    ? body.model.trim()
                    : openaiRealtimeWhisperModel
                const upstream = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${apiKey}`,
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify({
                        session: {
                            type: 'transcription',
                            audio: {
                                input: {
                                    transcription: {model},
                                    turn_detection: {type: 'server_vad'},
                                },
                            },
                        },
                    }),
                })
                const payload = await upstream.text()
                res.writeHead(upstream.status, {'content-type': 'application/json'})
                res.end(payload)
            } catch (error) {
                sendJson(res, 500, {
                    error: error instanceof Error ? error.message : String(error),
                })
            }
        })
    },
})

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
            isDev && openaiRealtimeClientSecretDevServer(),
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
