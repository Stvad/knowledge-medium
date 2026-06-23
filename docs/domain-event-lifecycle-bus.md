# Typed domain-event / lifecycle bus — design investigation (2026-06-23)

Status: **investigation / proposal**. No code. Companion to
`extension-seam-gaps.md` (gap I3 "workspace lifecycle hooks", §6) and
`extensibility-axes.md` (the algebra vocabulary). Grounded in the post-B3
typed-channel discipline (`architecture-audit-2026-06.md` §B3, `AGENTS.md`
"ui event channels").

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
   field name on `blocks`, not by block *type*. "Tell me when a `todo` is
   created" means watching `properties`/`type` and re-deriving the type inside
   `apply`.
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
| `block:created` | `{block, type, workspaceId, txId}` | `Repo._runAndDispatch` post-commit, line ~1166 (`processorRunner.dispatch`) — the snapshots walk already classifies before/after | `before===null && after!==null`. Type read from `after.properties`/`type`. |
| `block:updated` | `{id, before, after, changedFields, type, workspaceId, txId}` | same | `before!==null && after!==null`. `changedFields` already computable (cf. `fieldChanged` in `processorRunner.ts`). |
| `block:deleted` | `{id, before, type, workspaceId, txId}` | same | soft-delete = `deleted` flips; hard-delete = `after===null`. |
| `block:synced` (down-sync applied) | `{ids, workspaceId}` | `startBlocksSyncedObserver` → `applyOutcome` (`syncObserver/observer.ts:167`) — already walks materialized snapshots | distinct from the local-write `block:*` events: these are *remote* rows landing. Pairs with `invalidationRules`. |
| `navigation:completed` | `{result: NavigationResult, input, origin}` | `navigationVerb.after` (`utils/navigation.ts:289`) — **already exists** as a Sum observer slot | bridge, don't re-emit: an internal `after` observer forwards onto the bus. |
| `navigation:requested` (pre) | `{input}` | `navigationVerb.before` — **already exists** | optional; most demand is for `completed`. |
| `workspace:switched` | `{previousId, workspaceId}` | `Repo.setActiveWorkspaceId` (`repo.ts:943`) — **fires nothing today** | the highest-value missing signal (see I3). One-line emit. |
| `workspace:created` | `{workspaceId, freshlyCreated}` | `bootstrapWorkspace` (`bootstrap/workspaceBootstrap.ts:113`, has `freshlyCreated`) and/or `CreateWorkspaceDialog.onCreated` | `freshlyCreated` is already threaded through bootstrap. |
| `sync:status` (online/offline/synced) | `{connected, hasSynced, uploading, downloading, …}` | PowerSync status listener — already consumed by `system-status` (`SyncIndicatorInput`) | the chip already derives this; the bus would expose the *transitions* to plugins. |
| `app:booted` | `{repo, workspaceId}` | end of `bootstrapWorkspace` / `App.tsx` post-bootstrap | one-shot per session. |
| `runtime:swapped` | `{}` | `EffectReconciler.reconcile` warm path / `refreshAppRuntime` (`facets/runtimeEvents.ts`) | the retained CustomEvent already signals this internally; the bus is the typed plugin-facing view. |

Two structural observations from the table:

- **Half the events already have a choke with an observer slot** (navigation
  via `navigationVerb.before/after`, runtime via `refreshAppRuntime`, sync-down
  via `applyOutcome`, data via the post-commit snapshots walk). The bus is
  mostly *plumbing those into one typed stream*, not inventing emit points.
- **The two genuinely seam-less events are the workspace ones** —
  `setActiveWorkspaceId` and workspace create notify nobody. This is exactly
  gap I3's "correctness angle": a plugin that auto-creates blocks needs a
  reliable "active workspace just changed" signal instead of racing the async
  bootstrap. That makes `workspace:switched` the natural thin slice (§4).

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
  commit (`repo.ts:1158`) and on sync-down (`applySyncInvalidation`).
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
//       'workspace:switched': { previousId: string | null; workspaceId: string }
//       'block:created': { id: string; type: string | undefined; workspaceId: string; txId: string }
//     }
//   }

