# Typed domain-event / lifecycle bus — design investigation (2026-06-23)

> **Status:** proposal / investigation — no code written yet.
> **Last verified against code:** 2026-06-23 (master `8a6f22c`) — every
> `file:line` and mechanism claim was checked against the tree by an adversarial
> review pass. Line numbers drift as the tree moves, so trust the named symbol
> over the number.

Companion to `extension-seam-gaps.md` (gap I3 "workspace lifecycle hooks", §6)
and `extensibility-axes.md` (the algebra vocabulary). Grounded in the post-B3
typed-channel discipline (`architecture-audit-2026-06.md` §B3, `AGENTS.md`
"ui event channels").

**Recommendation in one breath.** Build a small **typed, observe-only event bus**
on `repo.events` (a declaration-merged `AppEventRegistry`, `emit`/`on`, a
`useAppEvent` hook) for **broadcast** events — `block:*`, `navigation:completed`,
`sync:status`; **don't** widen the post-commit processor system; **bridge** data
events in from the existing commit choke. But the original motivator, gap I3 ("run
X when a workspace is ready"), turns out to be **effect-shaped, not event-shaped**:
it's already served by a workspace-scoped `AppEffect` (the `EffectReconciler`
restarts effects post-bootstrap, per workspace, on switch), so the thin slice is
*that*, **not** a sticky `workspace:ready` event. **§5 is the load-bearing
conclusion** — a review pass showed the sticky-event framing was the source of
most of this doc's churn; everything between §1 and §5 is supporting evidence.

## The gap, precisely

The only general "react to something that happened" seam a plugin has today is
the **data-layer post-commit processor** (`src/data/api/processor.ts`,
`postCommitProcessorsFacet`). It is excellent at what it does, but as a generic
*application-event* reaction surface it has four hard limits:

1. **Data-only.** It fires off committed `blocks` writes (field-watch) or an
   explicit `tx.afterCommit`. It cannot see navigation, a workspace switch, a
   sync settling, or the app booting — none of those go through `repo.tx`.
2. **Not subscribable by a pure observer.** A processor is a registry entry
   keyed by name, dispatched by the engine. A React component or a long-lived
   service that just wants to *know* "a `todo` was created" has to register a
   whole processor (and a processor cannot drive React reactivity directly —
   it would have to write a row or poke a store).
3. **Cannot be declared as "observe only, filterable."** Field-watch is by
   field name on `blocks`, not by block *type* membership. "Tell me when a
   `todo` is created" means watching `properties` and re-deriving membership
   (`getBlockTypes`) inside `apply` — and a block's `types` is a *list*, so the
   filter is "does the list contain `todo`", not an equality check.
4. **Post-commit, no veto, no pre-event hook.** (Veto already has a home —
   `sameTxProcessor` + `ProcessorRejection` — so this one is by design, but it
   means the processor channel is not the place for "about to navigate" or
   "before workspace switch".)

There is **no typed pub/sub** for the cross-cutting domain events plugins
actually ask for: *block created / updated / deleted* (filterable by type),
*navigated*, *workspace switched / created*, *synced / online / offline*,
*app booted / runtime swapped*.

**Hard constraint (B3).** An untyped `window.CustomEvent` UI bus was
deliberately removed in audit B3. Any new bus MUST be typed — declaration-merged
registry, typed handlers, no stringly event names, no `window.dispatchEvent`
(blocked by `no-restricted-syntax` in non-test `src/`). A handful of genuine
broadcasts were retained (`appRuntimeUpdate`, swipe DOM gestures, agent tokens);
this proposal does not touch them and does not reintroduce their pattern.

---

## 1. Event inventory + existing choke points

The governing rule: **emit from a choke that already exists**, so adding the bus
costs zero new call-site convergence. Every row below names a single point that
already runs for that event.

