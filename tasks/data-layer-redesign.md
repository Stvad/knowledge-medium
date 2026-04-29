# Task: Data layer redesign — handles + tx + facet-contributed mutators/queries

Owner role: architect (this doc) → implementer subagents (per phase)
Type: architectural rewrite (multi-phase, behavior-preserving overall)
Estimated scope: large. Touches `src/data/**`, `src/hooks/block.ts`, `src/extensions/{facet,core}.ts`, every shortcut handler, every component that reads block data. ~50+ files, but most edits are mechanical once the new primitives land.

> **Recommended ordering vs. other specs:**
> - `tasks/property-access-refactor.md` — likely **subsumed by Phase 3** of this spec. If property-access-refactor lands first, Phase 3 inherits its `getPropertyValue`/`setPropertyValue` shape and replaces the property-record split with descriptor-based schemas.
> - `tasks/actionManager-refactor.md` — orthogonal; can land in either order.
> - `tasks/plugins-architecture.md` — must land **before** Phase 4 of this spec. Phase 4 adds plugin-contributed data-layer facets, which expects plugins to already be folder-organized.
> - `tasks/architectural-observations.md` items #2 (sync/async), #3 (schema vs value), #6 (Repo singleton), #7 (changeScope typing), #9 (`any` casts) are subsumed by this spec.

---

## 1. Background

The current data-access layer accreted from an Automerge-era design and has not been re-shaped since the move to PowerSync + SQLite. It mixes paradigms in ways that make every new feature awkward and every refactor risky.

### 1.1 Diagnosis

| # | Issue | Where |
|---|---|---|
| **D1** | Sync/async split | `Block.data()` (async) vs. `Block.dataSync()` (sync, throws); `setProperty` non-async but fires async ref-parsing |
| **D2** | Callback-mutation API | `block.change(d => d.content = 'x')` — Automerge legacy. Closures-over-doc get passed around. |
| **D3** | Out-of-band side effects | `parseAndUpdateReferences` is fire-and-forget *outside* the active tx → escapes undo grouping, can race |
| **D4** | No real DB transaction | `applySnapshots` enqueues writes individually; `BlockStorage.writeLock` is per-statement. Crash mid-multiblock op = partial state. |
| **D5** | Manual undo grouping | Multi-block ops only batch when callers remember to wrap in `_transaction`. Most don't. Each `setProperty` becomes its own undo entry. |
| **D6** | N+1 tree walks | `parents()`, `isDescendantOf()`, `getRootBlock()`, `visitBlocks()` chase IDs in JS even though the subtree CTE works. |
| **D7** | Schema/value conflation | `BlockProperty` is both descriptor and stored value; every write spreads schema metadata into storage; reads need `as T` casts. |
| **D8** | Hardcoded queries | `findBacklinks`, `findBlocksByType`, etc. are static methods on `Repo`. Plugins have no way to register their own queries. |
| **D9** | Hardcoded post-commit work | Reference parsing is inlined into `change()`. No way for plugins to react to specific mutations. |

### 1.2 Constraint that reshapes the design

The codebase has chosen a **kernel + facet** architecture (see `src/extensions/facet.ts`, `tasks/decorator-facet-design.md`, `tasks/plugins-architecture.md`). Every UI-side feature contributes via a facet; the data layer is the only major subsystem that doesn't follow this pattern. **The redesign aligns the data layer with the facet kernel** — mutators, queries, property schemas, and post-commit processors all become facet contributions.

### 1.3 Constraint: dynamic plugin loading

Plugins are loaded both at compile time (static imports under `src/plugins/`) and at runtime (renderer/extension blocks compiled via Babel, see `src/extensions/dynamicRenderers.ts`). The data-layer API has to:

- Be fully typed for static plugins (module augmentation for `repo.mutate.X` / `repo.query.X`).
- Accept dynamic plugins that aren't in the TypeScript module graph (string-keyed access, runtime schema validation).
- Expose the **same facet contribution shape** for both — only the typing channel differs.

---

## 2. Goals

1. **Single read primitive: `Handle<T>`.** Every read returns a handle with `peek` / `load` / `subscribe`. One React hook, `useHandle(handle)`, adapts any handle to a component.
2. **Single write primitive: `repo.tx`.** All mutations go through transactional sessions. One DB tx, one undo entry, one event-log entry, atomic cache update — all per `repo.tx` call.
3. **Mutators are named, typed, and contributed via facet.** Anonymous callback mutations (`block.change(d => …)`) are removed. `repo.mutate.indent({ id })` is the public surface; it's typed via module augmentation for static plugins, runtime-validated for dynamic ones.
4. **Queries are facet contributions.** `findBacklinks` etc. become contributions to `queriesFacet`, alongside plugin queries. `repo.query.<name>` returns a `Handle`.
5. **Property schemas are facet contributions** (descriptor only; values stored separately). Plugins register their own.
6. **Post-commit work is facet-contributed.** Reference parsing, search indexing, anything else cross-cutting becomes a `postCommitProcessorsFacet` contribution.
7. **Tree walks push to SQL.** Recursive CTEs replace JS-side parent-chain and subtree iteration.
8. **`Block` becomes a sync view.** Loading is an explicit boundary (Suspense in React; `await repo.load(…)` in imperative code). Post-load access is sync everywhere.
9. **`block_events` becomes a named-event log.** Each tx commit appends `{txId, mutatorName, args, userId, timestamp}`. Undo, cross-tab sync, audit log, devtools, plugin observers all read the same log.

### 2.1 Non-goals

