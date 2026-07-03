/**
 * Enumerate every same-origin runtime asset the service worker serves
 * cache-first, so `inject-sw-build-id.mjs` can precache the WHOLE emitted
 * module graph into each generation's cache — not just the first-paint set.
 *
 * Why full precache (supersedes the old babel-only `precache-lazy-assets`
 * closure): the prod build ships modules at UNHASHED, stable URLs
 * (`preserveModules` + `[name].js`), so cross-build consistency rests
 * entirely on `public/sw.js` pinning each deploy to its own generation cache
 * and never grafting foreign-generation bytes onto a page. That invariant
 * only holds for assets that are actually IN the generation cache. Anything
 * lazy — e.g. the extension surface `src/extensions/api.js`, imported only at
 * runtime by user-extension blocks and therefore never first-painted — was
 * NOT precached, so on a cache miss the SW's network fallback
 * (`assetCacheFirst`) served the NEWEST generation's copy, grafting new bytes
 * onto an old page. When the new copy's exports drifted from the old page's
 * already-resolved siblings, the browser threw
 * `does not provide an export named …`. Precaching the full asset set closes
 * that gap (each page only ever reads its own complete generation) and, as a
 * bonus, makes the app fully offline-capable — every module it can lazily
 * import is already in Cache Storage.
 *
 * The extension set MIRRORS `public/sw.js`'s `ASSET_EXTENSION` /
 * `isCacheableAsset`: we precache EXACTLY what the SW serves from the
 * generation cache — no more. That deliberately excludes:
 *   - `*.map`   — dev/DevTools only (~30 MB), never fetched by the running app;
 *   - `sw.js`   — the worker itself, managed by the SW lifecycle, not imported;
 *   - `version.json`, `*.html`, `*.webmanifest` — not asset-typed; the shell is
 *     handled separately (network-first) and `version.json` must stay fresh.
 *
 * Pure + dependency-injected (`allFiles` / `toBaseUrl`) so it unit-tests
 * without touching a real dist tree.
 */
// Keep in sync with ASSET_EXTENSION in public/sw.js — the set of same-origin
// files the SW serves cache-first from the generation cache. A drift-guard test
// in precache-assets.test.ts asserts the two literals stay identical.
export const ASSET_EXTENSION =
  /\.(?:js|mjs|css|wasm|woff2?|ttf|otf|png|svg|jpe?g|webp|gif|ico)$/

// The service worker file is same-origin JS but must never be cached as an app
// asset: it's fetched + version-checked by the SW machinery, never `import`ed.
// Matched by ROOT-relative path (not basename) so ONLY the emitted `dist/sw.js`
// is dropped — a bundled dep that happens to ship a nested `sw.js` stays
// precached (excluding it by basename would leave it to network-graft on a
// post-deploy miss).
const EXCLUDE_PATHS = new Set(['sw.js'])

/** True for a dist-relative path the SW would serve from the generation cache. */
export const isPrecacheableAsset = (relPath) =>
  ASSET_EXTENSION.test(relPath) && !EXCLUDE_PATHS.has(relPath)

/**
 * Partition the emitted graph into the "rest" precache list — every
 * precacheable asset that is NOT already in the first-paint set. The SW installs
 * first-paint and rest as two separate passes (first-paint first, since it's the
 * offline-boot-critical set), BOTH with `{cache:'no-cache'}` — a conditional
 * revalidate that fetches this generation's bytes without copying a stale
 * prior-deploy HTTP-cache entry.
 *
 * Excluding first-paint keeps the SW from fetching those URLs twice. Output is
 * base-prefixed to match the first-paint URLs and how the SW resolves entries
 * against its scope.
 *
 * @param {object} p
 * @param {string[]} p.allFiles  dist-relative POSIX paths of every emitted file
 * @param {string[]} p.firstPaint base-prefixed first-paint URLs (from the HTML)
 * @param {(rel: string) => string} p.toBaseUrl dist-rel → base-prefixed URL
 * @returns {string[]} base-prefixed, deduped, sorted
 */
export const collectRestAssets = ({allFiles, firstPaint, toBaseUrl}) => {
  const firstPaintSet = new Set(firstPaint)
  const rest = new Set()
  for (const rel of allFiles) {
    if (!isPrecacheableAsset(rel)) continue
    const url = toBaseUrl(rel)
    if (firstPaintSet.has(url)) continue
    rest.add(url)
  }
  return [...rest].sort()
}