| Event | Payload (sketch) | Existing choke to emit from | Notes |
|---|---|---|---|
| `block:created` | `{block, types, workspaceId, txId}` | `Repo._runAndDispatch` post-commit, `processorRunner.dispatch` (~`repo.ts:1174`) — the snapshots walk already classifies before/after | `!liveBefore && liveAfter` (insert *or* un-delete). `types` via `getBlockTypes(after)` — a block carries a **`types` list**, not a single type (`properties.ts:119`). |
| `block:updated` | `{id, before, after, changedFields, types, addedTypes, removedTypes, workspaceId, txId}` | same | `liveBefore && liveAfter && content changed`. `changedFields` via `fieldChanged` (`processorRunner.ts`); membership deltas via the `getBlockTypes`-diff helpers (`properties.ts:260+`). |
| `block:deleted` | `{id, before, types, workspaceId, txId}` | same | `liveBefore && !liveAfter`. Covers **soft-delete** (`tx.delete` flips `deleted=true` on the existing row, `txEngine.ts:306` — `before`/`after` both present) *and* hard-delete (`after===null`). `types` via `getBlockTypes(before)`. |
| `block:synced` (down-sync applied) | `{workspaceId, ids}` — **one emit per workspace** present in the window | `startBlocksSyncedObserver` → `applyOutcome` (`syncObserver/observer.ts:167`) — walks materialized snapshots | distinct from local-write `block:*`: these are *remote* rows landing. A drain window is **seq-ordered, not workspace-scoped** (`drainQueueOnce` reads `blocks_synced_changes ORDER BY seq`, `observer.ts:193`), so its `MaterializeOutcome.snapshots` can span workspaces — the bridge must **group by `after/before.workspaceId`** and emit one event per workspace, exactly as the observer already does for cycle scans (`cycleScanCandidatesByWorkspace`, `observer.ts:114`). A single `{ids, workspaceId}` payload would mislabel cross-workspace batches. Pairs with `invalidationRules`. |
| `navigation:completed` | `{result: NavigationResult, input, origin}` | `navigationVerb.after` (`utils/navigation.ts:294`) — **already exists** as a Sum observer slot | bridge, don't re-emit: an internal `after` observer forwards onto the bus. But `after` fires for **every** outcome (`VerbOutcome<NavigationResult \| null>` — success, veto/`null`, throw), so emit `navigation:completed` **only when `outcome.ok && outcome.result !== null`**. A veto/`null`/failure becomes a separate `navigation:cancelled` (or is dropped) — never a `completed` carrying a missing/null result. |
| `navigation:requested` (pre) | `{input}` | `navigationVerb.before` — **already exists** | optional; most demand is for `completed`. Fires *before* resolution for every gesture, so it does **not** imply the navigation will land (it may be vetoed/`null`) — purely an "about to attempt" hook. |
| `workspace:ready` (a.k.a. switched-and-bootstrapped) | `{workspaceId, freshlyCreated}` | **end of `bootstrapWorkspace`** (`workspaceBootstrap.ts`, after the page/ui-state writes, just before `return layoutSessionBlock` — equivalently the `{kind:'ready'}` branch of its caller `resolveInitialLayout`, `App.tsx:126`; `bootstrapWorkspace` itself returns a `Block`, not the layout union) — past the access gate + bootstrap writes | the I3 lifecycle point: workspace is materializable, scoped pages exist. **⚠ See §5 — prefer a workspace-scoped `AppEffect` over this event for I3.** **Not** `setActiveWorkspaceId` — see the caveat below. **No `previousId`:** by this choke `setActiveWorkspaceId(new)` (early, `App.tsx:73`) has already overwritten the pin, so the prior id is gone; it belongs on `workspace:active-changed`, whose choke *is* the setter (both ids in hand). |
| `workspace:active-changed` (low-level pin) | `{previousId, workspaceId}` | `Repo.setActiveWorkspaceId` (`repo.ts:951`) — **fires nothing today** | optional/secondary: reflects the *pin*, fires early (pre-gate, pre-bootstrap). For UI that just tracks "which workspace is selected", not for auto-create handlers. |
| `workspace:created` | `{workspaceId}` | the actual **insert** sites — `ensurePersonalWorkspace`/`ensureLocalPersonalWorkspace` when `inserted` (`resolveWorkspace.ts:98/113`) **and** the dialog create path (`CreateWorkspaceDialog`); dedupe by id | ⚠️ **not** `freshlyCreated` at bootstrap: that flag is only true for the auto-created *personal* workspace. A **dialog-created** workspace is primed locally then navigated to, so `resolveWorkspace` returns it via the existing-local fast path with `freshlyCreated:false` (`resolveWorkspace.ts:40-44`) — gating on `freshlyCreated` would silently miss every user-created workspace. `workspace:ready` fires for *all* opens, so `workspace:created` is only worth it if a distinct "born now" signal matters. |
| `sync:status` (online/offline/synced) | `{connected, hasSynced, uploading, downloading, …}` | PowerSync status listener — already consumed by `system-status` (`SyncIndicatorInput`) | the chip already derives this; the bus would expose the *transitions* to plugins. |
| `app:booted` | `{repo}` — **no `workspaceId`** (session-global; see the emit-choke contract) | a **once-per-Repo/session latch** (or an app-mount/initial-ready point) — **not** the raw end of `bootstrapWorkspace` | one-shot per session. `resolveInitialLayout` re-runs `bootstrapWorkspace` on *every* workspace switch, so emitting from there would fire per-switch; gate behind a session latch on the Repo and leave per-workspace readiness to `workspace:ready`. Carrying a `workspaceId` here would be a scope bug — a late/replayed subscriber would get the *initial* workspace's id. |
| `runtime:swapped` | `{}` | **after** the new runtime is installed — `AppRuntimeProvider` post `repo.setFacetRuntime(next)` (`AppRuntimeProvider.tsx:172`) + `EffectReconciler.reconcile` (`:194`) | **Not** `refreshAppRuntime` (`facets/runtimeEvents.ts`): that fires *refresh-requested* — it bumps the `useOverrides` generation *before* the async `resolveAppRuntime`, and fires even if that resolve fails — so a handler emitting there would still read the **old** facets/effects. Emit only once `next` is live. |

**The three `block:*` events are mutually exclusive** — define `live ≡ present &&
!deleted`, and classify each changed row as exactly one of created
(`!liveBefore && liveAfter`), deleted (`liveBefore && !liveAfter`), or updated
(`liveBefore && liveAfter && content changed`). This is the only way to honor the
"exactly once" contract (§3.5): a soft delete keeps the row present with `deleted`
flipping `false→true`, so a naïve "`before!==null && after!==null` ⇒ updated"
rule would fire **both** `block:updated` and `block:deleted` for one deletion. The
`deleted`-transition rows belong to `block:deleted` only.

**Emit-choke contract (applies to every row).** Naming an existing choke is
necessary but not sufficient — the emit must fire *where the event's promised
semantics actually hold*. Four recurring obligations, each of which bit a row
above:
- **Fire at the point the state is true, not when it's requested.** `workspace:ready`
  emits post-bootstrap (not at the early `setActiveWorkspaceId` pin);
  `runtime:swapped` emits after the new runtime is installed (not at the
  `refreshAppRuntime` request).
- **Filter verb-observer bridges to the intended outcome.** `navigationVerb.before/
  after` fire for vetoes/`null`/throws too, so `navigation:completed` emits only on
  `ok && result !== null`.
- **Gate one-shots per session.** `bootstrapWorkspace` re-runs per workspace switch,
  so `app:booted` needs a once-per-Repo latch; per-switch readiness is
  `workspace:ready`.
