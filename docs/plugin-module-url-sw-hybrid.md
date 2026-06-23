# Plugin module loading: stable `/module/<blockId>` URLs via an in-thread producer + an on-demand service worker

> **Status: recommendation / investigation.** The decision hinge is **"are we willing to require a controlling
> service worker for *user* extensions?"** If yes, adopt the single-path, on-demand SW↔main design below — it's a
> genuine *simplification* (no blob path, no module cache, no GC, no pre-materialization) that unlocks stable
> URLs / native dedup / transitive cross-plugin imports. If no, keep pure in-thread (the blob path) — a SW route
> behind a *mandatory* fallback is only additive cost. Either way, the one low-risk piece — source maps + a
> sanitized `//# sourceURL` on the blob path — **is already implemented in this PR** (`defaultTranspileViaBabel`,
> `COMPILER_VERSION` 1→2). Grounded against `src/extensions/compileExtensionModule.ts`, `compiledModuleCache.ts`,
> `dynamicExtensions.ts`, `AppRuntimeProvider.tsx`, `src/extensions/api.ts`, `index.html` (importmap),
> `vite.config.ts` (`preserveModules`), `vite-plugins/unifySrcJsUrls.ts`, `public/sw.js`,
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

- **If yes →** adopt a **single-path, on-demand** design: the in-thread producer stays exactly as today
  (decrypt-already-done → approval-gate → compile), the SW is a **dumb on-demand proxy** that asks the producer
  for a module's bytes when the browser fetches `/module/<id>` (§3). This **deletes** the blob path, the module
  Cache store, its GC, *and* the pre-materialization/topological phase. First-visit control is handled by
  **page-initiated `clients.claim()`** (§4), which threads the version-skew needle. Net new SW surface: *a route
  + a message handler + a claim handler.* This is **simpler than today's blob path** and unlocks stable URLs,
  native module dedup, transitive cross-plugin imports, and real source maps — unconditionally.
- **If no →** keep pure in-thread (the blob path). The source-map win is already shipped (§6); the SW route
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
   `//# sourceURL=km-extension://<blockId>.tsx` (the §6 change shipped in this PR).
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

**Pain points the blob path can't fix on its own:** ~~no source maps~~ (fixed this PR, §6); **no stable module
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
  escapes scope. Two wrinkles, both resolved **in-thread by the producer**, never the SW:
  - *Cache-busting*: the importing module must name the **versioned** URL `${BASE_URL}module/<otherId>?v=<hashB>`
    (the realm module map caches the unversioned URL for the realm lifetime). The producer pins transitive
    specifiers to `?v=<hash>` at compile time — a cheap rewrite that needs only each dep's **approved**
    `sourceHash` (a record lookup, no compile).
  - *Which hash*: it's the dependency's **approved** `sourceHash` (its Gate-2 pin), never `sha256(live content)`.
    An unapproved dep was never produced, so A's import of it **fails closed** — correct #67 behavior. Net:
    cross-block imports resolve only between blocks both *enabled* and *approved* here.
- **Source maps / DevTools** — real, but obtainable on the blob path (shipped, §6). Not a reason to need the SW.
- **Native dedup/identity** — marginal over the existing in-memory `CompileCache`; matters mainly for *shared*
  transitive deps (two plugins importing the same `${BASE_URL}module/<C>?v=…` dedupe natively).
- **Cache reuse** — a non-argument: the producer must run in-thread every boot regardless (decrypt + approval +
  compile), so there's no "serve a module without the producer." Recompute is already avoided by IndexedDB.

**Net:** the only thing stable URLs buy with no in-thread substitute is **transitive plugin→plugin imports**.
Everything else is already handled in-thread.

## 3. The design — SW-required, single-path, on-demand (if adopted)

The cleanest shape is **not** "producer writes a module Cache and the SW serves from it." It's the SW as a
**pure on-demand proxy to the in-thread producer**, which deletes the most machinery.

### 3.1 On-demand SW↔main proxy (no module cache, no GC)

- **SW** `fetch` for `${BASE_URL}module/<id>?v=<hash>`: `event.respondWith()` a promise that `postMessage`s the
  **requesting client** (`event.clientId` → `clients.get(...)`) over a `MessageChannel` — "produce `<id>@<hash>`"
  — and returns the reply bytes as a `new Response(js, {headers:{'content-type':'text/javascript'}})`. Routing by
  `event.clientId` is what makes this multi-tab-correct: each tab is its own client and answers for its own
  imports.
- **Main thread**: a `navigator.serviceWorker` message handler that runs the **existing** producer
  (`loadApprovedExtension`, `compileExtensionModule.ts:382` — approval-gated, content already plaintext, transpile
  only on a cold/compiler-bump miss) and replies over the port with the compiled string.

