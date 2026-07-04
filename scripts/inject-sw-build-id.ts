/**
 * Post-build step that stamps dist/sw.js with three things:
 *
 *   1. A per-build identifier (`__BUILD_ID__` placeholder) so each deploy
 *      lands in its own cache namespace and stale entries are dropped on
 *      activate. Source order: SW_BUILD_ID env, GITHUB_SHA, git rev-parse
 *      HEAD, then a timestamped fallback.
 *   2. The first-paint asset list (`__PRECACHE_ASSETS__` placeholder) — the
 *      HTML graph the browser dispatches before our SW activates — so the
 *      install handler can fetch them up front; without it a first-time
 *      offline reload would fail to boot.
 *   3. The REST asset list (`__PRECACHE_REST_ASSETS__` placeholder) — every
 *      OTHER same-origin runtime asset the SW serves cache-first (the full
 *      emitted module graph minus first-paint: lazy chunks, `@babel/standalone`,
 *      wasm, fonts — see scripts/precache-assets.ts). Precaching the whole set
 *      is what makes each generation's cache SELF-CONTAINED: `assetCacheFirst`
 *      never has to fall through to the network (which would serve the newest,
 *      possibly-different generation and graft mismatched module bytes onto an
 *      old page — the `does not provide an export named …` skew). It also makes
 *      the app fully offline.
 *   4. The VENDOR URL list (`__PRECACHE_VENDOR__` placeholder) — the cross-origin
 *      esm.sh React set (the import map's integrity keys, see
 *      vite-plugins/reactImportMapMode.ts). React is externalized to esm.sh in
 *      prod, so those URLs are absolute + cross-origin and thus EXCLUDED from the
 *      dist/-walking same-origin precache above — leaving an offline hole (an
 *      uncontrolled first load can't import React with no network). Injecting the
 *      known-integrity set lets install seed the shared vendor cache so a
 *      controlled offline load resolves React.
 *
 *   The same-origin lists are separate for install ORDERING, not cache mode — the
 *   SW fetches BOTH with `{ cache: 'no-cache' }` (a conditional revalidate that
 *   can't copy a stale prior-deploy entry), first-paint first because it's the
 *   offline-boot-critical set. Vendor URLs are immutable (version- + SRI-pinned),
 *   so the SW fetches them with `{ cache: 'default' }` instead.
 *
 * Runs after the SW build (vite.sw.config.ts) which emits dist/sw.js from
 * src/sw/sw.ts. Fails the build if any placeholder is missing — all are
 * required for the SW to behave correctly.
 */
import {readFileSync, writeFileSync, existsSync, readdirSync} from 'node:fs'
import {execSync} from 'node:child_process'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {collectRestAssets} from './precache-assets'
import {stampSwSource} from './stamp-sw-source'
import {productionReactIntegrity} from '../vite-plugins/reactImportMapMode'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(scriptDir, '..', 'dist')
const swPath = resolve(distDir, 'sw.js')

if (!existsSync(swPath)) {
  console.error(`[inject-sw-build-id] missing ${swPath} — run the SW build first`)
  process.exit(1)
}

