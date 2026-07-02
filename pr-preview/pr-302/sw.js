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
 *     generations and need not be re-fetched on every deploy.
 *   - HTML navigations: network-first, falling back to the cached shell.
 *   - Everything else (Supabase, PowerSync, agent relay): straight to the
 *     network, never cached.
 *
 * BUILD_ID / PRECACHE_ASSETS are replaced by scripts/inject-sw-build-id.mjs
 * after `vite build`. In dev the placeholders are harmless (the SW isn't
 * registered there).
 */

const CACHE_PREFIX = 'km-'
const BUILD_ID = '4e8a0a39425d'
const SHELL_CACHE = `${CACHE_PREFIX}shell-${BUILD_ID}`
const ASSET_CACHE = `${CACHE_PREFIX}assets-${BUILD_ID}`
const VENDOR_CACHE = `${CACHE_PREFIX}vendor`
const META_CACHE = `${CACHE_PREFIX}meta`

// Keep the current build plus the two previous ones, so a tab held open
// across up to two deploys stays pinned to a cache that still exists. Each
// retained generation is roughly one full asset cache (~15-17MB), so this
// is a storage-for-resilience trade — it does NOT scale with fleet size,
// only with how many deploys a single tab can span before it reloads.
// Beyond the window the stale tab degrades to live bytes (possible skew),
// and it's been nudged to reload by the update prompt the whole time.
const KEEP_GENERATIONS = 3

// VENDOR_CACHE / META_CACHE are never generation-GC'd: the scoped activate GC
// below only ever names this deploy's own shell-/assets-<id> caches, so these
// (and every sibling deploy's caches on this shared origin) are left untouched.

// The SW lives at <base>/sw.js, so its scope and registration URL share the
// app's base path. Resolve everything relative to the registration URL.
const scopeURL = new URL(self.registration.scope)
const SHELL_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png',
  './apple-touch-icon.png',
].map((p) => new URL(p, scopeURL).toString())