- Replacing PowerSync. PowerSync stays as the storage + sync layer.
- Switching to event sourcing (events as truth, rows as projection). Rows stay authoritative; events are the audit/change log.
- Differential dataflow / IVM for query invalidation. Re-run + structural diff is enough at our query depth.
- CRDT primitives beyond what PowerSync gives. Block ordering uses a fractional-index column; everything else is row-LWW.
- A new SQLite schema. Existing `blocks` table stays; `block_events` schema gains a few columns.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ React UI                                                    │
│   useHandle(handle)                                         │
│   <Suspense> boundary catches first-load                    │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│ Repo (singleton-or-context, but with new shape)             │
│   repo.block(id) / repo.subtree(id) / repo.query.X(args)   ┐│
│     → Handle<T> {peek, load, subscribe}                    ││
│   repo.tx(fn, opts) → Promise<void>                         │
│   repo.mutate.X(args) → Promise<void>  // sugar over tx     │
│   repo.run(name, args) → Promise<unknown>  // dynamic       │
└──────┬──────────────────┬───────────────────────────────────┘
       │                  │
       ▼                  ▼
┌──────────────┐  ┌────────────────────────────────────────┐
│ HandleStore  │  │ FacetRuntime                           │
│  identity-   │  │  mutatorsFacet                         │
│  stable      │  │  queriesFacet                          │
│  per (key)   │  │  propertySchemasFacet                  │
│  GC by ref   │  │  postCommitProcessorsFacet             │
│  count       │  └─────────────────┬──────────────────────┘
└──────┬───────┘                    │
       │                            │
       ▼                            ▼
┌─────────────────────────────────────────────────────────────┐
│ TxEngine                                                    │
│   open writeLock → BEGIN                                    │
│   run mutator(s) on staged Tx (read-your-own-writes)        │
│   write rows + append to block_events → COMMIT              │
│   hydrate cache, diff handles, fire subscribers             │
│   schedule post-commit processors                           │
│   record undo entry                                         │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ PowerSync SQLite (unchanged schema, recursive CTEs added)   │
└─────────────────────────────────────────────────────────────┘
```

The two new top-level abstractions are `Handle` (reads) and `Tx` (writes). Everything else either feeds into them (facets) or is the existing storage layer (PowerSync) untouched.

---

## 4. Core types

These go in a new `src/data/api/` module, exported as the public data-layer surface. The detailed implementations live in private modules (`src/data/internals/`) — plugins and call sites import from `@/data/api` only.

### 4.1 `Handle<T>`

```ts
export interface Handle<T> {
  /** Stable key — two handles with the same key are === to each other. */
  readonly key: string

  /** Sync read. Returns undefined if not yet loaded. Never throws. */
  peek(): T | undefined

  /** Ensure loaded; resolve when value is available. Idempotent + deduped. */
  load(): Promise<T>

  /** Reactive subscription. Listener fires on structural change only. */
  subscribe(listener: (value: T) => void): Unsubscribe

  /**
   * For React/Suspense paths: returns T or throws a Promise if not loaded
   * (which Suspense will catch). Used internally by useHandle.
   */
  read(): T
}
```

Identity rule: `repo.block(id) === repo.block(id)` for the same id. Same for `repo.subtree(rootId)`, `repo.query.X(sameArgs)`, etc. Implementation: `HandleStore` keys handles by `(name, JSON.stringify(args))`, returns existing handle if present, GCs after `gcTime` of zero subscribers + zero in-flight loads.

### 4.2 `Block` (sync view)

```ts
export interface Block {
  readonly id: string
  readonly repo: Repo

  /** Sync; throws "BlockNotLoaded" if not in cache. */
  readonly data: BlockData

  /** Soft access; returns undefined if not loaded. */
  peek(): BlockData | undefined

  /** Ensure loaded; same as repo.load(id). */
  load(): Promise<BlockData>

  /** Sync property access via descriptor. Returns descriptor's defaultValue if absent. */
  get<T>(schema: PropertySchema<T>): T
  /** Sync property access; returns undefined if absent (no default substitution). */
  peekProperty<T>(schema: PropertySchema<T>): T | undefined

  /** Sync sibling/parent access — relies on cached parent/children. */
  readonly parent: Block | null
  readonly children: Block[]

  /** Subscribe to this block's data changes. */
  subscribe(listener: (data: BlockData) => void): Unsubscribe
}
```

`Block` is a thin facade over the cached `BlockData`. It carries no `currentUser`, no `undoRedoManager`, no methods that mutate. Mutation goes through `repo.tx` / `repo.mutate.X`. The user/undo concerns flow through `Tx`.

`block.parent` / `block.children` access cached siblings synchronously. If the parent or any child isn't cached, the getter throws "BlockNotLoaded(parentId)" — forcing the caller to load ancestors/descendants explicitly. (`repo.load(id, { ancestors: true })` and `{ descendants: depth }` exist for this.)

### 4.3 `Tx` (transactional session)

```ts
export interface Tx {
  /** Read with read-your-own-writes: sees writes staged earlier in this tx. */
  get(id: string): BlockData
  peek(id: string): BlockData | undefined

  /** Low-level primitives — used inside mutator implementations. */
  create(data: NewBlockData): string                        // returns new id
  update(id: string, patch: Partial<BlockData>): void
  delete(id: string): void                                  // soft delete

  /** Run another mutator inside this tx. Reads see prior staged writes. */
  run<Args>(mutator: Mutator<Args>, args: Args): void

  /** Within-tx queries — limited; full Handle queries are out-of-tx. */
  childrenOf(parentId: string): BlockData[]
  parentOf(childId: string): BlockData | null