- **Scope each *workspace-scoped* payload to one workspace.** A sync drain window
  spans workspaces, so `block:synced` emits once per workspace; the local commit
  choke is already single-workspace (tx workspace pinning). This applies to the
  workspace-scoped events (`block:*`, `workspace:*`) — but **not** to the
  connection-global ones: `sync:status` is a single PowerSync-wide signal (no
  workspace dimension) and `app:booted` is session-global. Those carry no
  `workspaceId` and their sticky entries are global, not workspace-keyed.

Two structural observations from the table:

- **Half the events already have a choke with an observer slot** (navigation
  via `navigationVerb.before/after`, runtime via `refreshAppRuntime`, sync-down
  via `applyOutcome`, data via the post-commit snapshots walk). The bus is
  mostly *plumbing those into one typed stream*, not inventing emit points.
- **The two genuinely seam-less events are the workspace ones** —
  `setActiveWorkspaceId` and workspace create notify nobody. This is exactly
  gap I3's "correctness angle": a plugin that auto-creates blocks needs a
  reliable "active workspace is ready" signal instead of racing the async
  bootstrap.

  **Timing caveat.** Don't emit the lifecycle event from `setActiveWorkspaceId`:
  the switcher (`WorkspaceSwitcher.tsx:57`) and `App.tsx:73` call it *before* the
  §6 access gate and `bootstrapWorkspace`, so emitting there fires into a
  possibly-locked, un-bootstrapped workspace — *recreating* the I3 race. Hence the
  split: `workspace:ready` from the end of `bootstrapWorkspace` (post-gate,
  post-writes); the early setter emits only the low-level
  `workspace:active-changed` pin, which auto-create handlers must not use.

---

## 2. Survey of existing partial mechanisms

The codebase is *not* missing event machinery — it has several typed,
single-purpose streams. The gap is that none of them is a general
**observe-any-domain-event** surface, and three of them are data-only.

### 2a. Post-commit processors (`postCommitProcessorsFacet`)
- **Shape:** keyed Map registry; `{name, watches, apply}`; field-watch or
  explicit (`tx.afterCommit`). Typed payloads via the **declaration-merged
  `PostCommitProcessorRegistry`** — *this is the pattern the new bus copies.*
- **Delivery:** async, fire-and-forget after `repo.tx` resolves; error-isolated
  per processor (`processorRunner.runOne` try/catch); registry snapshotted at
  tx start so a mid-flight `setFacetRuntime` can't change who fires.
- **Covers:** data side-effects, derive-and-cache, conditional writes.
- **Misses:** non-data events; pure-observer/React subscription; type-filtered
  declaration; pre-event.

### 2b. Same-tx processors (`sameTxProcessorsFacet`) — *already a typed in-tx event bus*
- **Shape:** `{name, watches, apply}` where `watches` is field **or
  `{kind:'event', events:[…]}`**. A tx calls **`tx.emitEvent(name, payload)`**;
  payloads are typed via the declaration-merged **`SameTxEventRegistry`**.
- **Delivery:** synchronous inside the user's `writeTransaction`, before commit;
  **can veto** via `ProcessorRejection` (rolls the tx back); single pass,
  registration-ordered.
- **Covers:** correctness-critical atomic reactions; veto; intra-tx domain
  events.
- **Misses:** everything post-commit / cross-cutting / async / observe-only.
  Crucially it is *the existing proof* that a declaration-merged typed event
  registry with an `emit` primitive is the house style — the new bus is its
  post-commit, cross-domain sibling.

### 2c. Invalidation rules (`invalidationRulesFacet`)
- **Shape:** `{id, collectFromSnapshots(snapshots, emit)}` → `emit(channel, key)`
  feeds the handleStore loader so query handles re-resolve. Runs both on local
  commit (`repo.ts:1166`) and on sync-down (`applySyncInvalidation`).
- **Covers:** *reactivity* — making `repo.query.*` handles (and thus React via
  `useHandle`) re-run when relevant rows change.
- **Misses:** it is a cache-invalidation channel, not an observer API. A plugin
  can't "subscribe to block-created"; it can only declare a dependency key its
  *query* re-resolves on. The bus and invalidation rules are complementary: the
  bus is "tell me it happened," invalidation is "re-run my query."

### 2d. Definition-block projectors (`definitionBlockProjectorFacet` + `ProjectorRuntime`)
- **Shape:** watch blocks of a meta-type → mirror into a facet's `'user-data'`
  bucket; one shared lifecycle (pin workspace, subscribe, prime, dispose-clears).
- **Covers:** "data defines contributions" (user schemas/types → facets).
- **Misses:** general; it's a specialized data→facet reflector, not an event
  surface. But its lifecycle (workspace-pinned subscribe + careful
  dispose-on-switch) is the **reference for how a per-workspace subscriber must
  behave across a switch** — the bus's subscribers face the same hazard.

### 2e. Verb facets (`defineVerbFacet`) — *the observer ergonomics already exist*
- **Shape:** `impl`(Replace) + `decorators`(Wrap) + **`before`/`after`(Sum
  observers)** + `run`. Live homes: `navigationVerb`, `navigationIntentVerb`.
- **Covers:** observe/wrap/replace/veto for a *single verb*. `before`/`after`
  are awaited, error-isolated, fire for every outcome.
- **Misses:** it's per-verb, not a broadcast stream. But `navigationVerb.after`
  *is* the navigation-event emit point, and the verb's observer semantics
  (sequential, isolated, every-outcome) are the exact delivery contract the bus
  should adopt.

### 2f. App effects (`appEffectsFacet` + `LiveRuntimeHandle`/`EffectReconciler`)
- **Shape:** `{id, start(ctx) → cleanup}`; long-lived subscriptions tied to the
  extension lifecycle; **survive runtime swaps** via the live handle, restart
  only on `repo`/`workspaceId`/`safeMode` change or contribution-identity change.