// Build-injected list of every JS/CSS asset the HTML pulls in on first
// paint (entry script + modulepreload + stylesheets). Without this,
// first-visit module fetches go around the SW (it activates after they're
// dispatched), and an offline reload right after first load would fail
// to boot. Replaced by scripts/inject-sw-build-id.mjs.
const PRECACHE_ASSETS = JSON.parse('["/knowledge-medium/pr-preview/pr-302/node_modules/@codemirror/autocomplete/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@codemirror/commands/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@codemirror/lang-css/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@codemirror/lang-html/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@codemirror/lang-html/node_modules/@codemirror/lang-javascript/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@codemirror/lang-javascript/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@codemirror/lang-markdown/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@codemirror/language/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@codemirror/lint/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@codemirror/search/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@codemirror/state/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@codemirror/theme-one-dark/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@codemirror/view/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@lezer/common/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@lezer/css/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@lezer/highlight/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@lezer/html/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@lezer/javascript/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@lezer/lr/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@lezer/markdown/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@marijn/find-cluster-break/src/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@powersync/react/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@powersync/web/lib/src/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/primitive/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-arrow/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-checkbox/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-collapsible/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-collection/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-collection/node_modules/@radix-ui/react-slot/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-compose-refs/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-context-menu/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-context/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-dialog/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-dialog/node_modules/@radix-ui/react-slot/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-direction/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-dismissable-layer/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-dropdown-menu/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-focus-guards/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-focus-scope/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-id/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-label/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-label/node_modules/@radix-ui/react-primitive/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-menu/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-menu/node_modules/@radix-ui/react-slot/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-popper/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-portal/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-presence/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-primitive/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-primitive/node_modules/@radix-ui/react-slot/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-roving-focus/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-slot/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-use-callback-ref/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-use-controllable-state/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-use-escape-keydown/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-use-layout-effect/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-use-previous/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@radix-ui/react-use-size/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@scure/base/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@supabase/auth-js/dist/module/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@supabase/postgrest-js/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@supabase/realtime-js/dist/module/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@supabase/storage-js/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@supabase/supabase-js/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@uiw/codemirror-extensions-basic-setup/esm/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@uiw/react-codemirror/esm/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/@ungap/structured-clone/esm/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/aria-hidden/dist/es2015/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/bail/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/ccount/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/chrono-node/dist/esm/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/chrono-node/dist/esm/locales/en/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/class-variance-authority/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/cmdk/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/cmdk/node_modules/@radix-ui/primitive/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/cmdk/node_modules/@radix-ui/react-dialog/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/cmdk/node_modules/@radix-ui/react-dialog/node_modules/@radix-ui/react-primitive/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/cmdk/node_modules/@radix-ui/react-dismissable-layer/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/cmdk/node_modules/@radix-ui/react-dismissable-layer/node_modules/@radix-ui/react-primitive/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/cmdk/node_modules/@radix-ui/react-focus-guards/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/cmdk/node_modules/@radix-ui/react-presence/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/cmdk/node_modules/@radix-ui/react-primitive/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/cmdk/node_modules/@radix-ui/react-primitive/node_modules/@radix-ui/react-slot/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/cmdk/node_modules/@radix-ui/react-slot/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/comma-separated-tokens/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/crelt/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/estree-util-is-identifier-name/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/extend/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/fast-deep-equal/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/fractional-indexing-jittered/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/get-nonce/dist/es2015/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/hast-util-to-jsx-runtime/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/hast-util-whitespace/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/html-url-attributes/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/iceberg-js/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/inline-style-parser/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/is-plain-obj/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/longest-streak/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/markdown-table/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/mdast-util-find-and-replace/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/mdast-util-find-and-replace/node_modules/escape-string-regexp/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/mdast-util-from-markdown/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/mdast-util-gfm-autolink-literal/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/mdast-util-gfm-footnote/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/mdast-util-gfm-strikethrough/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/mdast-util-gfm-table/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/mdast-util-gfm-task-list-item/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/mdast-util-gfm/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/mdast-util-phrasing/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/mdast-util-to-hast/lib/handlers/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/mdast-util-to-hast/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/mdast-util-to-markdown/lib/handle/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/mdast-util-to-string/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-extension-gfm/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-factory-destination/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-factory-label/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-factory-space/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-factory-title/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-factory-whitespace/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-util-character/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-util-chunked/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-util-classify-character/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-util-combine-extensions/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-util-decode-numeric-character-reference/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-util-decode-string/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-util-html-tag-name/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-util-normalize-identifier/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-util-resolve-all/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-util-sanitize-uri/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/micromark-util-subtokenize/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/property-information/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/react-markdown/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/react-player/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/react-remove-scroll-bar/dist/es2015/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/react-style-singleton/dist/es2015/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/remark-gfm/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/remark-parse/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/remark-rehype/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/sonner/dist/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/space-separated-tokens/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/style-to-js/cjs/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/style-to-object/cjs/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/trim-lines/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/trough/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/unified/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/unist-util-is/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/unist-util-position/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/unist-util-stringify-position/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/unist-util-visit-parents/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/unist-util-visit/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/vfile-message/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/vfile/lib/index.js","/knowledge-medium/pr-preview/pr-302/node_modules/w3c-keyname/index.js","/knowledge-medium/pr-preview/pr-302/src/components/ui/index.js","/knowledge-medium/pr-preview/pr-302/src/data/api/index.js","/knowledge-medium/pr-preview/pr-302/src/index.css","/knowledge-medium/pr-preview/pr-302/src/main.js","/knowledge-medium/pr-preview/pr-302/src/plugins/account-header/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/agent-runtime/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/alias/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/app-intents/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/attachments/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/backlinks-view/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/backlinks/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/backlinks/inline-counts/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/birthday/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/block-tagging/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/breadcrumbs/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/character-counter/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/colemak-keybindings/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/command-palette/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/daily-notes/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/data-integrity/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/db-maintenance/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/default-themes/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/extensions-settings/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/extract-type/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/find-replace/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/geo/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/grouped-backlinks/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/keybindings-settings/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/left-sidebar/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/merge-blocks/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/mobile-bottom-nav/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/mobile-keyboard-toolbar/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/onboarding/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/plain-outliner/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/quick-find/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/recents/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/references/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/references/markdown/blockrefs/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/references/markdown/wikilinks/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/roam-import/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/spatial-navigation/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/srs-rescheduling/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/srs-review/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/startup-metrics/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/storage-persistence/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/swipe-quick-actions/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/system-status/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/theme-toggle/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/todo/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/update-indicator/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/video-player/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/vim-normal-mode/index.js","/knowledge-medium/pr-preview/pr-302/src/plugins/workspace-header/index.js"]')
  .map((p) => new URL(p, scopeURL).toString())

// Build-injected list of must-be-offline LAZY chunks (e.g. @babel/standalone
// + transitive deps) that are NOT in the first-paint graph. Kept separate
// from PRECACHE_ASSETS because they're installed with a different cache mode
// (see install). Replaced by scripts/inject-sw-build-id.mjs.
const PRECACHE_LAZY_ASSETS = JSON.parse('["/knowledge-medium/pr-preview/pr-302/_virtual/_rolldown/runtime.js","/knowledge-medium/pr-preview/pr-302/node_modules/@babel/standalone/babel.js"]')
  .map((p) => new URL(p, scopeURL).toString())