This **deletes** the whole `km-modules` Cache store, the `PERSISTENT_CACHES` change, the versioned-key writes, and
the GC/prune. The "cache" is just the browser's realm module map (keyed by URL) — exactly the dedup we want. The
in-thread produce-dedup/coalescing cache (`CompileCache.byHash`, an in-flight `Promise<Module>`) stays — the
module map dedupes *imports of a URL*, but only an in-thread guard stops the producer from re-running Babel /
coalesces two concurrent produces of the same hash (the URL doesn't exist yet while producing).

**No deadlock**, despite "main asks main": the page's `import()` is async (a pending promise, not a blocked event
loop) and the SW is a separate thread, so main's message handler is free to answer while its own `import()` is
outstanding.

**Offline-safe**: modules are *only ever* requested by a live page (unlike `<img>` or navigations), so the
producer is always present to answer. A cold offline start works — the IndexedDB approval record is offline, and
`@babel/standalone` is already precached for cold compiles (`public/sw.js` `PRECACHE_LAZY_ASSETS`).

**Plaintext-at-rest is *better* than the cache variant**: the compiled bytes never sit in a Cache — they transit
the message port and live only in the realm module map (memory, gone on reload). (The pre-existing IDB approval
store already holds plaintext `compiled`; nothing new.) See §5.

### 3.2 Why pre-materialization dissolves

With a producer-writes-Cache design, the loader would have to write a dep *before* a parent imports it — and
since the loader walks blocks **sequentially**, instantiating inline (`dynamicExtensions.ts:184-230`), a parent
processed first would import a not-yet-written dep and miss. That forced a topological "materialize-then-import"
phase.