  /** Tx metadata (set by repo.tx options or inferred). */
  readonly meta: { description?: string; scope: ChangeScope; user: User }
}
```

A `Tx` is **stateful within its callback**: writes accumulate in a staged buffer, reads check staged writes first, then the cache. If the callback throws, nothing is persisted — no DB write, no cache update, no event-log row, no undo entry. If it succeeds, all writes commit atomically.

**`tx.run` is how mutators compose.** A `move` mutator can call `tx.run(indentMutator, { id })` and have its writes seen by subsequent reads.

### 4.4 `Mutator<Args, Result = void>`

```ts
export interface Mutator<Args = unknown, Result = void> {
  readonly name: string                              // 'indent', 'tasks:setDueDate'
  readonly argsSchema: Schema<Args>                  // Effect Schema or zod
  readonly resultSchema?: Schema<Result>
  readonly apply: (tx: Tx, args: Args) => Result | Promise<Result>
  /** Human-readable description for undo UI / audit log. */
  readonly describe?: (args: Args) => string
}
```

Mutators are **pure-ish functions** in the sense that they take `(tx, args)` and stage writes. They can read via `tx.get`, run other mutators via `tx.run`, but cannot perform IO outside the tx. Side effects (search index update, references) are post-commit processors, not part of the mutator.

### 4.5 `Query<Args, Result>`

```ts
export interface Query<Args, Result> {
  readonly name: string
  readonly argsSchema: Schema<Args>
  readonly resultSchema: Schema<Result>
  readonly resolve: (args: Args, ctx: QueryCtx) => Promise<Result>
  /** Reactivity: when does this query need to re-run? */
  readonly invalidatedBy: QueryInvalidation
}

type QueryInvalidation =
  | { kind: 'tables'; tables: string[] }                    // any change to these tables
  | { kind: 'mutators'; names: string[] }                   // these mutator commits
  | { kind: 'rows'; predicate: (event: BlockEvent) => boolean }

interface QueryCtx {
  db: PowerSyncDatabase                                     // raw SQL escape hatch
  repo: Repo                                                // for handle composition
  hydrateBlocks(rows: BlockRow[]): BlockData[]
}
```

Built-in queries (`subtree`, `ancestors`, `backlinks`, `searchByContent`, `byType`) are kernel contributions to `queriesFacet`. Plugins add theirs the same way.

### 4.6 `PropertySchema<T>`

```ts
export interface PropertySchema<T> {
  readonly name: string                                     // 'is-collapsed', 'tasks:due-date'
  readonly type: Schema<T>                                  // for runtime validation + coercion
  readonly defaultValue: T
  readonly changeScope: ChangeScope
  readonly category?: string                                // for property-editor grouping
}
```

Replaces today's `BlockProperty` union. Storage shape becomes `properties: Record<name, T>` (just the value, no descriptor metadata). The descriptor lives in code (kernel exports + plugin exports).

Migration: existing data has `properties[name] = {name, type, value, changeScope}`. Read-path accepts both shapes; write-path emits new shape; one-shot migration rewrites stored rows.

### 4.7 `PostCommitProcessor`

```ts
export interface PostCommitProcessor {
  readonly name: string
  /** Mutator names whose commits this processor reacts to. */
  readonly watches: string[]
  /** Optional: 'same-tx' to run inside the original tx (atomic), 'follow-up' default. */
  readonly mode?: 'same-tx' | 'follow-up'
  readonly apply: (event: CommittedEvent, tx: Tx) => void | Promise<void>
}
```

Reference parsing becomes:

```ts
postCommitProcessorsFacet.of({
  name: 'core.parseReferences',
  watches: ['setContent', 'create'],
  mode: 'same-tx',                                          // refs must be consistent with content
  apply: (event, tx) => {
    const block = tx.get(event.args.id)
    const refs = parseRefs(block.content)
    if (!sameRefs(block.references, refs)) {
      tx.update(event.args.id, { references: refs })
    }
  }
})
```

Search indexing, backlinks computation, plugin-defined post-processing all use the same shape.

### 4.8 `ChangeScope` (typed)

```ts
export const ChangeScope = {
  BlockDefault: 'block-default',
  UiState: 'local-ui',
  References: 'block-default:references',
} as const
export type ChangeScope = (typeof ChangeScope)[keyof typeof ChangeScope]
```

Plugins extend via module augmentation:

```ts
declare module '@/data/api' {
  interface ChangeScopeRegistry {
    'tasks:agenda': true
  }
}
```

The string-typed version stays valid for dynamic-plugin scopes (which can't augment at compile time). Misspellings of static scopes become a compile error; dynamic ones are validated at registration time.

---

## 5. Facets

Four new kernel facets contribute to the data layer. They live in `src/data/api/facets.ts` and are read by the `Repo` at construction time (and on `FacetRuntime` change).

```ts
export const mutatorsFacet            = defineFacet<Mutator,            MutatorRegistry>({...})
export const queriesFacet             = defineFacet<Query,              QueryRegistry>({...})
export const propertySchemasFacet     = defineFacet<PropertySchema,     PropertySchemaRegistry>({...})
export const postCommitProcessorsFacet = defineFacet<PostCommitProcessor, PostCommitDispatcher>({...})
```

Each facet's `combine` builds a registry keyed by `name`; duplicate names log a warning and last-wins (matching `blockRenderersFacet`'s existing semantics — see `tasks/plugins-architecture.md` §5 item 9).

The kernel registers built-ins as plain contributions to these facets. There is **no two-tier system** — `core.indent` and `tasks:setDueDate` are both contributions, distinguishable only by their `name` prefix convention.

### 5.1 Naming convention

- Kernel mutators/queries: bare names — `indent`, `outdent`, `setProperty`, `subtree`, `backlinks`.
- Plugin mutators/queries: `<plugin-id>:<name>` — `tasks:setDueDate`, `calendar:eventsInRange`.
- Property schemas same: `is-collapsed` (kernel), `tasks:due-date` (plugin).

The colon-prefix rule isn't enforced in code (plugin authors could ship a bare-named contribution). It's a convention in `src/plugins/README.md`. Lint rule for the static-imports case is a follow-up.

---

## 6. Plugin extension model

### 6.1 Static plugins (compile-time)

```ts
// src/plugins/tasks/schema.ts
import { defineProperty } from '@/data/api'
import * as t from 'effect/Schema'                       // (or zod, TBD §13.2)

