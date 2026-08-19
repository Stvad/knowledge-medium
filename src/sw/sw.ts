/// <reference lib="webworker" />
/* Knowledge Medium service worker.
 *
 * Versioning model — each deploy is an immutable "generation":
 *   - BUILD_ID (injected per build) namespaces this generation's caches:
 *     km-shell-<id> (HTML shell + icons) and km-assets-<id> (JS/CSS/fonts).
 *   - Same-origin app assets are served CACHE-FIRST with no revalidation.
 *     The Vite preserveModules build emits modules at UNHASHED, stable URLs
 *     (so plugins can import them through the import map), which means a
 *     URL's *bytes* differ between deploys. Pinning each generation to its
 *     own cache and never overwriting an entry in place is what keeps a
 *     generation internally consistent — a page only ever sees the single
 *     build it booted with, even across many small lazy-loaded modules.
 *     For that to hold for LAZY modules too, each generation's cache must be
 *     COMPLETE: `install` precaches the whole emitted asset graph (first-paint
 *     + every other cacheable asset, see PRECACHE_REST_ASSETS), so
 *     `assetCacheFirst` finds this generation's copy instead of falling through
 *     to the network — which serves the NEWEST generation and grafts
 *     foreign-build bytes onto an old page (the `does not provide an export
 *     named …` skew). The same completeness is what makes the app work OFFLINE,
 *     so `install` ALWAYS precaches the whole graph — we never skip it for
 *     storage; footprint is bounded by KEEP_GENERATIONS and reclaimed by the
 *     activate GC instead. Caveat: this is only as good as the precache — a
 *     swallowed precache failure (flaky net, quota) leaves a hole, and a miss
 *     there still network-grafts. Fully closing the miss path (so the fallback
 *     refuses cross-generation bytes) needs a per-generation guard and is a
 *     follow-up, not done here.
 *   - We deliberately do NOT call clients.claim(). A freshly installed
 *     worker self-skipWaiting()s so it becomes the ACTIVE worker (and thus
 *     controls the NEXT load — so one reload, the user's own or our update
 *     prompt's, lands fully on the new build). But an already-open page
 *     keeps its existing controller, and therefore its generation, until it
 *     reloads. That is what removes mid-session version skew: an old tab
 *     that lazy-imports a chunk after a deploy gets *its* generation's
 *     chunk from its own cache, not the just-deployed one grafted onto its
 *     already-loaded (old) modules.
 *   - On activate we retain the last KEEP_GENERATIONS generations (current +
 *     previous, tracked by an install-order ledger) so a tab still on the
 *     previous build has a consistent cache to read from. Older generations
 *     are garbage-collected.
 *   - esm.sh imports: cache-first in a single shared, un-namespaced cache —
 *     those URLs carry version + integrity, so they're immutable across
 *     generations and need not be re-fetched on every deploy. The React vendor
 *     set (the import map's integrity keys, __PRECACHE_VENDOR__) is precached at
 *     install so the app boots offline; anything else esm.sh serves is filled
 *     lazily on first use.
 *   - HTML navigations: CACHE-FIRST from this generation's own shell cache
 *     (network only on a cold miss). The shell is pinned like the assets, so a
 *     controlled load never mixes a new build's HTML with an old build's assets;
 *     a new deploy is applied on the next reload, and the app.checkForUpdates
 *     action / the update poll surface that a new build is available.
 *   - Everything else (Supabase, PowerSync, agent relay): straight to the
 *     network, never cached.
 *
 * This file is just the BOOTSTRAP: it reads the build-injected config, builds a
 * worker from it (src/sw/worker.ts holds the actual ledger/install/activate/
 * fetch logic, parameterized by its globals so it's unit-testable outside a
 * worker), and wires it to the SW events. BUILD_ID / PRECACHE_ASSETS /
 * PRECACHE_REST_ASSETS are replaced by scripts/inject-sw-build-id.ts after the
 * SW build. In dev the placeholders are harmless (the SW isn't registered there).
 */
import {createServiceWorker} from './worker'

// The worker's global scope. `sw.ts` is a module (it imports), so this ambient
// declaration shadows lib.webworker's generic `self` with the service-worker
// type — giving `self.registration`, `self.skipWaiting()`, and correctly-typed
// install/activate/fetch/message events.
declare const self: ServiceWorkerGlobalScope

const sw = createServiceWorker(
  {
    buildId: '__BUILD_ID__',
    // The SW lives at <base>/sw.js, so its scope shares the app's base path;
    // everything resolves relative to it.
    scopeURL: new URL(self.registration.scope),
    // Keep the current build plus the two previous ones, so a tab held open
    // across up to two deploys stays pinned to a cache that still exists. Each
    // retained generation is roughly one full asset cache (~15-17MB) — a
    // storage-for-resilience trade bounded by deploy-span, not fleet size.
    keepGenerations: 3,
    // Reap a PR-preview scope's leaked caches once it's sat untouched for 14
    // days (a merged preview's SW never runs again to clean up after itself).
    // Production is never a preview scope, so this can't touch prod caches.
    staleScopeMs: 14 * 24 * 60 * 60 * 1000,
    // A still-used preview refreshes its ledger at most once a day so it isn't
    // reaped for lack of a redeploy (well under the 14-day stale window).
    touchIntervalMs: 24 * 60 * 60 * 1000,
    // Build-injected: first-paint assets (entry script + modulepreload +
    // stylesheets — the offline-boot-critical set) and the rest of the emitted
    // graph (lazy chunks, @babel/standalone, wasm, fonts). Precaching all of it
    // is what makes each generation's cache self-contained (no network graft)
    // and the app offline-capable.
    precacheAssets: JSON.parse('__PRECACHE_ASSETS__') as string[],
    precacheRestAssets: JSON.parse('__PRECACHE_REST_ASSETS__') as string[],
    // Cross-origin esm.sh React URLs (import-map integrity keys) — precached into
    // the shared vendor cache at install so React resolves on an offline first load.
    precacheVendor: JSON.parse('__PRECACHE_VENDOR__') as string[],
  },
  {
    caches,
    fetch,
    origin: self.location.origin,
    now: () => Date.now(),
    storage: navigator.storage,
    indexedDB,
  },
)

self.addEventListener('install', (event) => {
  event.waitUntil(sw.install())
  // Become active immediately so the NEXT load is served by this build.
  // We do NOT claim — open pages keep their generation until they reload.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(sw.activate())
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  // Pass waitUntil so the preview ledger heartbeat (maybeTouchOwnLedger) is tied
  // to this event's lifetime and can't be dropped by early worker termination.
  const response = sw.handleFetch(event.request, (p) => event.waitUntil(p))
  if (response) event.respondWith(response)
})