const resolveBuildId = (): string => {
  if (process.env.SW_BUILD_ID) return process.env.SW_BUILD_ID
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12)
  try {
    return execSync('git rev-parse HEAD', {stdio: ['ignore', 'pipe', 'ignore']})
      .toString()
      .trim()
      .slice(0, 12)
  } catch {
    return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

// Collect the modules the HTML actually pulls in on first paint: the
// entry script tag + every `<link rel="modulepreload">` it lists, plus
// any stylesheet links. This is much narrower (and faster on first
// visit) than precaching every file in dist/ — the rest is lazy and
// will be picked up by SWR when the user navigates into those features.
//
// URLs are kept exactly as Vite emits them (absolute paths under the
// configured base, e.g. `/knowledge-medium/src/main.js` for a Pages
// deploy). The SW resolves them against `self.registration.scope`, and
// `new URL(absolutePath, scope)` is base-aware: passing `./` and
// stripping leading slashes would otherwise double the base prefix on
// non-root deployments.
const collectPrecacheAssets = (): string[] => {
  const html = readFileSync(resolve(distDir, 'index.html'), 'utf8')
  const hrefs = new Set<string>()
  const add = (raw: string | undefined) => {
    if (!raw) return
    if (/^https?:|^data:/i.test(raw)) return
    hrefs.add(raw)
  }
  const linkRe =
    /<link[^>]+rel=["'](?:modulepreload|stylesheet)["'][^>]*?(?:href|src)=["']([^"']+)["'][^>]*>/gi
  const scriptRe = /<script[^>]+src=["']([^"']+)["']/gi
  for (const m of html.matchAll(linkRe)) add(m[1])
  for (const m of html.matchAll(scriptRe)) add(m[1])
  return [...hrefs].sort()
}

// Base-prefix a dist-relative path the same way Vite emits the
// index.html-derived precache URLs (absolute, under the configured base),
// so the two sets dedupe and the SW resolves them against its scope. Base
// is read the same way vite.config.ts derives it.
const base = (() => {
  let b = process.env.APP_BASE_PATH?.trim() || '/'
  if (!b.startsWith('/')) b = `/${b}`
  if (!b.endsWith('/')) b = `${b}/`
  return b
})()
const toBaseUrl = (rel: string): string => `${base}${rel.replace(/^\/+/, '')}`

// Every emitted file under dist/, as dist-relative POSIX paths. The full set
// is what `collectRestAssets` filters down to the SW-cacheable assets — no
// static import walk needed (or possible: user extensions import `@/…` modules
// at runtime, which the bundler's graph can't see), so we precache the whole
// emitted graph rather than a reachable closure.
const walkDistFiles = (): string[] => {
  const out: string[] = []
  const walk = (absDir: string, relDir: string) => {
    for (const entry of readdirSync(absDir, {withFileTypes: true})) {
      const abs = resolve(absDir, entry.name)
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(abs, rel)
      else if (entry.isFile()) out.push(rel)
    }
  }
  walk(distDir, '')
  return out
}

const buildId = resolveBuildId()

// Two lists (see sw.ts). first-paint is the HTML-derived offline-boot set; rest
// is the full emitted graph minus first-paint (the SW installs it second so the
// boot-critical set lands first). The SW fetches BOTH with { cache: 'no-cache' }
// — a conditional revalidate that can't copy a stale prior-deploy entry into
// this generation. `collectRestAssets` drops any URL already in first-paint (no
// double fetch) and everything the SW wouldn't serve cache-first (maps, sw.js, …).
const firstPaintAssets = collectPrecacheAssets()
const restAssets = collectRestAssets({
  allFiles: walkDistFiles(),
  firstPaint: firstPaintAssets,
  toBaseUrl,
})
// The cross-origin esm.sh React URLs are absolute (not under dist/), so the walk
// above never sees them. Take the exact known-integrity set the import-map plugin
// injects into index.html — that's precisely what the app can import at runtime.
const vendorAssets = Object.keys(productionReactIntegrity).sort()

const fail = (msg: string): never => {
  console.error(`[inject-sw-build-id] ${msg}`)
  process.exit(1)
}

// The build-id + precache substitution — and the guards that make a botched
// stamp fail the BUILD rather than ship a dead worker — live in the pure,
// unit-tested stampSwSource (see stamp-sw-source.test.ts, which pins the
// minification robustness across quote styles). Here we just feed it the
// worker source + collected lists and turn a thrown failure into a clean exit.
const source = (() => {
  try {
    return stampSwSource(readFileSync(swPath, 'utf8'), {
      buildId,
      firstPaintAssets,
      restAssets,
      vendorAssets,
    })
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
})()

writeFileSync(swPath, source)
console.log(
  `[inject-sw-build-id] stamped sw.js with ${buildId}, ` +
    `${firstPaintAssets.length} first-paint + ${restAssets.length} rest + ` +
    `${vendorAssets.length} vendor precache assets`,
)