On-demand makes that requirement **vanish**. When A imports `${BASE_URL}module/<B>?v=<hashB>`, the browser
fetches it, the SW asks main, and **main produces B right then** (it has B's approved record). Production is
**demand-driven by the real import graph**, in dependency order automatically — you can't request B's bytes
before the browser asks for them. The only thing compiling A needs of B is B's approved *hash* (to mint the URL),
which is a cheap record lookup, not a compile — so there's no ordering constraint left at all. (Import **cycles**
remain a content-hash fixpoint hazard — disallow them or don't version-pin within a cycle.)

### 3.3 Route + ordering — load-bearing (mirrors media §7.3's "asset route must be FIRST")

A dynamically `import()`ed module has `request.destination === 'script'`, so it is **already caught by
`isCacheableAsset`** (`public/sw.js:212` lists `'script'`) → served from this generation's caches → miss →
network → `Response.error()`. The new `/module/` branch **must be inserted before** `isCacheableAsset`, matched by
`url.pathname.startsWith(MODULE_PREFIX)` where `MODULE_PREFIX = ${base}module/`. Order: (1) navigations → shell;
(1.5) **`/module/` → on-demand proxy**; (2) cacheable assets; (3) vendor; (4) passthrough.

### 3.4 Versioned URLs vs. "reload to apply" — a dial

`?v=<hash>` exists so an edited+re-approved plugin gets a *new* URL → new module (today's blob path gives this via
a fresh blob per changed hash, picked up live by `refreshAppRuntime` without a reload). Keep `?v=` to preserve
that live-refresh behavior. **Or** accept "**reload to apply** a plugin edit" — then drop `?v=` and use bare
`${BASE_URL}module/<id>`, since a reload gives a fresh module map. Given approval is already a deliberate,
infrequent action, "reload to apply" is a defensible simplification; default to keeping `?v=` unless that UX
change is wanted.

## 4. First-load control — page-initiated claim, and dropping the fallback

Plugins load at **startup**, exactly when a freshly-registered SW may not yet control the page. `public/sw.js`
**deliberately omits `clients.claim()`** (`public/sw.js:13`, and the closing note at `:191`) — a fresh install
`skipWaiting()`s (`:160`) to control the *next* load but leaves the current first-visit page uncontrolled for its
lifetime. So a first-visit `import("${BASE_URL}module/<id>")` goes around the SW → 404 → the plugin breaks (a
*feature*, not an image). This is the same hazard the media doc flags.

### 4.1 Page-initiated claim (not activate-time claim)

The naive fix — `clients.claim()` in `activate` — reintroduces version skew, because `activate` runs on **every
deploy** and would grab long-open pages that already loaded the *old* generation, then serve them a *new*-gen lazy
chunk. The right move claims only the pages that **need** it — freshly-navigated uncontrolled ones, which loaded
the **current** generation from the network and are therefore skew-safe:

- SW: `addEventListener('message', e => { if (e.data === 'CLAIM') self.clients.claim() })` — and **no** claim in
  `activate`.
- Bootstrap: if `!navigator.serviceWorker.controller`, `await navigator.serviceWorker.ready`, `postMessage('CLAIM')`,
  await one `controllerchange`, *then* resolve the dynamic-extension subtree.

This threads the needle: a first-visit page asks and is claimed (skew-safe — it loaded the current gen); a
long-open page across a deploy is **already controlled**, so it never enters the ask-path and keeps its generation
until reload (the property the no-`claim()` design protects, preserved); the controller guard at
`registerServiceWorker.ts:52` is unaffected.

### 4.2 Why this can drop the fallback entirely

Gate **only the dynamic (user) extension resolve** on control — not the whole app. This fits the existing
**two-stage cold start**: `AppRuntimeProvider.tsx:114-182` commits the sync `baseRuntime` (kernel + **static**
plugins) immediately and paints, then resolves `dynamicExtensionsExtension` in a later effect and swaps it in. So
user extensions *already* arrive late by design — making them wait for `controllerchange` delays only their
appearance, never app paint. Minimize even that by keeping the SW's `install` `waitUntil` slim so `activate` +
claim fires in tens of ms rather than after a full precache.

The honest residual cost is therefore **first-visit latency**, not dropped functionality — and it's absorbed by
the architecture above. Remaining edges, all acceptable under "require SW for user extensions":

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
- **No plaintext at rest in a Cache.** Under the on-demand variant the compiled bytes never land in a Cache at all
  — they transit the port and live only in the realm module map (memory). Were a producer-writes-Cache variant
  chosen instead, the plaintext compiled JS in that Cache would still be acceptable: the coarse platform "clear
  site data" wipe (`WipeLocalDataDialog`, `docs/lock-and-wipe-coarse-recommendation.md` §0.1) clears the Cache API
  and OPFS atomically, outside the page/SW context — no bespoke Lock-&-Wipe participant. (The IndexedDB approval
  store already holds plaintext `compiled` today; unchanged.)

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

**Keep pure in-thread (blob) — the answer if we will NOT require a SW.** Already shipped: the source-map win.
`defaultTranspileViaBabel` now passes `sourceMaps:'inline'` + `sourceFileName` and appends a stable, **sanitized**
`//# sourceURL=km-extension://<safeId>.tsx` (`compileExtensionModule.ts:161-168`); `blockId` is threaded through
`TranspileImpl` and its three call sites; `COMPILER_VERSION` bumped `1`→`2` (`:15`) so map-less cached output
regenerates. (Security: block ids are caller-suppliable plain text, so the id is restricted to `[A-Za-z0-9._-]`
before it touches emitted JS — a line terminator would otherwise break out of the `//# sourceURL` comment and
inject module-level code, bypassing the #67 gate.) This fixes the sharpest everyday pain with no SW, no cache, no
first-load gap.

### Recommendation

**Decide the hinge first: will we require a controlling service worker for user extensions?**

- **Yes → build the §3/§4 design.** It is a *simplification*, not an addition: single path (no blob), no module
  Cache, no GC, no pre-materialization (§3.2), and it unlocks stable URLs, native dedup, and the one capability
  with no in-thread substitute — **transitive cross-plugin imports**. Net SW surface is a route + a message
  handler + a claim handler; the producer is unchanged.
- **No → stop at the shipped source-map change.** Don't build a SW route that a fallback must shadow.

Given user extensions are non-core and SW-unavailable is already a broken tier (§4.3), requiring a SW for them is
a reasonable line — so I lean **yes**, conditional on the team accepting that scope and on the §4.1 hard-reload
claim behavior verifying out.

### Scope, if adopted (in dependency order)

1. **Producer message handler** (`compileExtensionModule.ts` / a small `extensions/moduleHost.ts`): on
   `{id, hash}` run `loadApprovedExtension` and reply with the compiled string. Reuses the existing producer.
2. **Transitive-import hash pinning** (producer): rewrite a dep ref → `${BASE_URL}module/<dep>?v=<depApprovedHash>`
   from each dep's **approved record** (cheap lookup, no compile); unapproved deps fail closed. The fiddliest
   piece; also defines the authoring specifier for "import another block."
3. **`public/sw.js`**: new `/module/` branch **before** `isCacheableAsset` (§3.3) that proxies to the requesting
   client via `MessageChannel`; add the `CLAIM` message handler (§4.1); remove nothing else.
4. **Bootstrap gate** (`AppRuntimeProvider` / `registerServiceWorker`): page-initiated claim, then gate the
   **dynamic** resolve on `controllerchange` (§4.2); slim the `install` `waitUntil` so claim is fast.
5. **Tests**: route ordering (a `/module/` request isn't swallowed by the asset branch); the SW↔main produce
   round-trip (incl. `event.clientId` routing and a missing-client timeout); page-initiated claim → `controllerchange`
   gating; transitive `?v=` pinning from the approved hash + unapproved-dep fail-closed; cycle handling. No
   module-Cache / Lock-&-Wipe tests (there's no module cache).

**Main risks:** (1) the first-load control handshake — a regression breaks user-extension load, so the
claim→`controllerchange` gate and its timeout must be solid; (2) SW route ordering — a `/module/` request silently
served by the asset branch yields a confusing miss; (3) `clients.claim()` on a **hard reload** — empirically
unverified, the one open question on dropping the fallback; (4) transitive cache-busting / cycles — wrong `?v=`
pinning gives stale plugin code, cycles need an explicit rule. **Not risks:** E2EE key exposure (producer
in-thread, §5), plaintext-at-rest (on-demand keeps none; coarse wipe covers the Cache variant), and
pre-materialization ordering (dissolved, §3.2).
