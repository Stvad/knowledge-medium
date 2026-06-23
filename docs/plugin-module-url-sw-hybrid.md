# Plugin module loading: stable `/module/<blockId>` URLs via an in-thread producer + service-worker cache (hybrid)

> **Status: recommendation / investigation.** Recommends a direction and scopes it; the one low-risk piece of
> it — source maps + a stable `//# sourceURL` on the blob path (the §6 "do this regardless" step) — **is
> implemented in this PR** (`defaultTranspileViaBabel`, `COMPILER_VERSION` 1→2). The SW `/module/` route is
> **not** built (deferred per the recommendation). Grounded against `src/extensions/compileExtensionModule.ts`,
> `compiledModuleCache.ts`,
> `dynamicExtensions.ts`, `AppRuntimeProvider.tsx`, `src/extensions/api.ts`, `index.html` (importmap),
> `vite.config.ts` (`preserveModules`), `vite-plugins/unifySrcJsUrls.ts`, `public/sw.js`,
> `src/registerServiceWorker.ts`, `src/sync/transform.ts` + `src/data/internals/syncObserver/materialize.ts`
> (in-thread decryption), `docs/lock-and-wipe-coarse-recommendation.md` (coarse platform wipe), and the
> media-attachments design (PR #230) §7.3 / §18 (the in-thread/SW decryption fork — the direct analog).
> Last verified against code: 2026-06-23.

## TL;DR

**Recommendation: keep the privileged work in-thread either way; do *not* adopt the SW `/module/` route now.
Instead take the cheap 80% in-thread — emit source maps + a stable `//# sourceURL` on the existing blob path
(done in this PR) — and defer the SW route until transitive cross-plugin imports
(`import "${BASE_URL}module/<otherId>"`) are an actual goal.** That one capability — a plugin block importing another plugin block by a real URL — is the only thing
blob URLs genuinely cannot do and the only thing the SW route uniquely buys. Everything else the SW route is
sold on (module dedup/identity, recompile avoidance, "real" cache reuse) is **already handled in-thread today**
by the in-memory `CompileCache` (dedup/identity) and the IndexedDB `CompiledModuleCache` (recompute avoidance).
The SW route adds a real, persistent maintenance surface — a new `public/sw.js` branch with strict ordering, a
new versioned module cache with its own GC, a transitive-import hash-rewriting pass in the producer, and a
**mandatory blob fallback you have to keep anyway** for the uncontrolled first load — in exchange for stable
URLs we can approximate without it.

If cross-plugin module composition *is* on the roadmap, the hybrid in this doc is the right shape for it, and
§3–§5 are the build plan. Compiling **in** the SW is off the table (§6): the SW cannot read the SQLite DB or
the device-local approval state, and putting E2EE keys in the SW is a non-starter.

---

## 1. Current mechanism

Plugin code lives in blocks of `type: 'extension'`. The loader walks them, and for each enabled+approved block
compiles its source and reads `module.default` as an `AppExtension`
(`src/extensions/dynamicExtensions.ts:125`). The compile is a deliberate **two-step** pipeline
(`src/extensions/compileExtensionModule.ts`):

1. **Transpile** TS/JSX → JS string via `@babel/standalone` (`react` + `typescript` presets),
   dynamically `import()`ed so the ~0.85 MB compiler stays out of the eager startup graph
   (`defaultTranspileViaBabel`, `compileExtensionModule.ts:129`). **No `sourceMaps`, no `//# sourceURL`** is
   passed — this is the source of the debugging pain below.
2. **Instantiate** the JS string into an ESM module via a **Blob object URL**
   (`defaultInstantiateViaBlob`, `compileExtensionModule.ts:142`):
   ```ts
   const blob = new Blob([compiled], {type: 'text/javascript'})
   const blobUrl = URL.createObjectURL(blob)
   try { return await import(/* @vite-ignore */ blobUrl) }
   finally { URL.revokeObjectURL(blobUrl) }   // revoked immediately after import resolves
   ```

So today's answer to "Blob URL? dynamic import? eval?" is: **dynamic `import()` of a Blob object URL**, no
`eval`, no SW.

**How inter-module imports resolve.** Not relatively — through the **realm-global import map** in
`index.html:37`:

```jsonc
"imports": {
  "react": "https://esm.sh/react@19.2.6?dev", "react/": ".../",
  "react-dom": "...", "react-dom/": ".../",
  "@/": "./src/"
}
```

An import map is keyed to the *document/realm*, not to the importer's URL, and its relative address values
(`./src/`) resolve against the **document** base URL, not the importer's. That is exactly why a Blob module can
do `import {blockRenderersFacet} from '@/extensions/api.js'` (the example extensions do —
`src/extensions/exampleExtensions.ts:208`) and get **the same module instance the app uses**: `@/` → `./src/` →
`https://origin/src/extensions/api.js`, a normal app asset. In prod this lands on a *stable* URL because the
Vite build uses `preserveModules:true` with `entryFileNames:'[name].js'` (`vite.config.ts:138-142`) — unhashed
module URLs the import map can name. In dev, `vite-plugins/unifySrcJsUrls.ts` rewrites `/src/foo.tsx` → `.js` so
kernel-imported and extension-imported copies of a module collapse to one module-map entry (otherwise every
`createContext`/store singleton duplicates — the `useRepo must be used within a RepoContext` class of bug).

**What is and isn't deduped today (important — the SW route is often mis-sold here).** Module *identity* is not
left to the blob URL. `resolveCachedModule` (`compileExtensionModule.ts:165`) is a hand-rolled
L1 (content-hash → module promise) / L2 (blockId → {hash, promise}) cache: two blocks with identical source
share one module instance, and re-resolving an unchanged block returns the *same reference* (critical so React
doesn't unmount/remount renderer modules on every `refreshAppRuntime`). Across reloads, the IndexedDB
`CompiledModuleCache` (`km-extension-compiled`, `compiledModuleCache.ts:100`) persists the **transpiled
string** so a warm boot skips Babel entirely. So intra-session dedup *and* cross-reload recompute-avoidance
already exist — just not via the browser's native module map.

**Concrete pain points that remain:**

- **No source maps / unusable stack frames.** Step 1 emits no map and step 2's URL is `blob:<uuid>` that is
  **revoked the instant the import resolves**. A throw inside plugin code surfaces as `blob:…:line:col`
  against a URL that no longer exists — no breakpoints, no original TSX. This is the sharpest everyday pain and
  it is purely a function of the blob path.
- **No stable module identity URL.** The realm's own module map is bypassed (every blob is a fresh, immediately
  revoked URL). Dedup works only because of the *parallel* hand-rolled `CompileCache`; any code path that
  imports a module URL without going through it gets a distinct instance.
- **No transitive plugin→plugin imports.** There is **no facility today for one extension block to import
  another** (`grep` for `/module/` is empty; cross-block refs don't exist). Authors can import `@/…` and bare
  esm.sh specifiers, but block B cannot `import` block A. A blob URL is per-compile and unaddressable, so
  there's nothing to import *by*.
- **Broken relative imports.** A non-mapped relative specifier (`import './util.js'`) resolves against the
  importer base = the `blob:` URL → fails. Authors must use `@/…` or bare specifiers.
- **"No cache reuse" is only half-true.** Module *instances* never survive a reload regardless of mechanism;
  the *transpile* is already reused across reloads via IndexedDB. So the cache-reuse argument for the SW is
  weaker than it sounds (see §2).

## 2. What stable URLs actually buy (and what they don't)

The JS loader's need for *real* URLs is genuine and is where modules differ from media. In the
media-attachments analysis (PR #230 §7.3 / §18) the app-thread path won because **`<img>` accepts a Blob
(object URL)** — the SW's one trick, a stable URL, buys almost nothing, so the SW's costs (can't read app/DB
state, the cold-start control gap) weren't worth paying. **Modules are the inverse**: `import()`
*fundamentally consumes a URL*, and a Blob URL is a poor one (revoked, unaddressable, no map). So the SW *can*
genuinely pay off. But be precise about which wins are real here:

- **Transitive imports — the one decisive win.** With a stable `${BASE_URL}module/<otherId>` served by the SW,
  block A can `import` block B. This is **impossible** with blobs. And — answering the import-maps-vs-SW-
  rewriting question directly — it needs **no SW URL rewriting**: bare/app specifiers (`@/…`, `react`) keep
  resolving through the realm import map (which applies to a `${BASE_URL}module/<id>` module exactly as it does
  to a blob module), and the module URL is an absolute same-origin URL the SW serves natively. **It must be
  base-prefixed (`${BASE_URL}module/<id>`), not root-absolute (`/module/<id>`)** — under a non-root
  `APP_BASE_PATH` the SW registers with `scope: import.meta.env.BASE_URL` (`registerServiceWorker.ts:41-44`),
  so a root-absolute `/module/…` would escape the worker's scope and never be intercepted (same base-prefix
  rule the media design notes for `${BASE_URL}asset/…`). The SW stays a dumb cache server keyed by the full
  URL; it never parses or rewrites import specifiers. **Two wrinkles, both resolved in-thread by the producer,
  not the SW:**
  - *Cache-busting* a transitive dep requires the *importing* module to name the *versioned* URL
    (`${BASE_URL}module/<otherId>?v=<hashOther>`), because the realm module map caches the unversioned URL for
    the realm lifetime and won't re-fetch it when the cache entry changes. So the producer **pins transitive
    specifiers to `?v=<hash>` at compile time** (a small rewrite pass, in-thread). Import maps are an
    alternative (a per-generation map of `<id>` → `<id>?v=<hash>`), but a document import map can't be mutated
    per-edit after load, so producer-side rewriting is the cleaner fit.
  - *Which hash* — it must be the dependency's **approved** `sourceHash` (its Gate-2 pin), never
    `sha256(live block.content)`. A dep that isn't approved on this device was never written to `km-modules`
    (the loader emitted a shell for it), so A's import of it **fails closed** — which is the correct #67
    behavior: a plugin can't pull in unapproved/drifted code through a transitive import. Net consequence:
    cross-block imports resolve only between blocks that are *both* enabled **and** approved here.
- **Source maps / DevTools** — real, but **achievable without the SW** (see §6 / the recommendation): a stable
  `//# sourceURL` and `sourceMaps:true` on the *blob* path already fixes stack frames and breakpoints. The SW
  URL is a nicer anchor but not required for this win.
- **Native module dedup/identity** — marginal over today. The in-memory `CompileCache` already gives one
  instance per content hash; the browser doing it via the module map is tidier and removes the parallel cache,
  but it is not a new capability for the single-loader path. It *does* matter for shared transitive deps (two
  plugins importing the same `/module/<C>?v=…` dedupe natively).
- **Cache reuse** — weakest argument. Because the producer must run in-thread on every boot anyway (decrypt +
  approval-gate + compile), the SW can never serve `/module/<id>` *before* the producer writes it that session.
  The Cache-API copy is a per-URL **handoff buffer to get a URL**, not an independent cache that saves work —
  recompute is already avoided by IndexedDB. Don't credit perf to the SW route.

**Net:** stable URLs materially beat Blob URLs for modules in exactly one way that has no in-thread substitute —
**transitive plugin→plugin imports**. Source maps and dedup are obtainable more cheaply.

## 3. The hybrid design, end-to-end (if adopted)

The hybrid keeps every privileged/expensive step in-thread and demotes the SW to a cache server, so it never
needs app/DB state or keys.

**Producer (in-thread, unchanged trust/compile core).** Extend `defaultInstantiateViaBlob`'s siblings with a
cache-write path **inside the existing approval-gated load path** (`dynamicExtensions.ts` →
`loadApprovedExtension`, `compileExtensionModule.ts:350`). The critical invariant: the producer operates on the
**approved record**, never live `block.content`.
1. **Compile the approved source, not the DB row.** As today, `loadApprovedExtension` instantiates
   `approval.compiled` (or recompiles `approval.approvedSource` on a compiler bump) — *never* live
   `block.content`. Live content is read **only to detect drift** (`dynamicExtensions.ts:160`); a synced edit
   stays inert (status `update-available`) until re-approved on this device. The cache write must inherit this:
   it writes the **approved** output, so a drifted edit can never be written to `km-modules` or imported before
   approval (this is the #67 Gate-2 guarantee — do not "optimize" by transpiling the live row).
2. Transpile (only on the cold/compiler-bump path) via Babel, **now with `sourceMaps:true`** and an inline map.
3. Resolve + **pin transitive specifiers to `${BASE_URL}module/<dep>?v=<depApprovedHash>`** — keyed by each
   dependency's **approved** `sourceHash`, not its live DB row (§2 wrinkle 2; unapproved deps fail closed).
4. Use the **approved** `sourceHash` as `contentHash` — it's already the L1 cache key and the value
   `loadApprovedExtension` returns as `CompileResult.contentHash` (the pin, *not* `sha256(live content)`).
5. `cache.put('${BASE_URL}module/<blockId>?v=<approvedSourceHash>', new Response(compiledJS,
   {headers:{'content-type':'text/javascript'}}))` into a dedicated **`km-modules`** cache. The key is
   **base-prefixed** so it matches the import URL and stays in SW scope (Codex #251; same rule as the
   transitive specifiers).
6. Hand the realm the URL: `import('${BASE_URL}module/<blockId>?v=<approvedSourceHash>')` **when the page is
   controlled**, else fall back to the existing blob `import()` (§4).

**SW route (serve from cache only).** A new branch in `public/sw.js`'s `fetch` handler:
```js
const isModuleRoute = (url) => isSameOrigin(url) && url.pathname.startsWith(MODULE_PREFIX) // `${base}module/`
// ...inside fetch handler, BEFORE isCacheableAsset:
if (isModuleRoute(url)) { event.respondWith(moduleCacheOnly(request)); return }
```
`moduleCacheOnly` matches `km-modules` by the **full URL including `?v=`** and, on a miss, returns a clear
error rather than hitting the network (there is no such file on the origin — GitHub Pages would 404). A miss is
a bug signal — but "writes-then-imports" only makes that true **per block**, not for transitive deps (see the
pre-materialization requirement below).

**Pre-materialization is mandatory for transitive imports (Codex #251).** Today the loader walks
`extensionBlocks` *sequentially*, `await`ing `resolveBlockModule(block)` — which instantiates inline — before
moving to the next block (`dynamicExtensions.ts:184-230`). If block A is processed before an enabled+approved
block B and A imports `${BASE_URL}module/<B>?v=…`, only A's entry exists when the browser fetches B's URL →
`moduleCacheOnly` misses → A's `import()` throws. So the loader must split into two phases: **(A) compile +
`cache.put` every enabled+approved block** into `km-modules` (write-only, no `import()`), in **dependency
order** so each dep's entry exists before any importer's; **(B) then `import()`** the entry modules. With
phase A complete, every `${BASE_URL}module/<id>?v=…` an importer can name is already in the cache, and a miss
really is a bug. (Cycles defeat a strict topological order — see the cycle risk in §6; disallow them or don't
version-pin within a cycle. The uncontrolled-first-load blob path sidesteps this differently — the producer
inlines deps as blob URLs while compiling the parent, §4.)

**Route ordering — load-bearing (mirrors media §7.3's "asset route must be FIRST").** A dynamically
`import()`ed module has `request.destination === 'script'`, so it is **already caught by `isCacheableAsset`**
(`public/sw.js:212` lists `'script'`), which serves from this generation's `km-assets-*`/`km-shell-*` →
miss → network → `Response.error()`. The `/module/` branch **must be inserted before** the `isCacheableAsset`
branch or the module route never runs. Order becomes: (1) navigations → shell; (1.5) **`/module/` → module
cache**; (2) cacheable assets; (3) vendor; (4) passthrough.

**Cache + invalidation.** Because the URL is content-hashed, an edit produces a *new* URL → new entry; old
`?v=` entries for that block are orphaned. Two housekeeping items:
- Add `km-modules` to **`PERSISTENT_CACHES`** (`public/sw.js:55`) so the per-deploy generation GC in `activate`
  doesn't delete it (modules version on *edit*, not on `BUILD_ID`).
- Prune stale versions: on each producer write, delete other `${BASE_URL}module/<blockId>?v=*` entries for that
  block (keep current). Cheap, bounds growth. Block delete/approval-revoke
  (`revokeExtensionApproval`, `compileExtensionModule.ts:399`) should also drop the block's `km-modules`
  entries.

## 4. The first-load / controller-readiness gap (the sharpest issue)

Plugins load at **startup** (`AppRuntimeProvider.tsx:134` resolves the dynamic-extensions runtime in an effect
right after mount), which is exactly when a freshly-registered SW may **not yet control the page**.
`public/sw.js` **deliberately omits `clients.claim()`** (`public/sw.js:13`, header comment) — a fresh install
`skipWaiting()`s to control the *next* load but **leaves the current first-visit page uncontrolled for its
whole lifetime**. `registerServiceWorker.ts` only registers; `navigator.serviceWorker.controller` is null on a
first visit. So on first load, `import('${BASE_URL}module/<id>?v=…')` goes **around the SW → 404 → the import
throws → the feature breaks** (a module failure breaks a plugin, not just a lazy image — much worse than the
media case).

This is the same hazard the media doc flags ("Render gates on SW readiness… `public/sw.js` deliberately omits
`clients.claim()`"). Evaluated options:

- **Gate plugin init on `navigator.serviceWorker.controller` — rejected.** Because there's no `clients.claim()`,
  a true first visit is *never* controlled until a reload. Gating would mean **plugins simply don't load on
  first visit**, which is unacceptable for a feature. Forcing a one-time reload on first activation is ugly and
  the existing update-prompt machinery doesn't even fire on first install (no prior controller —
  `registerServiceWorker.ts:48` guards on `controller`).
- **Adding `clients.claim()` — rejected.** It's omitted *on purpose* to prevent mid-session version skew
  (header comment, `public/sw.js:13-21`); claim is realm-global so you can't scope it to just `/module/`.
  Reintroducing it to serve modules would regress the generation-pinning design.
- **Blob `import()` fallback on the uncontrolled load — recommended.** The producer already holds the compiled
  JS string in hand (it just wrote it to the cache), so when `!navigator.serviceWorker.controller` it
  instantiates via the **existing** `defaultInstantiateViaBlob` path instead of the `/module/` URL. Essentially
  free, reuses today's code. Caveat: a blob-instantiated module that does `import "/module/<otherId>"` would
  still hit the network → 404; so in fallback mode the producer must **also inline/rewrite transitive deps to
  blob URLs** (it is compiling them and has their bytes), accepting that on the *first uncontrolled load only*
  you lose native dedup for shared deps. That degradation is transitional (next load is controlled) and
  acceptable.

**The fallback is mandatory, and that is itself an argument against the route:** you must keep the entire blob
path alive forever for first-load, so the SW route is *additive* complexity, never a replacement.

## 5. E2EE interaction

Clean, and already satisfied by the existing in-thread decryption boundary:

- **Keys never reach the SW.** Block content is decrypted **in-thread** by the sync observer:
  `materializeStagingRows` runs `decodeFromWire` (`src/sync/transform.ts:112`) in the page/worker context and
  writes **plaintext** into the local `blocks` table (`materialize.ts:314`). The loader reads
  `block.content` (`dynamicExtensions.ts:176`) and never sees ciphertext. So the producer trivially "decrypts
  in-thread" — it doesn't even do the decryption; it consumes already-decrypted content. The SW gets only the
  compiled output. No `getCek`, no `km-e2ee-keys`, no mode pin in the SW — none of the SW-readable-state
  machinery the media SW-path needed (§7.1.1 there) applies, because the producer, not the SW, does the
  privileged work.
- **The Cache holds plaintext compiled JS — acceptable now.** Destruction is the coarse platform "clear site
  data" wipe (`WipeLocalDataDialog`, `docs/lock-and-wipe-coarse-recommendation.md` §0.1): the browser's origin
  wipe clears the **Cache API and OPFS** along with everything else, atomically, outside the page/SW context.
  So `km-modules` needs **no bespoke Lock-&-Wipe participant wiring** — it's wiped like every other store. This
  is exactly the media doc's "No 'plaintext survives a lock' hazard… destruction is coarse" reasoning (§18),
  and it's why the hybrid doesn't reintroduce an app→SW purge handshake.

## 6. Recommendation

**Adopt: keep the privileged work pure in-thread; do not build the SW `/module/` route yet. Capture the main
pain (debugging) in-thread now; gate the SW route on a concrete need for cross-plugin imports.**

Why not the full hybrid today:
- The **only** capability the SW route uniquely unlocks is transitive `import "${BASE_URL}module/<otherId>"`
  between plugin blocks — which **does not exist as a feature or a request today** (no `module/` route, no
  cross-block imports anywhere in the tree).
- Its other selling points are already in-thread: dedup/identity (`CompileCache`), recompute-avoidance
  (IndexedDB `CompiledModuleCache`). Source maps are obtainable on the blob path.
- It is **not** a replacement for the blob path — the first-load fallback (§4) forces you to keep blobs
  forever — so it's pure additive surface: a `public/sw.js` branch with strict ordering, a versioned cache with
  its own GC and revoke-time cleanup, and a producer-side transitive-hash rewriting pass.

**Compiling in the SW — reject outright.** The SW cannot read the SQLite DB (the `OPFSCoopSyncVFS` sync access
handles are dedicated-worker-only, and PowerSync's multi-tab SharedWorker is internal/unreachable from a SW),
cannot read the device-local approval state (`dynamicExtensions.ts` gate 2), and must never hold E2EE keys.
The producer *must* be in-thread; this is the whole reason the hybrid (not pure-SW) is the only viable
SW-shaped option.

### Concrete next step (low risk, high value) — **done in this PR**

`defaultTranspileViaBabel` (`compileExtensionModule.ts`) now passes `sourceMaps: 'inline'` + `sourceFileName`
and appends a stable `//# sourceURL=km-extension://<blockId>.tsx` (the `blockId` is threaded through
`TranspileImpl` and the three call sites). `COMPILER_VERSION` was bumped `1` → `2` so existing map-less cached
output regenerates. This fixes readable stack traces and breakpoints (DevTools maps frames back to the original
TSX, named per extension) — the sharpest everyday pain — with **no SW, no cache, no first-load gap**. Risk:
negligible (a bad `sourceURL` only affects DevTools labels). The L1 cache is content-keyed, so two
identical-source blocks share one compiled string and thus one block's `sourceURL` — cosmetic only.

### If/when cross-plugin imports become a goal — adopt the §3 hybrid

Scope, in dependency order:
1. **Producer cache-write + dual instantiate** (`compileExtensionModule.ts`): write the **approved** compiled
   JS to `km-modules` keyed `${BASE_URL}module/<blockId>?v=<approvedSourceHash>` (the pin, never live content —
   §3 / §5; the Gate-2 invariant); instantiate via the base-prefixed `${BASE_URL}module/` URL when controlled,
   else the existing blob path (§4). ~1 file.
1a. **Split the loader into materialize-then-import** (`dynamicExtensions.ts`): the current sequential
   walk imports each block inline, so a parent can import a not-yet-written dep (Codex #251). Phase A
   `cache.put`s every enabled+approved block (write-only) in dependency order; phase B `import()`s the entries.
   A real structural change to the loader loop, not just the producer.
2. **Transitive-import hash pinning** (producer): rewrite a dep ref → `${BASE_URL}module/<dep>?v=<depApprovedHash>`
   from each dep's **approved record** (not its live DB row); unapproved deps fail closed; handle the
   blob-fallback inlining for the uncontrolled case. New, the fiddliest piece.
3. **`public/sw.js`**: new `/module/` branch **before** `isCacheableAsset` (§3 ordering); add `km-modules` to
   `PERSISTENT_CACHES`; cache-only serve. ~15 lines, but the ordering is load-bearing.
4. **GC**: prune stale `?v=*` per block on write; drop entries on `revokeExtensionApproval` / block delete.
5. **Tests**: route-ordering (a `/module/` request isn't swallowed by the asset branch), miss behavior,
   controlled-vs-uncontrolled instantiation fork, transitive `?v=` pinning, stale-version prune. The coarse
   wipe already covers `km-modules` (§5) — no Lock-&-Wipe test needed.

**Main risks:** (1) the first-load controller gap — a regression here breaks features, not images, so the blob
fallback must be airtight and tested; (2) SW route ordering — a `/module/` request silently served by the
existing asset branch yields a confusing miss; (3) **materialization order** — a parent imported before its dep
is written misses (Codex #251); the phase-A/phase-B split (step 1a) is what prevents it; (4) transitive
cache-busting — getting the `?v=` pinning wrong gives stale plugin code with no visible error; (5) cross-block
import **cycles** — content-hash URLs make a cycle's URLs mutually content-dependent (a fixpoint); disallow
cycles or don't version-pin within one.
**Not risks:** E2EE key exposure (producer is in-thread, §5) and wipe (coarse platform clear gets the cache,
§5).
