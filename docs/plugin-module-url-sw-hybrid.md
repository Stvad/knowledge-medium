# Plugin module loading: stable `/module/<blockId>` URLs via an in-thread producer + an on-demand service worker

> **Status: recommendation / investigation.** The decision hinge is **"are we willing to require a controlling
> service worker for *user* extensions?"** If yes, adopt the single-path, on-demand SW↔main design below — not
> because it's strictly *simpler* than today (it's a **lateral** trade: it removes blob-URL edge cases and adds
> SW-coordination ones), but because it's the only thing that unlocks **transitive cross-plugin imports**, with
> stable URLs / native (intra-realm) dedup as bonuses, on a single path with no dual blob/SW maintenance. If no,
> keep pure in-thread (the blob path) — a SW route behind a *mandatory* fallback is only additive cost. Either
> way, the one low-risk piece — source maps + a sanitized `//# sourceURL` on the blob path — **is implemented in
> the spun-out code PR #252** (`defaultTranspileViaBabel`, `COMPILER_VERSION` 1→2); **this is the doc-only PR**.
> The `compileExtensionModule.ts` line citations below assume #252 is applied (it's the only file #252 touches;
> other files' citations are unaffected). Grounded against `src/extensions/compileExtensionModule.ts`,
> `compiledModuleCache.ts`,
> `dynamicExtensions.ts`, `AppRuntimeProvider.tsx`, `src/extensions/api.ts`, `index.html` (importmap),
> `vite.config.ts` (`preserveModules`), `vite-plugins/unifySrcJsUrls.ts`, `src/sw/sw.ts` + `src/sw/worker.ts`,
> `src/registerServiceWorker.ts`, `src/sync/transform.ts` + `src/data/internals/syncObserver/materialize.ts`
> (in-thread decryption), `docs/lock-and-wipe-coarse-recommendation.md` (coarse platform wipe), and the
> media-attachments design (PR #230) §7.3 / §18 (the in-thread/SW decryption fork — the direct analog; external
> PR, that doc isn't in this repo tree, so its §-refs aren't locally verifiable).
> Last verified against code: 2026-06-23.

## TL;DR

**The earlier "is the SW worth the additive cost?" framing was rigged** — it compared pure in-thread against the
*worst* version of the SW path (a SW route bolted on top of a **mandatory** blob fallback you keep forever). The
real choice is a single yes/no:

**Are we willing to require a controlling service worker for *user* extensions?** This is reasonable here
because the `/module/` path only ever affects **user-authored extension blocks** — the built-in plugins are
ordinary bundled ES modules that never touch it (§4.3) — and the SW-unavailable environments (private mode,
no-storage, policy-blocked) are *already* a broken tier for this local-first app (no persistent SQLite, no
IndexedDB, no Cache). "Custom extensions also sit out when storage/SW is unavailable" is consistent with that
tier, not a new cliff; the app still boots and runs on its built-ins.

- **If yes →** adopt a **single-path, on-demand** design: the in-thread compile core is reused, but the
  **loader changes** from "instantiate a blob, read `.default`" to "mint `${BASE_URL}module/<id>?v=<hash>` and
  `import()` it"; the SW is a **dumb on-demand proxy** that, on that fetch, asks the page to **produce the
  compiled bytes** (a new approval-gated byte helper, *not* `loadApprovedExtension`, which instantiates — §3.1).
  This removes the machinery the *producer-writes-Cache* variant would have needed (a module Cache, its GC, the
  pre-materialization phase) and removes the blob path; it does **not** make the system strictly simpler than
  today (it trades blob-URL edge cases for SW-coordination ones — §6). First-visit control is handled by
  **page-initiated `clients.claim()`** (§4), gated on the active worker matching the page build. The real payoff
  is the **capability**: transitive cross-plugin imports (no in-thread substitute), plus stable URLs and
  source-maps-via-URL, on one path with no dual maintenance.
- **If no →** keep pure in-thread (the blob path). The source-map win shipped separately in #252 (§6); the SW route
  isn't worth building if a fallback must shadow it.

