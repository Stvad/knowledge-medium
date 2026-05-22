import type {Plugin, ViteDevServer} from 'vite'

// Match any quoted `/src/...` URL ending in `.tsx`, `.ts`, or `.jsx`.
// The trailing character class `["'?#]` matches the closing quote OR
// the start of a query/hash so HMR's `?t=...`, `?import`, `?v=...`
// pass through cleanly. Anchored to `/src/` so Vite-internal paths
// (`/@id/...`, `/@vite/...`, `/node_modules/...?v=...`) and virtual
// modules don't match.
const SRC_TS_URL_RE = /(["'])(\/src\/[^"'?#]+)\.(?:tsx|ts|jsx)(["'?#])/g

/**
 * Rewrite Vite-emitted `/src/foo.tsx` / `.ts` / `.jsx` URLs in served
 * module bodies to `/src/foo.js`, so kernel imports (which Vite
 * normally rewrites to the actual-disk extension) match the URL
 * dynamic extensions request via the document importmap.
 *
 * **False-positive risk**: a string literal in user code that happens
 * to look like `"/src/foo.tsx"` would also be rewritten. The regex is
 * deliberately broad — it catches `import`/`from` imports, dynamic
 * `import(...)`, *and* Vite's HMR-context calls like
 * `__vite__createHotContext("/src/foo.tsx")`. Constraining it to
 * `from`/`import(` syntax would miss the HMR case and leave one of
 * the modules requesting a `.tsx` URL, reintroducing the
 * duplicate-module bug. Comments / string literals that legitimately
 * reference `/src/foo.tsx` URLs are very rare; if you hit one,
 * compare to the cost of the bug coming back.
 */
export const rewriteSrcImports = (body: string): string =>
  body.replace(SRC_TS_URL_RE, '$1$2.js$3')

/**
 * Vite plugin: makes every `/src/**` module — whether imported by the
 * kernel (static, Vite-transformed) or by a dynamic-extension blob
 * (resolved via the document importmap) — fetch from the same `.js`
 * URL in the browser's module map. Without this, kernel modules fetch
 * `/src/foo.tsx` while extensions fetch `/src/foo.js`, the browser
 * keys them as separate module-map entries, and every module-scoped
 * singleton (React `createContext`, stores, etc.) gets duplicated.
 * The most visible symptom is `useRepo must be used within a
 * RepoContext` when an extension's `useRepo()` reads from a fresh
 * `RepoContext` that `<RepoProvider>` never wrote to.
 *
 * Prod doesn't have this problem because Rollup outputs `.js` for
 * everything — so this is dev-only plumbing to match prod's URL
 * convention.
 *
 * Two pieces work together:
 *
 *   1. `res.end` wrap rewrites Vite's emitted `.tsx` / `.ts` / `.jsx`
 *      URLs to `.js` in the response body. Vite uses a single
 *      `res.end(body)` call for module responses (no chunked
 *      streaming in dev), so one-shot interception is sufficient.
 *   2. `req.url` strip removes `.js` from incoming requests so
 *      Vite's file resolver still finds the actual TS source on
 *      disk and serves its transformed contents.
 */
export const unifySrcJsUrlsPlugin = (): Plugin => ({
  name: 'unify-src-js-urls',
  configureServer(server: ViteDevServer) {
    server.middlewares.use((req, res, next) => {
      if (!req.url || !req.url.startsWith('/src/')) return next()

      if (req.url.endsWith('.js')) {
        req.url = req.url.slice(0, -3)
      }

      const origEnd = res.end.bind(res)
      res.end = function (chunk?: unknown, ...rest: unknown[]) {
        if (
          typeof chunk === 'string'
          || chunk instanceof Buffer
          || chunk instanceof Uint8Array
        ) {
          const body = chunk instanceof Buffer || chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString('utf-8')
            : chunk
          const rewritten = rewriteSrcImports(body)
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

      next()
    })
  },
})