export const dueDateProp = defineProperty('tasks:due-date', t.Date, {
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

// src/plugins/tasks/mutators.ts
import { defineMutator } from '@/data/api'
import { dueDateProp } from './schema'

export const setDueDate = defineMutator({
  name: 'tasks:setDueDate',
  argsSchema: t.Struct({ id: t.String, date: t.Date }),
  apply: (tx, { id, date }) => {
    const block = tx.get(id)
    tx.update(id, {
      properties: { ...block.properties, [dueDateProp.name]: date }
    })
  }
})

// src/plugins/tasks/index.ts
import { mutatorsFacet, propertySchemasFacet } from '@/data/api'
import { setDueDate } from './mutators'
import { dueDateProp } from './schema'

// Module augmentation: types flow into repo.mutate
declare module '@/data/api' {
  interface MutatorRegistry {
    'tasks:setDueDate': typeof setDueDate
  }
  interface PropertySchemaRegistry {
    'tasks:due-date': typeof dueDateProp
  }
}

export const tasksPlugin: AppExtension = [
  mutatorsFacet.of(setDueDate, { source: 'tasks' }),
  propertySchemasFacet.of(dueDateProp, { source: 'tasks' }),
]
```

Calling site (typed):

```ts
await repo.mutate['tasks:setDueDate']({ id, date })
// ^ argument types come from MutatorRegistry via module augmentation
```

### 6.2 Dynamic plugins (runtime-loaded)

Renderer/extension blocks compiled via Babel. They have access to the same `defineMutator` / `mutatorsFacet.of` API:

```js
// Inside a renderer block, compiled at runtime:
const setBookmark = defineMutator({
  name: 'bookmarks:set',
  argsSchema: t.Struct({ id: t.String, url: t.String }),
  apply: (tx, { id, url }) => { /* ... */ }
})

contribute(mutatorsFacet, setBookmark)
```

The `contribute` helper is exposed on the dynamic-plugin runtime (analogous to `useFacets` for renderers today). Dynamic plugins can't use `declare module`, so call sites have two options:

```ts
// Option A: untyped string-keyed access, runtime-validated:
await repo.run('bookmarks:set', { id, url: 'https://...' })
// returns Promise<unknown>; the result is validated against resultSchema if present

// Option B: dynamic plugin ships a .d.ts that augments MutatorRegistry.
// The kernel exposes a "type sidecar" registration mechanism that loads
// .d.ts companions for known dynamic plugins.
```

Option A is the always-available fallback. Option B is a follow-up — useful when a dynamic plugin is stable enough to ship typed bindings, but optional.

### 6.3 What plugins can contribute

| Facet | Plugin contribution shape |
|---|---|
| `mutatorsFacet` | named typed write operations |
| `queriesFacet` | named read operations returning Handles |
| `propertySchemasFacet` | named typed property descriptors |
| `postCommitProcessorsFacet` | named side-effects watching specific mutators |

What plugins **cannot** contribute (out of scope this round):
- New top-level fields on `BlockData` (use properties).
- New entity tables alongside `blocks` (would require sync-config changes; see §13.3).
- Schema migrations of stored data (kernel concern).

### 6.4 Trust model

Static plugins are trusted (in the TS module graph, code-reviewed). Dynamic plugins are author-trusted — they run with the same authority as the kernel. **Mutator args are validated at the boundary** for both, so even a buggy plugin can't corrupt the schema; it can only do unwanted-but-well-typed things.

If sandboxing dynamic plugins becomes a goal, the entry point for restriction is the `Tx` interface (limit which mutators can be `tx.run`-ed, limit which property names can be written). Out of scope for this spec.

---

## 7. Reactivity & invalidation

### 7.1 Per-handle subscription

Every `Handle<T>` maintains:
- `value: T | undefined`  — last computed result
- `listeners: Set<Listener>` — current subscribers
- `dependencies: Dependencies` — what would invalidate this handle's value

Handle implementations register with the `HandleStore`'s invalidation index when first loaded. On a tx commit, the `TxEngine` walks affected handles and re-runs them.

### 7.2 What "affected" means

Three sources of invalidation:

1. **Row-level**: a row in `blocks` changed. Handles whose dependencies include that row id re-run. (`repo.block(id)` is the obvious case; `repo.subtree(rootId)` is invalidated if any descendant row id changed.)
2. **Mutator-level**: a query declares `invalidatedBy: { kind: 'mutators', names: ['indent', 'outdent'] }` — re-runs only when those commit.
3. **Table-level**: catch-all for queries that don't track row dependencies. Coarsest; over-invalidates.

Handles built by the kernel (`block`, `subtree`, `ancestors`, `backlinks`) declare row-level dependencies during their `resolve` (the resolver knows which row ids it touched). Plugin queries can declare mutator-level or table-level dependencies; row-level is opt-in (plugin author has to track it explicitly inside `resolve`).

### 7.3 Structural diffing

After re-running, the new value is compared to the cached one. Default comparator: `lodash.isEqual` (already a dep). Listeners only fire if the result actually changed. This is the "no spurious re-renders even when the underlying row was re-written with the same content" win.

For specific result shapes a faster comparator can be supplied (handle factories take an optional `eq` option). Default is fine for the common cases.

### 7.4 Cross-tab invalidation

PowerSync writes are visible to other tabs (shared-worker SQLite). On a write from tab A, tab B's `block_events` table gains a row. Tab B's `Repo` already subscribes to `block_events` via `db.onChange`; on event arrival, it:
1. Reads the new event(s) since last seen.
2. For each event, walks affected handles (same logic as local commits).
3. Re-runs and diffs.

Cross-tab undo: out of scope. Each tab has its own undo stack. (See §13.6 — events-derived undo would change this.)

### 7.5 React integration

`useHandle(handle)` is the only React adaptor:

```ts
export function useHandle<T>(
  handle: Handle<T>,
  options?: { selector?: (v: T) => unknown; eq?: EqualityFn }
): T

// Suspense path: throws a Promise if not loaded.
// Subscription path: useSyncExternalStore(handle.subscribe, handle.peek, handle.peek).
```

Bespoke hooks (`useBlockData`, `useSubtree`, etc.) are 1-line sugar that the kernel ships for ergonomics, but the primitive is `useHandle`.

---

## 8. Transaction commit pipeline

A `repo.tx(fn, opts)` call goes through this pipeline:

```
┌──────────────────────────────────────────────────────────────┐
│ 1. db.writeLock open (PowerSync) — serialize writes          │
│ 2. BEGIN                                                     │
│ 3. construct staged Tx (write-set = {})                      │
│ 4. user fn runs:                                             │
│      tx.update / tx.create / tx.delete / tx.run              │
│      stages writes; reads check staged then cache            │
│ 5. run same-tx post-commit processors against staged events  │
│      (refs parsing happens here)                             │
│ 6. write all rows to blocks (one INSERT…ON CONFLICT each)    │
│ 7. append rows to block_events (mutator-name + args)         │
│ 8. COMMIT                                                    │
│ 9. hydrate cache from staged writes                          │
│ 10. walk affected handles, re-run, structural-diff, notify   │
│ 11. record undo entry (mutator name, before-snapshots, scope) │
│ 12. schedule follow-up post-commit processors (own txs)      │
└──────────────────────────────────────────────────────────────┘
```

Steps 1–8 are atomic at the SQLite level. Step 9 happens after COMMIT but synchronously — the cache and event log can never disagree. Step 10 fires synchronously after the cache is updated. Steps 11 and 12 are after the user awaits.

If step 4 throws: rollback, no state change anywhere. If steps 6–8 fail (DB error): rollback, no cache update, no event row, error propagates to caller.

### 8.1 `repo.mutate.X` is sugar for a 1-mutator tx

```ts
await repo.mutate.indent({ id })
// ≡
await repo.tx(tx => { tx.run(indentMutator, { id }) }, {
  description: indentMutator.describe?.({ id }),
  scope: ChangeScope.BlockDefault,
})
```

### 8.2 Read-your-own-writes

`tx.get(id)` checks the staged write-set first, then the cache. A mutator that does:

```ts
apply: (tx, { id }) => {
  tx.update(id, { content: 'new' })
  const block = tx.get(id)
  console.log(block.content) // 'new'
}
```

…sees its own write. Composability: a higher-level mutator running another mutator via `tx.run` sees the staged effects.

### 8.3 Same-tx post-commit processors

For processors with `mode: 'same-tx'` (reference parsing being the canonical example), they run **after** the user fn but **before** the DB write. They get the same staged Tx. Their writes also go into the same atomic commit.

For `mode: 'follow-up'` (default), a separate small tx is opened after commit. Each processor gets its own tx, with the committed event as input. If the processor throws, it's logged but doesn't undo the original commit.

---

## 9. Tree operations — push to SQL

Replace JS-side recursion with recursive CTEs. Three new kernel queries:

```ts
// src/data/internals/queries/tree.ts
export const subtreeQuery = defineQuery({
  name: 'subtree',
  argsSchema: t.Struct({ rootId: t.String, includeRoot: t.optional(t.Boolean) }),
  resultSchema: t.Array(blockDataSchema),
  invalidatedBy: { kind: 'rows', predicate: e => /* descendants of rootId */ },
  resolve: async ({ rootId, includeRoot }, { db, hydrateBlocks }) => {
    const rows = await db.getAll(SUBTREE_SQL, [rootId])
    return hydrateBlocks(rows)
  }
})

export const ancestorsQuery = defineQuery({
  name: 'ancestors',
  argsSchema: t.Struct({ id: t.String }),
  resultSchema: t.Array(blockDataSchema),
  invalidatedBy: { kind: 'rows', predicate: e => /* row is in chain */ },
  resolve: async ({ id }, { db, hydrateBlocks }) => {
    const rows = await db.getAll(ANCESTORS_SQL, [id])
    return hydrateBlocks(rows)
  }
})

export const isDescendantOfQuery = defineQuery({...})
```

The existing `SUBTREE_SQL` (in `blockQueries.ts`) is reused. `ANCESTORS_SQL` is new — a recursive CTE walking `parent_id` upward.

Block helpers that previously walked in JS (`block.parents()`, `block.isDescendantOf()`, `getRootBlock`) are removed in favor of `useHandle(repo.query.ancestors({ id }))` (React) or `await repo.query.ancestors({ id }).load()` (imperative). `visitBlocks` is reimplemented as a synchronous walk over a pre-loaded subtree (one CTE call, then in-memory traversal).

The `block.parent` / `block.children` getters on `Block` (§4.2) only chase one level — they require the immediate parent/children to be cached but don't walk further. Multi-level walks always go through queries.

---

## 10. The `block_events` upgrade

Current schema (inferred from `blockStorage.ts:233-250`): a row per event with `block_event_context` metadata.

New schema:

```sql
ALTER TABLE block_events ADD COLUMN tx_id        TEXT NOT NULL DEFAULT '';
ALTER TABLE block_events ADD COLUMN mutator_name TEXT NOT NULL DEFAULT '';
ALTER TABLE block_events ADD COLUMN args_json    TEXT NOT NULL DEFAULT '{}';
ALTER TABLE block_events ADD COLUMN user_id      TEXT NOT NULL DEFAULT '';
ALTER TABLE block_events ADD COLUMN scope        TEXT NOT NULL DEFAULT '';
ALTER TABLE block_events ADD COLUMN created_at   INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_block_events_tx_id ON block_events(tx_id);
CREATE INDEX idx_block_events_mutator ON block_events(mutator_name);
```

Each tx commit appends one row per *block touched*, all with the same `tx_id` and `mutator_name`. Plus one synthetic row per tx with no `block_id` for tx-level metadata.

What this enables:
- **Audit log**: `SELECT * FROM block_events ORDER BY created_at DESC LIMIT 100`.
- **Cross-tab invalidation**: existing.
- **Plugin observers**: `postCommitProcessorsFacet` reads from this stream.
- **Devtools timeline**: the tx_id grouping makes "show me what happened in this transaction" trivial.
- **Future events-derived undo** (out of scope, see §13.6): rebuild before-snapshots from event log.

---

## 11. Migration phases

Each phase is its own implementer subagent task. Each phase's commit must keep `yarn tsc -b` and `yarn vitest run` green. Phases land in order; later phases assume earlier ones merged.

### Phase 1 — `repo.tx` with real DB transactions

**Goal**: introduce a tx primitive that wraps `db.writeLock` in a single `BEGIN/COMMIT`, and route `applyBlockChange` through it.

**Scope**:
- New `Tx` interface with `update`/`create`/`delete`/`get`/`peek`/`run`.
- `repo.tx(fn, opts)` opens writeLock + BEGIN + runs fn + writes staged ops + COMMIT.
- `applyBlockChange` becomes a thin wrapper that constructs a 1-block tx.
- `UndoRedoManager` is invoked once per tx (one entry per `repo.tx` call).
- Existing callback-style `block.change(d => …)` compiles its callback to a staged update and calls `tx.update(id, patch)` internally. **Same call sites, no API breakage.**

**Out of scope for this phase**: named mutators, facets, event-log upgrade.

**Acceptance**:
- Multi-block ops (`indent`, `outdent`, `delete`) wrap a single `BEGIN/COMMIT`.
- Crash-test simulation: kill mid-tx, no partial writes survive.
- Existing tests pass without modification.

### Phase 2 — Sync `Block`, load at boundary

**Goal**: make `Block` a sync view over loaded `BlockData`. Promote `useSyncExternalStore`-based hooks. Adds `await repo.load(id, opts)` boundary.

**Scope**:
- `Block.data` becomes a sync getter; `Block.dataSync` deleted.
- `Block.parent`/`Block.children` become sync (require cached relatives).
- `useBlockData(id)` uses Suspense for first load.
- `repo.load(id, opts)` with `{ ancestors?, descendants?: number }` ensures range cached.
- All `await block.data()` → `await repo.load(id)` + `block.data` (sync) at call sites.
- Verify all imperative call sites either reach via React (Suspense handles it) or call `repo.load` once at top.

**Risk**: some call sites may be loading lazily; missing `repo.load` shows up as "BlockNotLoaded" runtime errors. Mitigation: a development-mode wrapper that reports the call stack of any cache miss.

**Acceptance**:
- No `async` on `Block` instance methods.
- No `dataSync` references in the codebase.
- All component renders work without effect-based loading patterns.

### Phase 3 — Property schemas split

**Goal**: separate `PropertySchema` (descriptor) from stored value.

Subsumes `tasks/property-access-refactor.md` if not yet landed; otherwise builds on it.

**Scope**:
- New `defineProperty(name, type, opts)` returns a `PropertySchema<T>`.
- Storage shape for `properties[name]` becomes raw `T` instead of `{name, type, value, changeScope}`.
- Read path (`block.get(schema)`, `block.peekProperty(schema)`) tolerates both old and new shapes during migration.
- Write path (mutators that update properties) emit new shape.
- One-shot SQL migration (post-deploy): rewrite all rows where `properties.x.value` exists to flatten to `properties.x = value`.
- `BlockProperty` union deleted; its callers migrated to `PropertySchema`.

**Acceptance**:
- All `as T` casts on `properties[name].value` removed.
- New rows written in flat shape.
- One-shot migration tested on a sample dataset.

### Phase 4 — Facet introduction (`mutatorsFacet`, `queriesFacet`, `propertySchemasFacet`, `postCommitProcessorsFacet`)

**Goal**: introduce the four new facets; migrate all existing mutations and queries to facet contributions.

**Depends on**: `tasks/plugins-architecture.md` having landed (folders exist).

**Scope**:
- Define facets in `src/data/api/facets.ts` per §5.
- `Repo` reads facet runtime at construction; rebuilds registries when runtime changes.
- Kernel mutators registered: `setContent`, `setProperty` (generic), `indent`, `outdent`, `move`, `split`, `merge`, `delete`, `insertChildren`, `createChild`, `createSiblingAbove`, `createSiblingBelow`. Names finalize during this phase.
- Kernel queries registered: `subtree`, `ancestors`, `backlinks`, `byType`, `searchByContent`, `firstChildByContent`, `aliasesInWorkspace`, `aliasMatches`, `firstRootBlock`.
- Reference parsing migrated to a `postCommitProcessorsFacet` contribution (`mode: 'same-tx'`, `watches: ['setContent', 'create']`).
- Property schemas migrated to `propertySchemasFacet` contributions.
- `repo.mutate.X` / `repo.query.X` accessor proxies built from registries, with module augmentation hooks defined on `MutatorRegistry` / `QueryRegistry` interfaces.

**Acceptance**:
- `block.change(callback)` and `applyBlockChange` deleted.
- All call sites use `repo.mutate.<name>(args)` or `repo.tx(tx => …)`.
- A new plugin can register a mutator and call site can invoke it via `repo.mutate['plugin:foo']({...})` with full typing.

### Phase 5 — Handles + reactivity invalidation

**Goal**: replace ad-hoc reactive code with a uniform `Handle`/`useHandle` system.

**Scope**:
- `HandleStore` with identity-stable lookup and GC.
- `repo.block(id)`, `repo.subtree(id)`, `repo.ancestors(id)`, etc. return handles.
- `repo.query.<name>(args)` returns a handle.
- `useHandle(handle)` uses `useSyncExternalStore` + Suspense.
- Existing `useBacklinks`, `useParents`, etc. become 1-line wrappers around `useHandle(repo.query.X(args))`.
- Tx commit walks affected handles, re-runs, diffs, fires.
- Cross-tab invalidation goes through the same handle store.

**Out of scope**: query-level differential dataflow (re-run + diff is enough).

**Acceptance**:
- `useDataWithSelector` deleted; `useHandle(handle, { selector })` is its replacement.
- `useBacklinks` and similar no longer have effect-based reload logic.
- Memory profile check: handles GC after subscriber count + load count = 0 for `gcTime` (default 30s).

### Phase 6 — Tree operations to SQL

**Goal**: replace JS-side recursion in `parents()`, `isDescendantOf`, `visitBlocks`, `getRootBlock` with recursive CTEs.

**Scope**:
- `ANCESTORS_SQL` recursive CTE on `parent_id`.
- `subtreeQuery`, `ancestorsQuery`, `isDescendantOfQuery` registered.
- `visitBlocks` reimplemented as `subtree(rootId).load()` then in-memory tree walk.
- `getRootBlock` becomes `ancestors(id)` + last element.

**Acceptance**:
- No `await block.parent()` in a loop anywhere in the codebase.
- Subtree-loading benchmark (1000 blocks, 5 levels deep) drops from N+1 SQL queries to 1.

### Phase 7 — `block_events` named-event upgrade

**Goal**: each tx commit appends named events with mutator + args to `block_events`.

**Scope**:
- Schema migration adds columns per §10.
- `TxEngine` writes named events on commit.
- Cross-tab invalidation and post-commit processors read mutator-name from events.
- Audit-log devtool (basic): list of recent txs with description, user, mutators, affected blocks.

**Out of scope**: events-derived undo (see §13.6).

**Acceptance**:
- `block_events` rows carry mutator names.
- Devtool shows tx history.
- Post-commit processors filter by mutator name correctly.

---

## 12. Tests

For each phase, add tests in `src/data/test/` covering:

- **Phase 1 (`tx`)**: atomicity (mid-tx throw rolls back DB + cache + undo), nested `tx.run`, multi-block writes commit together.
- **Phase 2 (sync block)**: `block.data` throws on not-loaded, `repo.load` populates, Suspense-driven render in a React test.
- **Phase 3 (properties)**: descriptor read/write, old/new storage shape parity, migration script idempotence.
- **Phase 4 (facets)**: registering a mutator from a contribution makes it callable via `repo.mutate`, registering a duplicate name logs warning + last-wins, runtime args validation rejects invalid args.
- **Phase 5 (handles)**: identity stability across calls, GC after subscribers detach, structural diffing prevents spurious notifications, cross-tab invalidation via simulated `block_events` row.
- **Phase 6 (tree)**: ancestors/subtree/isDescendantOf return correct results, no per-level fetches in observed network.
- **Phase 7 (events)**: tx commit writes named event rows; post-commit processors fire on matching names; mutator-name filtering works.

A new `src/data/test/factories.ts` (per `architectural-observations.md` #8) provides `createTestRepo({ user?, initialBlocks?, plugins? })` to reduce setup boilerplate across all phases.

---

## 13. Open questions / decide during implementation

### 13.1 Mutator vs query for read+write composite ops

Some operations are read-then-write (a "toggle" mutator reads current value, writes inverse). These fit naturally as mutators. But what about a "read N rows, return summary, also update last-accessed"? That's a query-shaped result that also writes. Decision: mutators can return values (`Result` parameter), and queries are read-only. Composite ops with side effects are mutators that happen to return.

### 13.2 Effect Schema vs zod

Both work for schema validation. **Decide at Phase 4**. Constraints:
- Bundle size: zod is bigger. Effect Schema requires the Effect runtime (also big).
- TS inference quality: both excellent.
- Familiarity: zod more common in the React ecosystem.
- LiveStore uses Effect Schema; if we ever borrow more from LiveStore, alignment helps.

Default to **zod** unless there's a positive reason for Effect — most likely choice given React-ecosystem familiarity.

### 13.3 Plugin-owned entity tables

Today: only the `blocks` table. A plugin like comments or annotations might want its own table. Out of scope for this spec; revisit when a plugin actually needs it. Would require an `entitiesFacet` and PowerSync sync-config additions per plugin.

### 13.4 Checkpoints for undo coalescing

TinyBase-style: undo granularity decoupled from tx granularity. Useful for char-level edits coalesced into word-level undo. Defer to a follow-up; the tx-level undo from Phase 1 is enough for v1.

### 13.5 Signals vs `useSyncExternalStore`

`useHandle` uses `useSyncExternalStore` per Phase 5. Future: could replace with signals (Solid-style) for finer-grained tracking. Defer; revisit if React performance becomes a bottleneck.

### 13.6 Events-derived undo

If `block_events` carries enough metadata, the undo stack could be reconstructed from it (stored in the same DB instead of in-memory). Pros: cross-tab undo, persistent across reloads. Cons: more complex, requires inverse computation. Defer.

### 13.7 Same-tx vs follow-up post-commit processor default

Reference parsing should be same-tx. Search indexing should be follow-up. Other plugins will have their own preference. **Default**: follow-up (eventual consistency is the safer default; same-tx requires the processor to be fast and deterministic). Plugin author opts into same-tx explicitly when their post-processing must be atomic with the original write.

### 13.8 Repo singleton vs context-only

`tasks/architectural-observations.md` #6 proposes deleting `repoInstance.ts` and going context-only. **Land that change as part of Phase 1** — `Tx` and the new `Repo` API need a clean lifecycle, and the singleton complicates per-test instantiation. Confirm during Phase 1 start.

---

## 14. Out of scope

- **Replacing PowerSync** with another sync engine (Zero, ElectricSQL, Replicache).
- **Adopting TanStack DB** as the read layer. The reasons it doesn't fit are documented in the design conversation; revisit only if hand-rolled query handles become a maintenance burden.
- **CRDTs beyond row-LWW + fractional indexing**.
- **Differential dataflow / IVM** for query reactivity.
- **A new SQLite schema for blocks**. Existing schema stays; only `block_events` is augmented.
- **Sandboxing dynamic plugins**. Trust model is as-today: dynamic plugins run with kernel authority.
- **Query result caching beyond per-handle**. Two callers asking for the same query share a handle (identity), so they share the cached result. No L2 cache.
- **Schema migrations as a first-class plugin concern**. Plugins that need to migrate stored data write SQL migrations under `supabase/migrations/`.

---

## 15. References

### Existing code (current state)
- `src/data/block.ts` — `Block` class (to be transformed into sync view).
- `src/data/repo.ts` — `Repo` class (to be re-shaped).
- `src/data/blockStorage.ts` — PowerSync write queue (kept; tx engine wraps it).
- `src/data/blockQueries.ts` — SQL templates (extended with `ANCESTORS_SQL`).
- `src/data/blockSchema.ts` — `BlockRow` / `BlockData` shapes (kept).
- `src/data/blockCache.ts` — in-memory snapshot cache (kept; integrates with handles).
- `src/data/undoRedo.ts` — `UndoRedoManager` (kept; entries become 1-per-tx).
- `src/data/properties.ts` — property schemas (migrated to `propertySchemasFacet`).
- `src/extensions/facet.ts` — `defineFacet`, `FacetRuntime` (kernel; reused).
- `src/extensions/core.ts` — existing facets (sibling to new data-layer facets).
- `src/hooks/block.ts` — React hooks (replaced by `useHandle` + sugar).
- `src/context/repo.tsx` — `RepoProvider` (kept; lifecycle simplified after singleton removal).

### Related task specs
- `tasks/architectural-observations.md` — items #2, #3, #6, #7, #9 subsumed.
- `tasks/property-access-refactor.md` — likely subsumed by Phase 3.
- `tasks/plugins-architecture.md` — must land before Phase 4.
- `tasks/decorator-facet-design.md` — pattern reference for facet decoration.
- `tasks/actionManager-refactor.md` — orthogonal.

### External design references
- LiveStore — past-tense event names, sync queries, signals-based reactivity. https://docs.livestore.dev/
- Replicache — named mutators, server-replay-rebase, KV reads. https://doc.replicache.dev/
- Zero (Rocicorp) — relational query API + IVM. https://zero.rocicorp.dev/
- TanStack DB (with PowerSync collection) — closest layerable alternative considered and declined. https://tanstack.com/db/latest/docs/overview
- TinyBase — Checkpoints undo pattern (deferred to follow-up).

---

## 16. Acceptance for the spec itself (not the implementation)

This is a design spec, not a migration runbook. It is "accepted" when:

- [ ] The four core types (`Handle`, `Tx`, `Mutator`, `Query`) and four facets are signed off.
- [ ] The phasing order (1 → 7) is signed off and each phase is sized; phases that turn out to be too large get split into their own task specs at start-of-phase.
- [ ] Open questions §13 are tracked; §13.2 and §13.7 must be resolved before Phase 4 starts; others can resolve during their relevant phase.
- [ ] No phase blocks behavior; the codebase is shippable between every phase.
- [ ] The shape is reviewed against the dynamic-plugin-loading constraint (§6.2): every facet contribution must be constructible at runtime by code that can't use module augmentation.