Compiling **in** the SW is off the table either way (§6): the SW can't read the SQLite DB or run the trust gate,
and must never hold E2EE keys — which is exactly why the *producer* must stay in-thread and the SW must call
*it*.

---

## 1. Current mechanism

Plugin code lives in blocks of `type: 'extension'`. The loader walks them and, for each enabled+approved block,
compiles its source and reads `module.default` as an `AppExtension` (`src/extensions/dynamicExtensions.ts:220`).
The compile is a deliberate **two-step** pipeline (`src/extensions/compileExtensionModule.ts`):

1. **Transpile** TS/JSX → JS string via `@babel/standalone` (`react` + `typescript` presets), dynamically
   `import()`ed so the ~0.85 MB compiler stays out of the eager startup graph (`defaultTranspileViaBabel`,
   `compileExtensionModule.ts:148`). It now also emits an inline source map + a sanitized
   `//# sourceURL=km-extension://<blockId>.tsx` (the §6 change, shipped in PR #252).
2. **Instantiate** the JS string into an ESM module via a **Blob object URL** (`defaultInstantiateViaBlob`,
   `compileExtensionModule.ts:174`):
   ```ts
   const blob = new Blob([compiled], {type: 'text/javascript'})
   const blobUrl = URL.createObjectURL(blob)
   try { return await import(/* @vite-ignore */ blobUrl) }
   finally { URL.revokeObjectURL(blobUrl) }   // revoked immediately after import resolves
   ```

So today: **dynamic `import()` of a Blob object URL**, no `eval`, no SW.

**Inter-module imports resolve through the realm-global import map** in `index.html:37`
(`"react"`/`"react-dom"` → esm.sh, `"@/"` → `"./src/"`), *not* relatively. An import map is keyed to the
*document/realm*, not the importer's URL, and its relative address values (`./src/`) resolve against the
**document** base — which is why a Blob module can `import {…} from '@/extensions/api.js'`
(`src/extensions/exampleExtensions.ts:208`) and get **the same module instance the app uses**. In prod those land
on *stable* unhashed URLs because the Vite build uses `preserveModules:true` + `entryFileNames:'[name].js'`
(`vite.config.ts:138-142`); `vite-plugins/unifySrcJsUrls.ts` makes dev match by rewriting `/src/foo.tsx`→`.js`
(otherwise every `createContext`/store singleton duplicates — the `useRepo must be used within a RepoContext`
bug).

**What is and isn't deduped today (the SW path is often mis-sold here).** Module *identity* is not left to the
blob URL: `resolveCachedModule` (`compileExtensionModule.ts:197`) is a hand-rolled L1(content-hash→module) /
L2(blockId→{hash,promise}) cache — identical source → one instance, unchanged block → same reference (so React
doesn't remount renderer modules on every `refreshAppRuntime`). Across reloads the IndexedDB `CompiledModuleCache`
(`km-extension-compiled`, `compiledModuleCache.ts:100`) persists the **transpiled string** so a warm boot skips
Babel. So intra-session dedup *and* cross-reload recompute-avoidance already exist — just not via the browser's
native module map.

**Pain points the blob path can't fix on its own:** ~~no source maps~~ (fixed in PR #252, §6); **no stable module
identity URL** (the realm's own module map is bypassed — every blob is a fresh, immediately-revoked URL);
**no transitive plugin→plugin imports** (a blob URL is per-compile and unaddressable, so one block can't `import`
another — confirmed: no `/module/` or cross-block refs exist anywhere in `src/`); and **broken relative imports**
(a non-mapped `./foo` resolves against the `blob:` base → fails).

## 2. What stable URLs buy (and what they don't)

`import()` *fundamentally consumes a URL*, and a Blob URL is a poor one (revoked, unaddressable). This is the
inverse of media (PR #230 §7.3/§18), where the app-thread path won because `<img>` accepts a Blob, so the SW's
one trick — a stable URL — bought nothing. For modules the stable URL is the whole point. But be precise about
which wins are real:

- **Transitive imports — the one decisive win.** A stable `${BASE_URL}module/<otherId>` lets block A `import`
  block B. **Impossible** with blobs. It needs **no SW URL rewriting**: bare/app specifiers (`@/…`, `react`) keep
  resolving through the realm import map (which applies to a `${BASE_URL}module/<id>` module exactly as to a blob
  module), and the module URL is an absolute same-origin URL. **It must be base-prefixed
  (`${BASE_URL}module/<id>`), never root-absolute `/module/<id>`** — under a non-root `APP_BASE_PATH` the SW
  registers with `scope: import.meta.env.BASE_URL` (`registerServiceWorker.ts:41-44`), so a root-absolute path
  escapes scope. (Elsewhere in this doc a bare `/module/…` is shorthand for the route/prefix *concept*; every
  literal *import URL* is base-prefixed `${BASE_URL}module/…`.) Two wrinkles, both resolved **in-thread by the
  producer**, never the SW:
  - *Cache-busting*: the importing module must name the **versioned** URL `${BASE_URL}module/<otherId>?v=<hashB>`
    (the realm module map caches the unversioned URL for the realm lifetime). The producer pins transitive
    specifiers to `?v=<hash>` at compile time — a **static specifier scan + rewrite** of A's source that needs
    only each dep's **approved** `sourceHash` (a record lookup, no compile). (So "no pre-materialization" in §3.2
    means no Cache-*write-ahead* phase, not "no static analysis" — this scan stays, and cycle detection rides on
    it.)
  - *Which hash*: it's the dependency's **approved** `sourceHash` (its Gate-2 pin), never `sha256(live content)`.
    An unapproved dep was never produced, so A's import of it **fails closed** — correct #67 behavior. Net:
    cross-block imports resolve only between blocks both *enabled* and *approved* here.
- **Source maps / DevTools** — real, but obtainable on the blob path (shipped in #252, §6). Not a reason to need the SW.
- **Native dedup/identity** — marginal over the existing in-memory `CompileCache`, and **intra-realm only**: two
  plugins in one tab importing the same `${BASE_URL}module/<C>?v=…` dedupe natively, but two *tabs* still produce
  it independently (each has its own module map + producer). Not a cross-tab win.
- **Cache reuse** — a non-argument: the producer must run in-thread every boot regardless (decrypt + approval +
  compile), so there's no "serve a module without the producer." Recompute is already avoided by IndexedDB.

**Net:** the only thing stable URLs buy with no in-thread substitute is **transitive plugin→plugin imports**.
Everything else is already handled in-thread.

## 3. The design — SW-required, single-path, on-demand (if adopted)

The cleanest shape is **not** "producer writes a module Cache and the SW serves from it." It's the SW as an
**on-demand proxy to the in-thread producer** — which avoids a module Cache and its GC.

### 3.1 On-demand SW↔main proxy (no module cache, no GC)

- **SW** `fetch` for `${BASE_URL}module/<id>?v=<hash>`: `event.respondWith()` a promise that `postMessage`s the
  **requesting client** (`event.clientId` → `clients.get(...)`) over a `MessageChannel` — "produce `<id>@<hash>`"
  — and returns the reply bytes as `new Response(js, {headers:{'content-type':'text/javascript'}})`. Routing by
  `event.clientId` keeps it tab-correct (each tab answers its own imports) — **verify empirically** that
  `event.clientId` is reliably non-empty for module *subresource* fetches on the target engines (same hedge as the
  §4 hard-reload claim; it's the linchpin). Define the failure outcomes so a bad produce degrades to a per-block
  shell, never an app throw: **no client** (`clients.get` → `undefined`, client closed) → `503`; **producer
  throws** (syntax error) or **port timeout** → `500`/`503`; **unapproved** never reaches here (the loader doesn't
  mint the URL — fail-closed). Each surfaces as an `import()` rejection caught per-block (`dynamicExtensions.ts:211-229`)
  — though **verify** that a non-OK `Response` (a `500`/`503`, vs. a `Response.error()`/network failure) reliably
  rejects a module `import()` across target engines (same empirical-check class as `event.clientId` above).
  `/module/` bytes are trusted via the in-thread approval gate, not SRI.
- **Main thread**: a `navigator.serviceWorker` message handler that produces the **bytes** — a *new*
  approval-gated helper, **not** `loadApprovedExtension` (`compileExtensionModule.ts:382`), which *instantiates* a
  blob module and returns `CompileResult.module`, not a string. Calling that here would have no string to send, or
  would run the extension through the blob path before the browser imports `/module/`, double-firing top-level
  side effects and defeating single-path. The new helper reuses the existing transpile/approval logic
  (`transpileImpl` from the approved record, cold-/bump-only) and returns the compiled **string**.

This avoids the `km-modules` Cache store, the `PERSISTENT_CACHES` change, the versioned-key writes, and the
GC/prune. The "cache" is the browser's realm module map (keyed by URL). The in-thread produce-dedup/coalescing
cache (`CompileCache.byHash`, an in-flight `Promise`) stays — the module map dedupes *imports of a URL*, but only
an in-thread guard stops the producer re-running Babel / coalesces two concurrent produces of the same hash (the
URL doesn't exist yet while producing).

**No hard deadlock, but state why precisely.** The page-`import()`-vs-SW leg is safe (the page's `import()` is an
async pending promise, not a blocked event loop; the SW is a separate thread). The subtler leg: on a cold/bump
produce the helper does `import('@babel/standalone')` (`compileExtensionModule.ts:149`) — a `script` fetch that
itself routes through the SW's `isCacheableAsset` branch. That's safe regardless of cache state: a **hit** serves
Babel from cache, and even a **miss** falls through to a plain network fetch (`assetCacheFirst`, `sw.js:242-245`),
*not* a second produce round-trip — so the two legs never wait on each other. The remaining requirement is just
liveness: the `respondWith` promise must carry a **bounded timeout** so a stuck produce (e.g. an offline cold
compile with Babel absent) fails the import (→ shell) rather than hanging it forever.

**Offline cold-compile depends on Babel being precached** (`@babel/standalone/babel.js`, now covered by the
full-graph `PRECACHE_REST_ASSETS` list injected by `scripts/inject-sw-build-id.ts` — which precaches the whole
emitted asset graph, superseding the earlier babel-only closure). This is in tension with §4.2's "slim the
`install` `waitUntil`": full precache deliberately makes `install` heavier so each generation's cache is complete
(the fix for the cross-generation module-skew described in `src/sw/sw.ts`'s header). Modules are otherwise only
requested by a live page (the producer is always present), so there's no "serve a module without the producer"
offline gap.

**No *additional* plaintext at rest.** Under on-demand the compiled bytes never land in a Cache — they transit the
message port and live only in the realm module map (memory, gone on reload). But the design **keeps** the existing
IndexedDB approval store, which already holds plaintext `compiled` (`compiledModuleCache.ts:45-47`) — so there is
plaintext compiled JS at rest *in IDB* today, unchanged. The accurate claim is "no plaintext at rest beyond the
store that already holds it," not "none." See §5.

### 3.2 Why pre-materialization dissolves

With a producer-writes-Cache design, the loader would have to write a dep *before* a parent imports it — and
since the loader walks blocks **sequentially**, instantiating inline (`dynamicExtensions.ts:184-230`), a parent
processed first would import a not-yet-written dep and miss. That forced a topological "materialize-then-import"
phase.

On-demand makes the *write-ahead ordering* vanish. When A imports `${BASE_URL}module/<B>?v=<hashB>`, the browser
fetches it, the SW asks main, and **main produces B right then** (it has B's approved record). Module *production*
is demand-driven by the real import graph, in dependency order automatically — you can't request B's bytes before
the browser asks for them, so nothing must be written to a cache ahead of time. What does **not** vanish is the
**static specifier scan**: compiling A still requires rewriting A's dep refs to `${BASE_URL}module/<B>?v=<hashB>`,
which needs B's approved *hash* (a cheap record lookup, not a compile) and a scan of A's source. So "no
pre-materialization" = "no Cache write-ahead phase," not "no static analysis." Import **cycles** are a
content-hash fixpoint hazard; the rule rides on that same scan (e.g. drop `?v=` inside a detected strongly-
connected component, accepting reload-to-apply within the cycle) — they don't get a free pass from
demand-driving.

### 3.3 Route + ordering — load-bearing (mirrors media §7.3's "asset route must be FIRST")

A dynamically `import()`ed module has `request.destination === 'script'`, so it is **already caught by
`isCacheableAsset`** (`src/sw/assets.ts` lists `'script'` in its destination set) → served from this generation's caches → miss →
network → `Response.error()`. The new `/module/` branch **must be inserted before** `isCacheableAsset`, matched by
`url.pathname.startsWith(MODULE_PREFIX)` where `MODULE_PREFIX = ${base}module/`. Order: (1) navigations → shell;
(1.5) **`/module/` → on-demand proxy**; (2) cacheable assets; (3) vendor; (4) passthrough.

### 3.4 Versioned URLs and the live-edit limit

`?v=<hash>` is **required**, not a free dial: it's the same mechanism as the transitive pin (§3.2), so dropping it
breaks transitive cache-busting. (You could drop `?v=` *only* if you also forgo transitive imports — i.e. give up
the one feature this whole design is for — so treat `?v=` as load-bearing, and "reload to apply" as the behavior
*within* a cycle, §3.2.)

**Honest live-edit limit.** Re-approving block B mints `${BASE_URL}module/<B>?v=<newHash>`, and re-resolving the
loader imports that new URL → new module for B. But any **other** block that already imported
`${BASE_URL}module/<B>?v=<oldHash>` keeps the old instance in the realm module map until a reload. So an edit to a
block that *others import* is **not** picked up live for its importers — only a reload refreshes them. (The blob
path doesn't regress here because it has no transitive imports at all; this is a new consideration that arrives
*with* the transitive-import feature, not a loss against today.)

## 4. First-load control — page-initiated claim, and dropping the fallback

Plugins load at **startup**, exactly when a freshly-registered SW may not yet control the page. The SW
**deliberately omits `clients.claim()`** (see the `src/sw/sw.ts` header, and the `activate` note in `src/sw/worker.ts`) — a fresh install
`skipWaiting()`s to control the *next* load but leaves the current first-visit page uncontrolled for its
lifetime. So a first-visit `import("${BASE_URL}module/<id>")` goes around the SW → 404 → the plugin breaks (a
*feature*, not an image). This is the same hazard the media doc flags.

### 4.1 Page-initiated claim (not activate-time claim)

The naive fix — `clients.claim()` in `activate` — reintroduces version skew, because `activate` runs on **every
deploy** and would grab long-open pages that already loaded the *old* generation, then serve them a *new*-gen lazy
chunk. Page-initiated claim is better but **not automatically skew-safe** (Codex #251): after a deploy,
`navigator.serviceWorker.ready` can resolve to the *previous* active worker before the new `sw.js` installs, so a
naive `CLAIM` could let an **old** generation claim a **current**-build page — and since the SW then
serves same-origin scripts cache-first from *its* generation cache, later lazy/module fetches become old bytes in
a new app. So the handshake must claim only a worker whose **generation matches the page build**:

- SW: a `CLAIM` message handler that calls `self.clients.claim()` **only if** its own `BUILD_ID` matches a build
  id the page sends (or the page waits for the matching worker to `activate` first); **no** claim in `activate`.
- Bootstrap: if `!navigator.serviceWorker.controller`, `await navigator.serviceWorker.ready`, then `postMessage`
  `CLAIM` **with this page's build id**, and `await Promise.race([` one `controllerchange`, `timeout(N) ])`
  before resolving the dynamic-extension subtree (the timeout is §4.2's terminal branch — never an unbounded
  await).

**Scope of the skew-safety claim.** Once the generations match, claim is skew-safe **for `/module/` bytes**
regardless — they're produced by main from the IDB approval record, not served from the generation asset caches,
so the controller's generation is irrelevant to them. The generation gate above is what protects the page's
**ordinary lazy app chunks** (which *are* served from the generation caches) from the deploy-mid-boot window. A
long-open page across a deploy is **already controlled**, so it never enters the ask-path and keeps its
generation until reload (the no-`claim()` property, preserved); the controller guard at
`registerServiceWorker.ts:52` is unaffected.

### 4.2 Why this can drop the fallback entirely

Gate **only the dynamic (user) extension resolve** on control — not the whole app. This fits the existing
**two-stage cold start**: `AppRuntimeProvider.tsx:114-182` commits the sync `baseRuntime` (kernel + **static**
plugins) immediately and paints, then resolves `dynamicExtensionsExtension` in a later effect and swaps it in. So
user extensions *already* arrive late by design — making them wait for `controllerchange` delays only their
appearance, never app paint. Minimize even that by keeping the SW's `install` `waitUntil` slim so `activate` +
claim fires in tens of ms rather than after a full precache.

**The gate must have a terminal state — there is no unbounded await.** The `controllerchange` wait is
`Promise.race([controllerchange, timeout(N)])` (§4.1). On the happy path the cost is **first-visit latency**
(absorbed by the two-stage paint above). On timeout — silent registration failure (`registerServiceWorker.ts:79`
swallows the `.catch`), a `clients.claim()` that never fires `controllerchange` (the hard-reload case below), or
no SW at all — the bootstrap **resolves the dynamic subtree anyway**; the `/module/` imports then 404, and the
loader's **per-block** `try/catch` (`dynamicExtensions.ts:211-229`) turns each into an error **shell** in
settings, not an app-level throw. So "first-visit latency, not dropped functionality" holds *only* on the happy
path; on timeout it **is** dropped functionality (user extensions don't load) — but it degrades exactly like the
SW-unavailable tier below (app fine on built-ins), which is the whole point of being willing to require a SW.
Remaining edges, all acceptable under "require SW for user extensions":

- **Hard reload** (Shift+Reload loads uncontrolled by the browser's choice): page-initiated claim *recovers*
  control post-load (you can't *prevent* the uncontrolled load). **Verify empirically** whether `clients.claim()`
  reliably takes a hard-reloaded client; if some engine refuses, that one forced-refresh load runs without user
  extensions until the next normal navigation — minor, not a reason to keep a blob path.
- **SW genuinely unavailable** (private mode / policy / unsupported / registration failure): user extensions
  don't load; the app still boots and runs on its built-ins. We **decide not to support** custom extensions in
  this already-degraded tier rather than maintain a parallel blob path for it (optionally surface a one-time
  "custom extensions need a service worker" notice).

### 4.3 Why "require SW" is scoped, not reckless

Requiring a SW would be reckless if the **core app** depended on `/module/`. It doesn't: only user-authored
`type:'extension'` **blocks** compile through this path. The built-in plugins (`staticAppExtensions` — daily-notes,
backlinks, command-palette, …) are ordinary ES modules in the app bundle, imported through the normal module graph
+ import map, never Babel/blob/`/module/`. So "require SW" degrades exactly one non-core feature, in exactly the
tier that's already degraded.

## 5. E2EE

Already satisfied by the existing in-thread decryption boundary, and *strengthened* by the on-demand variant:

- **Keys never reach the SW.** Block content is decrypted **in-thread** by the sync observer: `materializeStagingRows`
  runs `decodeFromWire` (`src/sync/transform.ts:112`, called at `materialize.ts:314`) in the page/worker context
  and upserts **plaintext** into the local `blocks` table (`materialize.ts:365`). The loader reads `block.content`
  (`dynamicExtensions.ts:160`) and never sees ciphertext. So the producer consumes already-decrypted content; the
  SW gets only the compiled output, over the message port. No `getCek`, no `km-e2ee-keys`, no mode pin in the SW —
  none of the SW-readable-state machinery the media SW-path needed (its §7.1.1) applies, because the producer
  (main), not the SW, does the privileged work.
- **No *additional* plaintext at rest.** The IndexedDB approval store already holds plaintext `compiled` today
  (`compiledModuleCache.ts:45-47`), and the design keeps it — so "no plaintext at rest" is wrong; the accurate
  claim is that on-demand adds **none beyond** that (the compiled bytes transit the message port and live only in
  the realm module map). Were a producer-writes-Cache variant chosen instead, its plaintext JS in the Cache would
  still be acceptable: the coarse platform "clear site data" wipe (`WipeLocalDataDialog`,
  `docs/lock-and-wipe-coarse-recommendation.md` §0.1) clears the Cache API and OPFS (and the IDB store) atomically,
  outside the page/SW context — no bespoke Lock-&-Wipe participant.

## 6. Alternatives considered, and the recommendation

**Compile *in* the SW — rejected.** The SW can't read the SQLite DB (the `OPFSCoopSyncVFS` sync access handles are
dedicated-worker-only; PowerSync's multi-tab SharedWorker is internal/unreachable from a SW), can't run the
device-local approval gate (`dynamicExtensions.ts:146-172`), and must never hold E2EE keys. The producer *must* be
in-thread — which is the whole reason the SW must call *it* (§3).

**Have the SW read the `km-extension-compiled` IndexedDB store directly — rejected.** The SW *can* read IndexedDB
(unlike the SQLite DB), and the records are plaintext, so this is tempting. But it doesn't pay off: (1) it doesn't
fix the first-load gap (that's about *control*, upstream of which store the SW reads); (2) the SW can't keep a
record *current* — a `COMPILER_VERSION` bump recompiles from `approvedSource` via Babel
(`loadApprovedExtension`), which the SW shouldn't run, so it would serve stale-compiler output (and the raw record
lacks the transitive-URL rewriting); (3) it would turn the SW back into a second producer that must understand the
approval schema yet *can't* do the compile half. On-demand SW↔main gets the same "no separate cache" benefit
while keeping the producer the single source of truth.

**Producer-writes-Cache + a mandatory blob fallback — rejected as the rigged comparison.** If a blob fallback must
shadow the SW route forever (for the uncontrolled first load), the SW route is pure *additive* cost and isn't
worth it. That conclusion is real — but it's an argument against the *fallback*, not against the SW. Removing the
fallback (§4) is what makes the SW path a *replacement* instead of an addition.

**Keep pure in-thread (blob) — the answer if we will NOT require a SW.** Shipped in the spun-out code PR #252:
the source-map win. `defaultTranspileViaBabel` now passes `sourceMaps:'inline'` + `sourceFileName` and appends a stable, **sanitized**
`//# sourceURL=km-extension://<safeId>.tsx` (`compileExtensionModule.ts:161-168`); `blockId` is threaded through
`TranspileImpl` and its three call sites; `COMPILER_VERSION` bumped `1`→`2` (`:15`) so map-less cached output
regenerates. (Security: block ids are caller-suppliable plain text, so the id is restricted to `[A-Za-z0-9._-]`
before it touches emitted JS — a line terminator would otherwise break out of the `//# sourceURL` comment and
inject module-level code, bypassing the #67 gate.) This fixes the sharpest everyday pain with no SW, no cache, no
first-load gap.

### Recommendation

**Decide the hinge first: will we require a controlling service worker for user extensions?**

- **Yes → build the §3/§4 design.** Justify it by the **capability**, not by simplicity: it's a single path (no
  dual blob/SW maintenance) that unlocks stable URLs, intra-realm dedup, and the one thing with no in-thread
  substitute — **transitive cross-plugin imports**. Be honest that it's a *lateral* complexity trade, not a net
  simplification of today: it removes the blob path *and* the machinery a producer-writes-Cache variant would
  need (module Cache, GC, write-ahead phase), but it **adds** the SW↔main produce protocol (`clientId` routing,
  no-client/timeout handling, failure→`Response` mapping), the generation-gated claim + `controllerchange`
  timeout, a **loader change** from blob-instantiate to URL-`import()`, the new byte-producing helper, and the
  static transitive scan. "A route + a handler + a claim" undercounts it.
- **No → stop at the shipped source-map change.** Don't build a SW route that a fallback must shadow.

Given user extensions are non-core and SW-unavailable is already a broken tier (§4.3), requiring a SW for them is
a reasonable line. I lean **yes**, but more conditionally than the first draft implied: it depends on the team
accepting the scope *and* on three load-bearing items proving out — the §4.1 generation-gated claim handshake,
the §4.1 hard-reload `clients.claim()` behavior (empirically unverified), and `event.clientId` being reliably
populated for module subresource fetches (§3.1).

### Scope, if adopted (in dependency order)

1. **Byte-producing helper + message handler** (`compileExtensionModule.ts` / a small `extensions/moduleHost.ts`):
   a *new* approval-gated "produce compiled **bytes** for `{id, hash}`" helper (reuses `transpileImpl` + the
   approval record; does **not** instantiate, unlike `loadApprovedExtension`), and the message handler that calls
   it and replies over the port. Also **re-plumb the loader** (`dynamicExtensions.ts`) from blob-instantiate to
   minting + `import()`ing `${BASE_URL}module/<id>?v=<hash>` and reading `.default` off the namespace — real
   loader churn, not zero.
2. **Transitive-import hash pinning** (producer): rewrite a dep ref → `${BASE_URL}module/<dep>?v=<depApprovedHash>`
   from each dep's **approved record** (cheap lookup, no compile); unapproved deps fail closed. The fiddliest
   piece; also defines the authoring specifier for "import another block."
3. **`src/sw/worker.ts`**: new `/module/` branch **before** `isCacheableAsset` (§3.3) that proxies to the requesting
   client via `MessageChannel`, with the no-client/timeout/produce-failure → `Response` mapping (§3.1); add the
   **generation-gated** `CLAIM` handler (§4.1); keep Babel in precache.
4. **Bootstrap gate** (`AppRuntimeProvider` / `registerServiceWorker`): page-initiated, **build-id-matched** claim,
   then gate the **dynamic** resolve on `Promise.race([controllerchange, timeout])` with the §4.2 terminal branch
   (resolve anyway → per-block shells); keep the `install` `waitUntil` slim *without* dropping Babel precache (§3.1).
5. **Tests**: route ordering (a `/module/` request isn't swallowed by the asset branch); the SW↔main produce
   round-trip (incl. `event.clientId` routing, missing-client → 503, produce-throw → shell); generation-gated
   claim → `controllerchange` gating **and the timeout terminal branch** (no SW → per-block shells, app still
   boots); transitive `?v=` pinning from the approved hash + unapproved-dep fail-closed; cycle handling. No
   module-Cache / Lock-&-Wipe tests (there's no module cache).

**Main risks:** (1) the first-load control handshake — a regression breaks user-extension load, so the
generation-gated claim → `controllerchange` gate and its **timeout terminal branch** must be solid; (2) SW route
ordering — a `/module/` request silently served by the asset branch yields a confusing miss; (3) `clients.claim()`
on a **hard reload** and `event.clientId` on module subresource fetches — both empirically unverified linchpins;
(4) transitive cache-busting / cycles — wrong `?v=` pinning gives stale plugin code, cycles need the §3.2 rule;
(5) the generation-gate itself — a CLAIM from an old worker would skew the page's lazy app chunks (§4.1). **Not
risks:** E2EE key exposure (producer in-thread, §5); plaintext-at-rest (on-demand adds none beyond the existing
IDB store; the coarse wipe covers all of it — §5); and pre-materialization *write-ahead* ordering (dissolved —
though the static transitive scan remains, §3.2).