export type AppEventName = keyof AppEventRegistry & string
export type AppEventPayload<N extends AppEventName> = AppEventRegistry[N]
```

Kernel events (`workspace:*`, `navigation:*`, `sync:*`, `app:*`, `block:*`) are
declared in core; plugins augment for their own (`srs:card-reviewed`, etc.).
Untyped dynamic plugins fall back to `unknown` payload + a runtime guard,
exactly as the two existing registries do.

### 3.2 The bus object + emit

```ts
export interface AppEventBus {
  emit<N extends AppEventName>(name: N, payload: AppEventPayload<N>): void
  on<N extends AppEventName>(
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
- **Implementation:** `Map<eventName, CallbackSet>` — reuse `CallbackSet`
  (already the codebase's isolated-fan-out primitive; `repo.userErrorListeners`
  uses it). No new machinery.
- **`emit` is fire-and-forget for the emitter.** It schedules handler delivery
  and returns `void`; the choke (navigate, commit, switch) is never blocked on a
  subscriber. (See delivery semantics below.)

### 3.3 Subscribe — two front doors, one core

1. **Imperative (`repo.events.on`)** — the primitive. Used directly inside an
   **AppEffect** so teardown is free:

   ```ts
   const myEffect: AppEffect = {
     id: 'my-plugin/watch-switch',
     start: ({ repo }) => repo.events.on('workspace:switched', ({ workspaceId }) => {
       // ensure my plugin's per-workspace block exists, etc.
     }),   // the unsubscribe IS the cleanup
   }
   ```
   The `EffectReconciler` already tears this down on toggle-off and keeps it
   alive across unrelated swaps — no new lifecycle code.

2. **React hook (`useAppEvent`)** — `useSyncExternalStore`-free; a thin
   `useEffect` that subscribes on mount / unsubscribes on unmount, mirroring how
   `useHandle` and toggle stores bridge to React:

   ```ts
   useAppEvent('block:created', useCallback(({ type }) => { … }, []), { filter })
   ```

3. **Optional declarative sugar (`appEventSubscribersFacet`)** — a Sum facet of
   `{ id, events, handler }`, wired up by *one* internal AppEffect that reads the
   facet and registers/unregisters `repo.events.on` per contribution. Defer this
   until there's demand; (1) already covers plugins cleanly and avoids a second
   lifecycle to reason about. If built, it must dedup by `id` and re-subscribe on
   facet change via the live handle, exactly like the projector services.

### 3.4 Scope & lifecycle

- **Workspace scope is in the payload, not the channel.** Every event carries
  `workspaceId`; subscribers filter (`options.filter` or in-handler). This keeps
  the bus a single flat registry (no per-workspace bus instances to create/tear
  down) and matches how processors/invalidation already pass `workspaceId`
  through. A subscriber that only cares about the active workspace compares
  against `repo.activeWorkspaceId` *at handler time* — and because
  `workspace:switched` is itself an event, a stateful subscriber can track the
  current workspace precisely instead of racing bootstrap (the I3 fix).
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
- **Ordering across events is the emit order;** within an event it's
  registration/precedence order. No cross-event ordering guarantees (don't build
  a dependency graph — if you need "B after A," subscribe B to A's effect).
- **Data events are bridged, not double-emitted.** `block:created/updated/deleted`
  are emitted by *one* internal post-commit hook reading the same snapshots the
  processor runner already has, so they fire exactly once per committed tx and
  inherit the "registry snapshotted at tx start" / fire-after-resolve timing.
  Subscribers are pure observers — for *writes* in reaction to data, a real
  processor is still the right tool (atomicity, ordering, the existing veto/
  same-tx options). The bus's data events are for observers that can't or
  shouldn't be processors (UI, analytics, cross-cutting services).

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
3. **The house already has the right primitives to assemble cheaply** — the
   declaration-merged registry (from `PostCommitProcessorRegistry` /
   `SameTxEventRegistry`), `CallbackSet`, the verb-observer delivery contract,
   and the AppEffect lifecycle. The bus is ~a registry + a `Map<name,
   CallbackSet>` + a hook, not a new subsystem.

So: build a thin **parallel observer bus**, and **bridge data events into it**
from the existing commit choke so a pure observer never has to author a
processor just to watch `block:created`.

### 4.2 Phased plan

**Phase 0 — kernel + thin slice (`workspace:switched`).** Smallest valuable
unit, zero existing seam, real demand (I3):
- `AppEventBus` (`Map<name, CallbackSet>`), `repo.events`, typed `AppEventRegistry`.
- One event declared: `workspace:switched`. One emit line in
  `setActiveWorkspaceId` (skip when id unchanged, like the toggle store's `set`).
- `useAppEvent` hook. Tests: emit-on-switch, isolation (throwing handler), and
  the no-op-on-same-id fence.
- This validates the *entire* shape — registry, emit, on, hook, lifecycle —
  against the event that has no other way to be observed and that plugins
  demonstrably need.

**Phase 1 — lifecycle events.** `workspace:created` (from `bootstrapWorkspace`,
reusing `freshlyCreated`), `app:booted`, `runtime:swapped` (forward from the
existing `refreshAppRuntime` signal). Turns the bus into the "lifecycle hook"
surface I3/§6 calls for. Add the declarative `appEventSubscribersFacet` here
only if a plugin wants config-style subscription.

**Phase 2 — navigation + sync.** Bridge `navigation:completed` from
`navigationVerb.after` (an internal `.after` observer that calls `repo.events
.emit`), and `sync:synced`/`sync:status` from the PowerSync status listener +
`syncObserver` `applyOutcome`. Both are pure bridges over existing observer
slots — no new choke.

**Phase 3 — data events.** `block:created/updated/deleted`, filterable by type,
emitted by one internal post-commit hook reading the snapshots the processor
runner already walks. This is last because it's the highest-volume and the one
with the most overlap with the existing (and still-correct) processor path, so it
benefits from the bus contract being settled first.

### 4.3 Smallest first thin slice

**`workspace:switched`, emitted from `Repo.setActiveWorkspaceId`.** It is the
single event with *no* current observability, it is one line at one choke, its
payload is two strings, and it directly closes gap I3's correctness hole
("plugins that auto-create blocks need a reliable active-workspace-changed
signal rather than racing the async bootstrap"). Shipping just this proves the
registry/emit/subscribe/hook/lifecycle end to end with minimal blast radius, and
every later event is additive.

---

## Open questions

- **Bus on `Repo` vs on the runtime.** Proposed: Repo (survives swaps + owns 3
  of the chokes). Alternative: a standalone module singleton like the toggle
  stores. Repo wins because subscriber lifecycle wants `AppEffectContext.repo`
  and because workspace/data/sync emit points already hold the repo — but a
  module singleton would decouple the bus from data-layer tests. Decide when
  Phase 0 lands.
- **Should `block:*` events ever be awaited by the committer?** Proposed no
  (fire-and-forget). If a future use case needs "tx isn't done until observers
  ran," that's a processor, not the bus — keep the line bright.
- **Replay / late-subscribe for one-shot events** (`app:booted` after a plugin
  loads late). Probably expose the last value for a small set of "sticky" events
  (`app:booted`, current `sync:status`, current workspace) rather than a general
  replay buffer. Revisit in Phase 1.
- **Declarative facet vs AppEffect-only.** Start AppEffect-only; add
  `appEventSubscribersFacet` only on demand, and if added, dedup-by-id +
  live-handle re-subscribe like the projector services.