const VENDOR_HOSTS = new Set(['esm.sh'])

// A production/root SW's scope (…/knowledge-medium/) is a PREFIX of every
// PR-preview path (…/pr-preview/pr-<n>/…), which are hosted on this same origin.
// Since we never clients.claim(), the production SW controls a freshly-opened
// preview page until it reloads — and would otherwise cache the preview's shell
// + assets under production's OWN keys, poisoning the offline production shell
// with an unmerged build. So a SW refuses to serve/cache a preview subtree it
// doesn't own. A preview's own SW (its scope IS under /pr-preview/) is exempt,
// so it still serves its own subtree normally.
const PREVIEW_SUBTREE = /\/pr-preview\/pr-[^/]+\//
const OWN_SCOPE_IS_PREVIEW = PREVIEW_SUBTREE.test(scopeURL.pathname)
const isForeignPreviewRequest = (url) =>
  !OWN_SCOPE_IS_PREVIEW && PREVIEW_SUBTREE.test(url.pathname)

// --- generation ledger ------------------------------------------------------
// An install-ordered list of BUILD_IDs (newest last), stored as a JSON
// Response under a synthetic key in META_CACHE. Lets `activate` GC every
// generation except the most recent KEEP_GENERATIONS without needing the
// build ids to be sortable (they're git shas).
const LEDGER_KEY = new URL('./__km_generations__', scopeURL).toString()

const readLedger = async () => {
  try {
    const cache = await caches.open(META_CACHE)
    const res = await cache.match(LEDGER_KEY)
    if (!res) return []
    const ids = await res.json()
    return Array.isArray(ids) ? ids : []
  } catch {
    return []
  }
}

const writeLedger = async (ids) => {
  const cache = await caches.open(META_CACHE)
  await cache.put(
    LEDGER_KEY,
    new Response(JSON.stringify(ids), {headers: {'content-type': 'application/json'}}),
  )
}

const recordGeneration = async (id) => {
  const ids = (await readLedger()).filter((x) => x !== id)
  ids.push(id)
  await writeLedger(ids)
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await recordGeneration(BUILD_ID)
      const [shell, assets] = await Promise.all([
        caches.open(SHELL_CACHE),
        caches.open(ASSET_CACHE),
      ])
      // Three cache modes, by what the browser's HTTP cache holds for each:
      //   - SHELL_URLS → 'reload': always pull fresh HTML/icons from network.
      //   - PRECACHE_ASSETS (first-paint) → 'default': the page just fetched
      //     these exact unhashed URLs, so the HTTP cache holds THIS
      //     generation's bytes — copying them into Cache Storage is near-free.
      //   - PRECACHE_LAZY_ASSETS (e.g. @babel/standalone) → 'reload': these
      //     were NOT first-painted and their unhashed URLs carry per-deploy-
      //     varying bytes, so a 'default' fetch could copy a STALE prior-
      //     deploy entry out of the HTTP cache into this generation's cache
      //     (an offline cold compile would then run old compiler bytes under
      //     the new build). 'reload' forces the network for the current bytes.
      // Per-URL failures are swallowed so one 404 can't strand install. For a
      // lazy entry that means a fetch failure here (offline/flaky during an SW
      // update) leaves it absent from this generation; a COLD offline compile
      // would then fail until the app is online once, at which point
      // `assetCacheFirst` fetches + caches it on demand (self-heal). The
      // persistent IndexedDB compile cache (survives deploys) covers the warm
      // case regardless.
      const fetchInto = (cache, url, mode) =>
        fetch(new Request(url, {cache: mode}))
          .then((res) => (res && res.ok ? cache.put(url, res) : null))
          .catch(() => null)
      await Promise.all([
        ...SHELL_URLS.map((u) => fetchInto(shell, u, 'reload')),
        ...PRECACHE_ASSETS.map((u) => fetchInto(assets, u, 'default')),
        ...PRECACHE_LAZY_ASSETS.map((u) => fetchInto(assets, u, 'reload')),
      ])
    })(),
  )
  // Become active immediately so the NEXT load is served by this build.
  // We do NOT claim — open pages keep their generation until they reload.
  self.skipWaiting()
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const ledger = await readLedger()
      const keepIds = new Set(ledger.slice(-KEEP_GENERATIONS))
      if (ledger.length > keepIds.size) await writeLedger([...keepIds])

      // Delete only THIS deploy's own now-expired generations. Cache Storage is
      // per-ORIGIN, so caches.keys() also lists the production deploy's caches
      // and every sibling PR preview's — all sharing the km- prefix, all live
      // (production + previews are served from the same origin). Blanket-deleting
      // km-* not in a keep-set would wipe THEIR caches. Our ledger holds only the
      // generation ids this scope installed, and ids don't collide across deploys
      // (distinct build shas), so mapping our expired ledger ids to cache names
      // targets exactly our own — never a sibling's. The current build's id is
      // the last ledger entry (recorded on install) so it's never expired; an
      // unreadable/empty ledger yields no deletions (safe); vendor/meta and this
      // build's caches are simply never named here.
      const expiredIds = ledger.slice(0, Math.max(0, ledger.length - KEEP_GENERATIONS))
      await Promise.all(
        expiredIds.flatMap((id) => [
          caches.delete(`${CACHE_PREFIX}shell-${id}`),
          caches.delete(`${CACHE_PREFIX}assets-${id}`),
        ]),
      )
      // NB: intentionally no clients.claim() — see the file header. Taking
      // over already-open pages is exactly what would let a new chunk land
      // in an old page mid-session.
    })(),
  )
})

