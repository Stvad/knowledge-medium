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
 *      offline reload would fail to boot. Installed `{ cache: 'default' }`
 *      (the page just fetched these exact URLs).
 *   3. The must-be-offline LAZY asset list (`__PRECACHE_LAZY_ASSETS__`) —
 *      chunks not in the first-paint graph but needed offline, plus their
 *      transitive deps (`@babel/standalone` — see
 *      scripts/precache-lazy-assets.mjs). Kept SEPARATE because the SW
 *      installs them `{ cache: 'reload' }`: they weren't first-painted and
 *      their unhashed URLs carry per-deploy-varying bytes, so a default
 *      fetch could copy a stale prior-deploy entry into this generation.
 *
 * Fails the build if any placeholder is missing — all are required for the
 * SW to behave correctly.
 */
import {readFileSync, writeFileSync, existsSync, readdirSync} from 'node:fs'
import {execSync} from 'node:child_process'
import {dirname, resolve, relative, sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {transitiveClosure} from './precache-lazy-assets.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(__dirname, '..', 'dist')
const swPath = resolve(distDir, 'sw.js')

if (!existsSync(swPath)) {
  console.error(`[inject-sw-build-id] missing ${swPath} — run vite build first`)
  process.exit(1)
}

const resolveBuildId = () => {
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
const collectPrecacheAssets = () => {
  const html = readFileSync(resolve(distDir, 'index.html'), 'utf8')
  const hrefs = new Set()
  const add = (raw) => {
    if (!raw) return
    if (/^https?:|^data:/i.test(raw)) return
    hrefs.add(raw)
  }
  const linkRe = /<link[^>]+rel=["'](?:modulepreload|stylesheet)["'][^>]*?(?:href|src)=["']([^"']+)["'][^>]*>/gi
  const scriptRe = /<script[^>]+src=["']([^"']+)["']/gi
  for (const m of html.matchAll(linkRe)) add(m[1])
  for (const m of html.matchAll(scriptRe)) add(m[1])
  return [...hrefs].sort()
}

// Lazy chunks that are NOT in the first-paint HTML graph but must be
// offline-available — and their transitive sibling-chunk deps. Today this
// is `@babel/standalone`, dynamically imported by compileExtensionModule
// on a compile-cache miss; without re-precaching it, a cold offline
// compile would fail (see scripts/precache-lazy-assets.mjs). Paths are
// dist-relative (POSIX), stable + unhashed thanks to preserveModules.
const LAZY_PRECACHE_ENTRYPOINTS = ['node_modules/@babel/standalone/babel.js']

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
const toBaseUrl = (rel) => `${base}${rel.replace(/^\/+/, '')}`

const collectLazyPrecacheAssets = () =>
  transitiveClosure(LAZY_PRECACHE_ENTRYPOINTS, {
    exists: (rel) => existsSync(resolve(distDir, rel)),
    readFile: (rel) => readFileSync(resolve(distDir, rel), 'utf8'),
  }).map(toBaseUrl)

const buildId = resolveBuildId()

// Two lists, fetched with DIFFERENT cache modes at install (see sw.js):
//   - first-paint assets → { cache: 'default' }: the page just fetched these
//     exact (unhashed) URLs, so the browser HTTP cache holds THIS generation's
//     bytes — copying them into Cache Storage is near-free and correct.
//   - lazy assets (Babel) → { cache: 'reload' }: these were NOT first-painted,
//     and their URLs are unhashed with bytes that vary per deploy, so a
//     { cache: 'default' } fetch could copy a STALE prior-deploy entry out of
//     the HTTP cache into this generation's cache. 'reload' forces the network
//     so the generation always gets its own bytes.
// A chunk that IS first-painted (e.g. the shared rolldown runtime that Babel
// also imports) stays in the first-paint list only — no double fetch.
const firstPaintAssets = collectPrecacheAssets()
const firstPaintSet = new Set(firstPaintAssets)
const lazyPrecacheAssets = [
  ...new Set(collectLazyPrecacheAssets().filter((u) => !firstPaintSet.has(u))),
].sort()

let source = readFileSync(swPath, 'utf8')

const requirePlaceholder = (placeholder) => {
  if (!source.includes(placeholder)) {
    console.error(`[inject-sw-build-id] placeholder ${placeholder} not found in sw.js`)
    process.exit(1)
  }
}
requirePlaceholder('__BUILD_ID__')
requirePlaceholder('__PRECACHE_ASSETS__')
requirePlaceholder('__PRECACHE_LAZY_ASSETS__')

// Embed as a JSON string then JSON.parse at runtime so the array can
// contain any number of entries without breaking the surrounding source.
const encodeArray = (arr) =>
  JSON.stringify(arr).replace(/\\/g, '\\\\').replace(/'/g, "\\'")

source = source.split('__BUILD_ID__').join(buildId)
source = source.split('__PRECACHE_ASSETS__').join(encodeArray(firstPaintAssets))
source = source.split('__PRECACHE_LAZY_ASSETS__').join(encodeArray(lazyPrecacheAssets))
writeFileSync(swPath, source)
console.log(
  `[inject-sw-build-id] stamped sw.js with ${buildId}, ` +
  `${firstPaintAssets.length} first-paint + ${lazyPrecacheAssets.length} lazy precache assets`,
)
