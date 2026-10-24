/// <reference lib="webworker" />
/* Knowledge Medium service worker.
 *
 * Versioning model — each deploy is an immutable "generation":
 *   - BUILD_ID (injected per build) namespaces this generation's caches:
 *     km-shell-<id> (HTML shell + icons) and km-assets-<id> (JS/CSS/fonts).
 *   - Same-origin app assets are served CACHE-FIRST with no revalidation.
 *     The build emits every module at an UNHASHED, stable URL (so plugins
 *     can import them through the import map), which means a
 *     URL's *bytes* differ between deploys. Pinning each generation to its
 *     own cache and never overwriting an entry in place is what keeps a
 *     generation internally consistent — a worker only ever serves the single
 *     build it was installed with, even across many small lazy-loaded modules.
 *     For that to hold for LAZY modules too, each generation's cache must be
 *     COMPLETE: `install` precaches the whole emitted asset graph (first-paint
 *     + every other cacheable asset, see PRECACHE_REST_ASSETS), so
 *     `assetCacheFirst` finds this generation's copy instead of falling through
 *     to the network — which serves the NEWEST generation and grafts
 *     foreign-build bytes onto an old page (the `does not provide an export
 *     named …` skew). The same completeness is what makes the app work OFFLINE,
 *     so `install` ALWAYS precaches the whole graph — we never skip it for
 *     storage; footprint is bounded by the activate GC instead. Caveat: this is
 *     only as good as the precache — a swallowed precache failure (flaky net,
 *     quota) leaves a hole, and a miss there still network-grafts. Fully
 *     closing the miss path (so the fallback refuses cross-generation bytes)
 *     needs a per-generation guard and is a follow-up, not done here.
 *   - A freshly installed worker self-skipWaiting()s, so it activates the
 *     moment install ends. Activation hands it every page this scope already
 *     controls (each gets `controllerchange`), and from then on such a page's
 *     lazy imports come from the NEW generation's cache, grafted onto its
 *     already-loaded modules. So a page of the previous build must not keep
 *     running: each reloads at its first safe moment (src/appUpdate.ts), and
 *     that reload — not the controller — is what keeps a page on one build.
 *     We do not call clients.claim(): it would only add pages loaded WITHOUT
 *     a worker (first visit, hard reload), which came from the network and
 *     are already the newest build.
 *   - On activate we keep only this generation, tracked by an install-order
 *     ledger: once this worker activates nothing serves an older one, since
 *     the pages that booted it are now this worker's. Older generations are
 *     garbage-collected.
 *   - esm.sh imports: cache-first in a single shared, un-namespaced cache —
 *     those URLs carry version + integrity, so they're immutable across
 *     generations and need not be re-fetched on every deploy. The React vendor
 *     set (the import map's integrity keys, __PRECACHE_VENDOR__) is precached at
 *     install so the app boots offline; anything else esm.sh serves is filled
 *     lazily on first use.
 *   - HTML navigations: CACHE-FIRST from this generation's own shell cache
 *     (network only on a cold miss). The shell is pinned like the assets, so a
 *     controlled load never mixes a new build's HTML with an old build's assets,
 *     and boot never waits on the network. The load that detects a deploy
 *     therefore still boots this generation; the new worker installs behind it
 *     and the reload above moves the page over.
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
import {idbBootStore} from './bootStore'

// The worker's global scope. `sw.ts` is a module (it imports), so this ambient
// declaration shadows lib.webworker's generic `self` with the service-worker
// type — giving `self.registration`, `self.skipWaiting()`, and correctly-typed
// install/activate/fetch/message events.
declare const self: ServiceWorkerGlobalScope

// Boot marks for on-device profiling (ios-device-debug skill): a page asks with
// `BOOT_MARKS` over a MessageChannel and gets this worker's own start time,
// when this script finished evaluating, and when the first navigation fetch
// arrived and was answered — all ms, `timeOrigin` as epoch so the page can
// place them on its own clock.
const bootMarks: Record<string, number> = {timeOrigin: performance.timeOrigin, evaluatedAt: 0, firstNavReceivedAt: 0, firstNavAnsweredAt: 0}
const mark = (name: string): void => { if (!bootMarks[name]) bootMarks[name] = performance.now() }

const sw = createServiceWorker(
  {
    buildId: '__BUILD_ID__',
    // The SW lives at <base>/sw.js, so its scope shares the app's base path;
    // everything resolves relative to it.
    scopeURL: new URL(self.registration.scope),
    // Only this build: no worker serves an older generation once this one is
    // active (see the header). Each generation is ~15-17MB of asset cache.
    keepGenerations: 1,
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
    mark,
    // WebKit only: the ~600 ms it saves is WebKit's Cache Storage start-up
    // cost, and a synthesised Response forfeits Chromium's V8 code cache,
    // which only rides on a `cache.match()` response. Every iOS browser is
    // WebKit; desktop Chrome and Android are not.
    bootStore: /AppleWebKit/.test(navigator.userAgent) && !/Chrom/.test(navigator.userAgent) ? idbBootStore() : undefined,
  },
)



self.addEventListener('install', (event) => {
  event.waitUntil(sw.install())
  // Activate as soon as install ends: that takes over every open page, which
  // then reloads onto this build (see the header).
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(sw.activate())
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
  if (event.data === 'BOOT_MARKS') event.ports[0]?.postMessage(bootMarks)
})

self.addEventListener('fetch', (event) => {
  // Pass waitUntil so the preview ledger heartbeat (maybeTouchOwnLedger) is tied
  // to this event's lifetime and can't be dropped by early worker termination.
  const response = sw.handleFetch(event.request, (p) => event.waitUntil(p))
  if (response && event.request.mode === 'navigate' && !bootMarks.firstNavReceivedAt) {
    mark('firstNavReceivedAt')
    void response.then(() => mark('firstNavAnsweredAt'), () => {})
  }
  if (response) event.respondWith(response)
})

mark('evaluatedAt')