const isNavigationRequest = (request) =>
  request.mode === 'navigate' ||
  (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'))

const isSameOrigin = (url) => url.origin === self.location.origin

const isVendor = (url) => VENDOR_HOSTS.has(url.hostname)

// Static build assets we serve cache-first within the generation. Match by
// request.destination (script/style/worker/font/image cover module imports,
// modulepreload, stylesheets, the wasm-sqlite worker and fonts) with an
// extension fallback for anything a browser leaves as an empty destination.
const ASSET_EXTENSION = /\.(?:js|mjs|css|wasm|woff2?|ttf|otf|png|svg|jpe?g|webp|gif|ico)$/
const isCacheableAsset = (request, url) =>
  isSameOrigin(url) &&
  (['script', 'style', 'worker', 'font', 'image'].includes(request.destination) ||
    ASSET_EXTENSION.test(url.pathname))

// Network-first for the SPA shell. We always read and write under a single
// canonical key so the many distinct navigation URLs (deep links,
// query-strings, hash routes) all share one cached HTML entry.
const shellNetworkFirst = async (request, shellURL) => {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const fresh = await fetch(request)
    if (fresh && fresh.ok) cache.put(shellURL, fresh.clone()).catch(() => {})
    return fresh
  } catch (err) {
    const cached = await cache.match(shellURL)
    if (cached) return cached
    throw err
  }
}

// Cache-first within THIS generation's caches, no revalidation. The
// generation's assets are immutable, so a hit is always correct and a miss
// (a lazy chunk not seen yet this session) is fetched once and stored so the
// page keeps reading the one build it booted with. We check the shell cache
// too (icons/manifest land there at install) — both belong to this
// generation, so there's no cross-version skew.
const assetCacheFirst = async (request) => {
  const assets = await caches.open(ASSET_CACHE)
  const cached =
    (await assets.match(request)) || (await (await caches.open(SHELL_CACHE)).match(request))
  if (cached) return cached
  try {
    const fresh = await fetch(request)
    if (fresh && fresh.ok) assets.put(request, fresh.clone()).catch(() => {})
    return fresh
  } catch {
    return Response.error()
  }
}

const cacheFirst = async (request, cacheName) => {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) return cached
  try {
    const fresh = await fetch(request)
    if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {})
    return fresh
  } catch {
    return Response.error()
  }
}

self.addEventListener('fetch', (event) => {
  const {request} = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  // Never let production's broad-scope SW touch a nested preview deploy's
  // requests — let them fall through to the network (the preview's own SW owns
  // them once active). See isForeignPreviewRequest.
  if (isForeignPreviewRequest(url)) return

  if (isNavigationRequest(request) && isSameOrigin(url)) {
    const shellURL = new URL('./index.html', scopeURL).toString()
    event.respondWith(shellNetworkFirst(request, shellURL))
    return
  }

  if (isCacheableAsset(request, url)) {
    event.respondWith(assetCacheFirst(request))
    return
  }

  if (isVendor(url)) {
    event.respondWith(cacheFirst(request, VENDOR_CACHE))
    return
  }
  // Default: don't intercept — let the browser handle it. This includes
  // other same-origin GETs like version.json, which must stay fresh.
})