- **Covers:** the *subscription lifecycle* a bus consumer needs — start a
  listener, get it torn down when the plugin is toggled off, kept alive across
  unrelated swaps.
- **This is where a plugin's `bus.on(...)` subscription should live.** The
  reconciler already solves "don't strand a subscription across a swap" and
  "tear down when toggled off." The bus does not need to re-solve it.

### 2g. Toggle stores (`createToggleStore`) + handleStore/`useHandle`
- `createToggleStore`: `useSyncExternalStore` module store for open/closed UI
  (the blessed B3 replacement for toggle CustomEvents).
- `useHandle`: the React→data subscription bridge (`useSyncExternalStore` over a
  query handle).
- Both are the **React-subscription idioms** the bus's `useAppEvent` hook should
  mirror so it stays lint-blessed and familiar.

**Summary of coverage:**

| Concern | Covered by | Gap |
|---|---|---|
| Data side-effect, post-commit | post-commit processors | not observe-only / not React |
| Atomic reaction + veto | same-tx processors | in-tx only |
| Query reactivity | invalidation rules | not an event API |
| Per-verb observe/wrap | verb facets | per-verb, not a stream |
| Subscription lifecycle | app effects + live handle | (this is the *host*, not the gap) |
| **Cross-cutting domain-event observe (nav/workspace/sync/app)** | — | **the gap** |

---

## 3. Proposed typed design

### 3.1 Shape: a typed observer bus, registry by declaration merging

Mirror `PostCommitProcessorRegistry` / `SameTxEventRegistry` exactly — an
augmentable interface keyed by event name, mapping to a typed payload:

```ts
// src/events/registry.ts  (new leaf, no app imports — like facet.ts)
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AppEventRegistry { /* augmented per event */ }
//   plugins/owners declare-merge their events:
//   declare module '@/events/registry' {
//     interface AppEventRegistry {
//       'workspace:ready': { workspaceId: string; freshlyCreated: boolean }
//       'block:created': { id: string; types: readonly string[]; workspaceId: string; txId: string }
//     }
//   }

export type AppEventName = keyof AppEventRegistry & string
// Payload is conditional on `N extends string` (NOT constrained to the
// registry keys) — mirroring `SameTxEventPayload`/`ScheduledArgsFor`
// (`P extends keyof … ? …[P] : unknown`) — so a dynamic plugin's unaugmented
// event name still type-checks with an `unknown` payload instead of being a
// compile error. `AppEventName` just enumerates the *known* keys.
export type AppEventPayload<N extends string> =
  N extends keyof AppEventRegistry ? AppEventRegistry[N] : unknown
```

Kernel events (`workspace:*`, `navigation:*`, `sync:*`, `app:*`, `block:*`) are
declared in core; plugins augment for their own (`srs:card-reviewed`, etc.).
Untyped dynamic plugins fall back to `unknown` payload + a runtime guard,
exactly as the two existing registries do.

### 3.2 The bus object + emit

```ts
export interface AppEventBus {
  // `N extends string` (not `AppEventName`) — same as `tx.emitEvent<P extends
  // string>` — so a known name gets its typed payload and a dynamic name still
  // works with `unknown`.
  emit<N extends string>(name: N, payload: AppEventPayload<N>): void
  on<N extends string>(
    name: N,
    handler: (payload: AppEventPayload<N>) => void | Promise<void>,
    options?: { filter?: (p: AppEventPayload<N>) => boolean },
  ): () => void            // returns unsubscribe
}
```

- **Ownership:** the bus is a property of `Repo` (`repo.events`). Rationale:
  the Repo is the per-user singleton that *already* survives both workspace
  switches and `setFacetRuntime` swaps, and three of the emit chokes
  (`setActiveWorkspaceId`, the commit dispatch, the sync observer) are inside
  or owned by the Repo. Navigation/runtime emit through `repo.events` too
  (`navigate` already takes `repo`; the runtime swap path has the repo).
- **Implementation:** `Map<eventName, Set<handler>>` for *registration* (a `Set`
  with idempotent add/remove — `CallbackSet`'s storage half is reusable here).
  But **delivery is NOT `CallbackSet.notify`.** `notify` fans out
  *synchronously*, returns `void`, and wraps each call in a `try/catch` that does
  not `await` — so a `Promise`-returning handler would run un-awaited (handlers
  overlap instead of running sequentially) and a rejected promise would escape
  the `catch` unhandled (`callbackSet.ts:35`). The bus's contract below
  (`void | Promise<void>` handlers, awaited + sequential + isolated) needs a
  dedicated async fan-out loop instead: `for (const h of handlers) { try { await
  h(payload) } catch (e) { log(e) } }` — the same loop `verbFacet` uses for its
  before/after observers (`verbFacet.ts:305`). So: reuse the `Set` for storage,
  write the await-loop for delivery.
- **`emit` is fire-and-forget for the emitter.** It kicks off that async
  delivery loop and returns `void` (the loop's promise is tracked internally, not
  returned to the choke); the choke (navigate, commit, switch) is never blocked
  on a subscriber. (See delivery semantics below.)

### 3.3 Subscribe — two front doors, one core

1. **Imperative (`repo.events.on`)** — the primitive. Used directly inside an
   **AppEffect** so teardown is free:

   ```ts
   const myEffect: AppEffect = {
     id: 'my-plugin/watch-switch',
     start: ({ repo }) => repo.events.on('workspace:ready', async ({ workspaceId }) => {
       // §3.4 handler contract: bail if the active workspace moved. The write
       // below is async, and the sticky gate only covers subscribe-time — not
       // the window between here and the tx commit — so a writing handler must
       // re-check itself.
       if (workspaceId !== repo.activeWorkspaceId) return
       // ensure my plugin's per-workspace block exists, etc. (safe: fired
       // post-bootstrap, so scoped pages exist and the workspace is unlocked)
     }),   // the unsubscribe IS the cleanup
   }
   ```
   The `EffectReconciler` already tears this down on toggle-off and keeps it
   alive across unrelated swaps — no new lifecycle code.

2. **React hook (`useAppEvent`)** — `useSyncExternalStore`-free; a thin
   `useEffect` that subscribes on mount / unsubscribes on unmount, mirroring how
   `useHandle` and toggle stores bridge to React:

   ```ts
   useAppEvent('block:created', useCallback(({ types }) => { … }, []), { filter })
   ```

3. **Optional declarative sugar (`appEventSubscribersFacet`)** — a Sum facet of
   `{ id, events, handler }`, wired up by *one* internal AppEffect that reads the
   facet and registers/unregisters `repo.events.on` per contribution. Defer this
   until there's demand; (1) already covers plugins cleanly and avoids a second
   lifecycle to reason about. If built, it must dedup by `id` and re-subscribe on
   facet change via the live handle, exactly like the projector services.

### 3.4 Scope & lifecycle

- **Workspace scope is in the payload, not the channel.** Every *workspace-scoped*
  event carries `workspaceId` (the session/connection-global ones — `app:booted`,
  `sync:status` — deliberately don't; §1 table); subscribers filter
  (`options.filter` or in-handler). This keeps
  the bus a single flat registry (no per-workspace bus instances to create/tear
  down) and matches how processors/invalidation already pass `workspaceId`
  through. A subscriber that only cares about the active workspace compares
  against `repo.activeWorkspaceId` *at handler time* — and because
  `workspace:ready` is itself an event (fired post-bootstrap), a stateful
  subscriber can track the current workspace precisely instead of racing
  bootstrap (the I3 fix).
- **Runtime-swap teardown.** Subscriptions made through an AppEffect inherit the
  reconciler's guarantees: a toggled-off plugin's `on` is unsubscribed via its
  cleanup; an unchanged plugin keeps its subscription across the swap (the bus
  lives on the stable Repo, so the closure stays valid — unlike a raw
  `FacetRuntime` capture, this needs no live-handle gymnastics). Subscriptions
  made directly (React `useAppEvent`) follow component mount/unmount.
- **The cross-workspace async hazard** that `ProjectorRuntime` documents (a write
  resolving *after* the next workspace started) applies to any handler that
  writes: handlers that auto-create blocks must pin the workspace from the event
  payload and bail if `repo.activeWorkspaceId` moved — the doc should ship this
  as the handler contract, reusing the projector's wording.

### 3.5 Delivery semantics (adopt the verb-observer contract)

- **Async, sequential, isolated.** On `emit`, handlers for that name run in
  registration order; each is `await`ed in turn inside a try/catch that logs and
  swallows — identical to `verbFacet`'s before/after loop and
  `processorRunner.runOne`. One slow/throwing handler can't break the emitter or
  the other handlers.
- **Observe-only — no veto, no result.** Handlers return `void`/`Promise<void>`;
  there is no way to cancel the event or change downstream behavior. Veto stays
  in `sameTxProcessor`; pre-decision interception stays in verb `decorators`.
  This is the single most important boundary: the bus is *notification*, which
  is why it can be fire-and-forget and why it's safe for any plugin to listen.
- **Per-emit ordering only — no cross-event ordering guarantee.** Handlers for a
  single `emit` run in registration/precedence order. But because `emit` returns
  `void` and each call starts its *own* async delivery loop, a slow handler in
  one emit lets a later emit's handlers run (and finish) first — emits can
  interleave/overtake. This is deliberate: serializing all emits through one
  internal promise queue would let a single slow observer head-of-line-block the
  entire stream, including unrelated events. So the bus does **not** promise that
  `block:created` for tx A is fully delivered before `block:created` for tx B; it
  only promises each event's own handlers run in order. If a consumer needs "B
  after A," subscribe B's handler to A (or chain inside the handler) — don't rely
  on emit order. (A future per-event opt-in "serialized" mode could be added if a
  real ordering need appears, but the default stays non-blocking.)
- **Data events are bridged, not double-emitted.** `block:created/updated/deleted`
  are emitted by *one* internal post-commit hook that walks the tx's snapshots
  (the same `SnapshotsMap` the processor runner already has). The payloads are
  singular, so a multi-block tx emits **one event per changed row** (each row
  classified into exactly one of created/updated/deleted — §1) — i.e. exactly
  once per affected block, not once per tx. They inherit the "registry snapshotted
  at tx start" / fire-after-resolve timing.
  Subscribers are pure observers — for *writes* in reaction to data, a real
  processor is still the right tool (atomicity, ordering, the existing veto/
  same-tx options). The bus's data events are for observers that can't or
  shouldn't be processors (UI, analytics, cross-cutting services).
- **"By type" filtering is list-membership.** A block's `types` is a list
  (`properties.ts:119`), so `on('block:created', h, { filter: p =>
  p.types.includes('todo') })` — not a `type === 'todo'` equality. `block:updated`
  additionally carries `addedTypes`/`removedTypes` so a subscriber can react to a
  block *becoming* a `todo` (the membership delta), which an equality check on a
  single field would miss.
- **Sticky ("current-state") events replay the last value on subscribe.**
  (**§5 revises this**: `workspace:ready` should be a workspace-scoped effect, not
  a sticky event — so the sticky machinery below applies to the genuine broadcast
  current-state events, chiefly `sync:status`; it's retained here as the correct
  design *if* a replayable broadcast is genuinely needed.) A small set of events
  describe *current state* rather than a transient occurrence —
  `workspace:ready` (current workspace), `app:booted`, the latest `sync:status`.
  For these the bus retains the last payload and, when a handler subscribes,
  invokes it immediately with that retained value (if any) before any future
  live emit. This is **not** a niceties feature — it's required for correctness
  on the cold-start path: `bootstrapWorkspace` resolves (and would emit
  `workspace:ready`) *before* `AppRuntimeProvider` mounts and registers
  AppEffects (its reconcile runs in a `useEffect`, `AppRuntimeProvider.tsx:184`),
  so an AppEffect subscriber would otherwise **miss** the one-shot emit and the
  thin slice wouldn't actually close I3. Sticky replay closes that gap (and also
  serves plugins that load mid-session). Transient events (`block:*`,
  `navigation:*`, `workspace:active-changed`) are **not** sticky — replaying a
  past block-create to a late subscriber would be wrong.

  **Sticky for a workspace-scoped event should be workspace-gated, not a single
  global slot** — the same hazard `ProjectorRuntime.dispose` guards against. The
  bus lives on the *per-user singleton* `Repo` (reused across switches), so a
  naïve "retain the one last `workspace:ready`" slot can replay **workspace A's**
  payload to a subscriber that comes online while the app is switching to **B**,
  and since §3.4 put the workspace *in the payload*, an auto-create handler keyed
  off `payload.workspaceId` would act on the wrong workspace. The gate: replay the
  retained value only if `payload.workspaceId === repo.activeWorkspaceId`.

  How load-bearing is the gate? It's **defense-in-depth, not a precondition for
  the thin slice.** The Phase-0 I3 consumer is an *AppEffect* (§3.3), and that
  path is safe even ungated: on a switch A→B the effect unmounts and resubscribes
  *after* B's emit, so the retained slot already holds `{B}` at replay. The gate
  matters for the *other* subscribe shapes — a `useAppEvent` consumer mounted
  above the per-workspace Suspense boundary, or a module-singleton consumer —
  which can read the slot mid-transition while it still holds `{A}`. It's cheap
  and correct, so ship it; just don't call it mandatory for the AppEffect slice.
  Note the two impl variants are **not** interchangeable for Phase 0: the
  single-slot "compare at subscribe" gate needs no switch hook and cannot leak,
  whereas "key by workspace + evict on switch" needs an eviction trigger Phase 0
  doesn't wire (`workspace:active-changed` is Phase 1+/optional) — so the
  single-slot gate is the Phase-0 form. `app:booted` (session-global) and
  `sync:status` (connection-global) carry no `workspaceId`, so they don't need
  the gate at all.
- **Replay ordering.** Replay *invokes* the handler synchronously inside `on()`
  (before it returns), so its invocation precedes any later live emit's. But a
  handler may return a promise, so its *completion* isn't synchronous — for a
  high-frequency sticky event (`sync:status`), a live emit right after subscribe
  can complete before a slow replay, delivering stale-after-fresh. `workspace:ready`
  is immune (no concurrent live emit at subscribe), so Phase 0 is fine; but a
  concurrent-emit sticky event needs replay and live emits to share a **per-event
  serialization** (replay enqueued ahead of live emits for that subscriber) —
  folded into the sticky-mechanism open question. Isolation holds regardless: a
  throwing replayed handler is logged, not propagated to `on()` / the AppEffect
  `start`.
- **Idempotency is necessary but NOT sufficient.** Because a sticky handler can
  receive the replayed value *and* a later live emit, sticky-event handlers must
  be **idempotent** (auto-create handlers already are — they check existence
  before writing). But note: on the cold-start / switch path the realistic
  delivery is **replay-only** (the live emit fires before any subscriber exists),
  so the replay path is the primary case to get right, not the double-fire.
  Idempotency does **not** rescue a replayed payload that names the *wrong*
  workspace — that's the job of the workspace gate above (for the non-AppEffect
  subscribe shapes) plus the in-handler bail-if-moved check (§3.4), not of
  idempotency.
- **`workspace:ready` does not imply the workspace's bootstrap `block:*` events
  were delivered.** Those fire from a *different* choke (the post-commit bridge)
  on the unordered stream above, and `bootstrapWorkspace`'s page/tutorial/ui-state
  writes each emit their own `block:created`/`block:updated`. With no cross-event
  ordering, a subscriber can get `workspace:ready` before (or after) those — so a
  lifecycle handler must **read current state** (query the repo), never assume it
  has already observed the bootstrap data events.

### 3.6 How this avoids the B3 untyped-bus relapse

| B3 antipattern | How the bus precludes it |
|---|---|
| Stringly `window` event names | Names are `keyof AppEventRegistry`; a typo is a *type error*. No string flows to `addEventListener`. |
| `window.dispatchEvent(new CustomEvent(...))` | `emit` is a typed method on `repo.events`; no `window` involvement (the ESLint `no-restricted-syntax` guard is untouched and still blocks the old pattern). |
| Cross-plugin coupling over event-name imports (`app-intents` firing quick-find's event) | Plugins emit/subscribe by registry key; no plugin imports another's event-name constant. Same decoupling the B3 resolution achieved with `runActionById`. |
| RPC-over-broadcast (`video-player` `respond()` in detail) | Bus is fire-and-forget observe-only — no return channel, so it *can't* be abused as RPC. Request/response stays the typed handle registry. |
| Lint penalizing `useSyncExternalStore` | `useAppEvent` is the blessed React idiom; the authoring lint (`extensionLint`) should add the bus as the *recommended* target for "react to X" intents, the same way it now points toggles at `runActionById`. |

The bus is *the typed channel B3 asked for* for the one shape B3 didn't have a
home for: "a thing happened, several unrelated plugins want to know."

---

## 4. Recommendation

### 4.1 Generalize the processor system, or a parallel bus? → **Parallel, narrow, bridged.**

Do **not** widen `postCommitProcessorsFacet` into the general bus. Three reasons:

1. **Different contracts.** A processor is a *named, snapshotted, fire-after-tx,
   may-write* unit with a deliberate `db`+`repo` ctx and an error policy tuned to
   write-side-effects. An observer is *anonymous-ish, multi-subscriber,
   cross-domain, observe-only*. Forcing both through one facet would either
   bloat the processor ctx with nav/sync/app concerns or weaken its guarantees.
2. **The processor system can't see non-data events at all** — generalizing it
   would mean inventing a non-tx emit path *inside* a data-layer registry, which
   is a layering inversion (data importing navigation/app concepts).
3. **The house already has the right *patterns* to follow** — the
   declaration-merged registry (from `PostCommitProcessorRegistry` /
   `SameTxEventRegistry`), the verb-observer delivery loop (`verbFacet.ts:305`),
   the AppEffect lifecycle, and `CallbackSet`'s `Set` add/remove for storage. To
   be honest about cost: only the `Set` *storage* is reused — the load-bearing
   parts (the async sequential await-loop, the workspace-gated sticky
   retain+replay, per-event sticky/transient classification, the filter option)
   are **new code**, because §3.2 shows `CallbackSet.notify` itself can't be the
   delivery path (it's sync, swallows in a non-awaiting try/catch). So it's a
   *small, pattern-following* component, not "assembled from existing parts" —
   but materially more than a `Map<name, CallbackSet>`.

So: build a thin **parallel observer bus**, and **bridge data events into it**
from the existing commit choke so a pure observer never has to author a
processor just to watch `block:created`.

### 4.2 Phased plan

**Phase 0 — kernel + thin slice (`workspace:ready`).** Smallest valuable
unit, zero existing seam, real demand (I3):
- `AppEventBus` (`Map<name, Set<handler>>` storage + the async await-loop for
  delivery — §3.2), `repo.events`, typed `AppEventRegistry`.
- One event declared: `workspace:ready`, payload `{workspaceId, freshlyCreated}`.
  One emit line at the **end of `bootstrapWorkspace`** (before `return
  layoutSessionBlock`; the `{kind:'ready'}` shape is its caller
  `resolveInitialLayout`'s return, `App.tsx:126`) — *not* `setActiveWorkspaceId`,
  so handlers run post-gate/post-bootstrap (the timing caveat in §1).
- **`workspace:ready` is sticky** (§3.5): retain-and-replay-on-subscribe,
  **mandatory** here because the cold-start emit precedes AppEffect registration.
  Ship the single-slot workspace gate too (defense-in-depth for non-AppEffect
  shapes — §3.5). So Phase 0 = kernel + async delivery + sticky replay + gate,
  not bare fan-out.
- `useAppEvent` hook. Tests: emit-on-ready (and *not* on a `locked`/`waiting`
  workspace), handler isolation (a throwing handler doesn't break the others or
  the bootstrap), async-sequential delivery (a slow handler doesn't overlap the
  next), **the cold-start replay** (an effect that subscribes *after* the emit
  still receives the retained `workspace:ready`), and **the switch gate** (after
  A→B, a fresh subscriber does *not* get A's stale `workspace:ready`).
- This validates the *entire* shape — registry, emit, async delivery, sticky
  replay, on, hook, lifecycle — against the event that has no other way to be
  observed and that plugins demonstrably need.

**Phase 1 — lifecycle events.** `workspace:created` (from the real insert sites —
`resolveWorkspace` when `inserted` + the `CreateWorkspaceDialog` create path,
dedupe by id; **not** `bootstrapWorkspace`/`freshlyCreated`, which misses
dialog-created workspaces — see §1), `app:booted`, `runtime:swapped` (emitted *after*
`AppRuntimeProvider` installs the new runtime — not the early
`refreshAppRuntime` refresh-requested signal; see the inventory caveat). Turns
the bus into the "lifecycle hook"
surface I3/§6 calls for. Add the declarative `appEventSubscribersFacet` here
only if a plugin wants config-style subscription.

**Phase 2 — navigation + sync.** Bridge `navigation:completed` from
`navigationVerb.after` (an internal `.after` observer that calls `repo.events
.emit`), `sync:status` from the PowerSync status listener, and `block:synced`
(the inventory's down-sync event) from `syncObserver` `applyOutcome`. Pure
bridges over existing observer
slots — no new choke.

**Phase 3 — data events.** `block:created/updated/deleted`, filterable by type,
emitted by one internal post-commit hook reading the snapshots the processor
runner already walks. This is last because it's the highest-volume and the one
with the most overlap with the existing (and still-correct) processor path, so it
benefits from the bus contract being settled first.

### 4.3 Smallest first thin slice

**Phase 0 (§4.2) is the thin slice** — `workspace:ready`, sticky, one emit line,
closes I3, no other observability today. Everything after it is additive.

> **Superseded by §5.** A design review kept surfacing bugs around
> `workspace:ready` being sticky/replayable; §5 traces that to a root cause and
> concludes the I3 slice should be a **workspace-scoped `AppEffect`, not a sticky
> event**. Read §5 before implementing the thin slice.

---

## 5. Root-cause reflection (what the review churn revealed)

A multi-agent + automated review pass produced ~20 findings on this doc. Almost
none challenged the bus *concept*; they clustered into a few classes with three
architectural roots. Naming the roots changes the recommendation — most usefully,
it **removes the thin slice's hardest machinery entirely.**

### 5.1 The dominant class was self-inflicted: `workspace:ready` should not be an event

The majority of findings orbited one decision — making `workspace:ready` a
**sticky, replayable** event: *previousId can't be sourced at the choke;
sticky must be workspace-gated; gate mandatory vs defense-in-depth; cold-start
emit precedes AppEffect registration; replay ordering (sync vs async);
stale-workspace replay; app:booted fires per switch.* Every one is an
impedance-matching artifact of forcing an **effect-shaped need through an
event-shaped hole.**

The need (I3) is "run X once, when a workspace is active **and** ready, and undo
it on switch." That is the definition of a **scoped effect**, and the codebase
already has the machinery:

- `AppRuntimeProvider` — which drives `EffectReconciler.reconcile` — is rendered
  **only** in the `{kind:'ready'}` branch of `resolveInitialLayout`
  (`App.tsx:306`), never for `waiting`/`locked`, and only *after*
  `bootstrapWorkspace` has resolved.
- `EffectReconciler` restarts effects when `workspaceId` changes
  (`liveRuntime.ts` `isColdFor` → `stopAll` → restart), passing the current
  `workspaceId` into `start()`.

So an `AppEffect.start({repo, workspaceId})` **already runs exactly once per
active-and-ready workspace, post-bootstrap, and is torn down on switch.** That
*is* the I3 signal — with no event, no sticky slot, no replay, no
workspace-gate, and no cold-start ordering race, because the effect *lifecycle*
is the subscription and the reconciler (which already keys on `workspaceId`)
owns it. The whole sticky apparatus in §3.5 was reconstructing a signal the
effect system hands over for free.

→ **Revised recommendation.** The thin slice is **not** `workspace:ready`. It is:
confirm/formalize that per-workspace lifecycle work belongs in a workspace-scoped
`AppEffect`, and close any real gap by *tightening the effect contract* — a
documented "runs post-bootstrap, once per ready workspace, torn down on switch"
guarantee, and (optional sugar) a `workspaceEffectsFacet` over `appEffectsFacet`.
This dissolves §3.5's sticky/gate/replay complexity. The **event bus keeps its
value for genuine broadcast** — `block:*`, `navigation:completed`, `sync:status`
— where many/unknown observers want notification and "replay last value" is
either unneeded or (for `sync:status`) a deliberate, isolated choice.

### 5.2 "Emit from any existing choke" is the wrong default — lifecycle has no owner

The timing/scope/missing-path findings (workspace:ready pre-bootstrap;
`runtime:swapped` too early; `workspace:created` misses the dialog path;
`app:booted` per switch) share one cause: **non-data lifecycle has no single
funnel.** Data events are reliable precisely because every mutation passes
through `repo.tx` → one commit-dispatch chokepoint (§2a). Workspace/app lifecycle
is smeared across `App.tsx`, `WorkspaceSwitcher`, `bootstrapWorkspace`,
`resolveWorkspace`, and `CreateWorkspaceDialog` — so any *incidental* choke is
partial (misses a creation path) or mistimed (fires pre-gate / refresh-requested
vs installed). That absence of a lifecycle owner *is* gap I3.

→ **Principle: emit from a canonical per-event chokepoint; where lifecycle has no
owner, the fix is to give it one, not to piggyback an incidental choke** (cf. the
codebase already funnels every content swap through `writePanelContent`). A single
`activateWorkspace` owner that the switcher, URL nav, and create-then-open all
route through is the same refactor that makes both the events *and* the
effect-scoping in §5.1 clean — and it's the concrete form of I3's "workspace
lifecycle hooks."

### 5.3 Prose-over-a-matrix caused the consistency drift

The "un-propagated fix" / "blanket rule contradicts a cell" findings (Phase 1 vs
§1; "every event carries `workspaceId`" vs the global events; `sync:synced` vs
`block:synced`; `type` vs `types`) are mechanical: an 11-event × {payload, choke,
scope, sticky} matrix written as scattered prose can't stay consistent under
edits.

→ **Make the event set one structured source of truth** — a registry where each
event's `{scope: 'workspace' | 'session' | 'connection', sticky, payload}` are
typed fields, so "workspace-scoped ⇒ carries `workspaceId`" is *derived*, not
restated — and **derive payloads from data-model types** (`Pick<BlockData, …>`,
`ReturnType<typeof getBlockTypes>`) so "`types` is a list" is a compile error to
get wrong, not a fact the author must remember. Likewise the async-delivery
contract should be **one shared observer primitive** (verb `before`/`after`, the
processor runner, and this bus each hand-roll the same await-loop today), not
prose repeated three times.

### 5.4 Net

The bus concept survives, **narrowed to broadcast**. The original motivation (I3,
"do X per workspace") is better served by the **existing workspace-scoped effect
lifecycle** — which is why forcing it through a sticky event produced most of the
review's findings. Two supporting refactors (a workspace-lifecycle owner §5.2; a
structured, type-derived registry §5.3) remove the timing and consistency bug
classes at their source rather than patching them per event.

---

## Open questions

- **Bus on `Repo` vs a standalone module singleton.** Proposed: Repo (survives
  swaps, owns 3 of the chokes, gives subscribers `AppEffectContext.repo`); a
  module singleton would decouple it from data-layer tests. Either way the
  singleton's sticky store should be workspace-gated (defense-in-depth, §3.5).
  Decide when Phase 0 lands.
- **Should `block:*` events ever be awaited by the committer?** Proposed no
  (fire-and-forget). If a future use case needs "tx isn't done until observers
  ran," that's a processor, not the bus — keep the line bright.
- **Sticky opt-in mechanism.** Sticky + the workspace gate are *decided* (§3.5);
  what's open is the *mechanism* — a per-event `sticky: true` flag in the
  registry vs. a hardcoded set; whether `sync:status` should be sticky-per-field;
  and whether a concurrent-emit sticky event (`sync:status`) needs per-event
  serialization of replay-vs-live so a slow async replay can't land after a fresh
  emit (§3.5 "Replay ordering" — moot for `workspace:ready`). Settle when Phase 2
  adds `sync:status`.
- **Declarative facet vs AppEffect-only.** Start AppEffect-only; add
  `appEventSubscribersFacet` only on demand (see §3.3).
