# Task: Data layer redesign — handles + tx + facet-contributed mutators/queries

Owner role: architect (this doc) → implementer subagents (per phase)
Type: architectural rewrite (multi-phase). Includes a **schema reset** — existing data is wiped on upgrade. We're in alpha; no back-compat shims.
Estimated scope: large. Touches `src/data/**`, `src/hooks/block.ts`, `src/extensions/{facet,core}.ts`, every shortcut handler, every component that reads block data. ~50+ files. Plus a SQLite schema reset + PowerSync sync-config update.

> **Recommended ordering vs. other specs:**
> - `tasks/property-access-refactor.md` — subsumed by Phase 6. If property-access-refactor lands first, Phase 6 inherits its `getPropertyValue`/`setPropertyValue` shape and replaces the property-record split with descriptor-based schemas.
> - `tasks/actionManager-refactor.md` — orthogonal; can land in either order.
> - `tasks/plugins-architecture.md` — must land **before** Phase 5 of this spec. Phase 5 adds plugin-contributed data-layer facets, which expects plugins to already be folder-organized.
> - `tasks/architectural-observations.md` items #2 (sync/async), #3 (schema vs value), #6 (Repo singleton), #7 (changeScope typing), #9 (`any` casts) are subsumed by this spec.

> **Revision history:** v2 reworks event-log ownership (split `row_events` from `command_events`), adopts a clean schema break (drop `child_ids_json` for `parent_id + order_key` fractional indexing), uses PowerSync's `writeTransaction` instead of manual BEGIN/COMMIT under `writeLock`, makes `tx.get` async (queries SQLite within the tx), models reference parsing semantics in full (alias creation, daily notes, self-destruct), addresses the Repo/FacetRuntime lifecycle cycle, and resolves the Handle missing-vs-not-loaded distinction. Cross-tab is now explicitly out of scope.

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
| **D10** | Children stored as JSON array on parent | `child_ids_json` is the source of order, which means sibling inserts/moves take a parent-row LWW conflict surface. |

### 1.2 Constraint that reshapes the design

The codebase has chosen a **kernel + facet** architecture (see `src/extensions/facet.ts`, `tasks/decorator-facet-design.md`, `tasks/plugins-architecture.md`). Every UI-side feature contributes via a facet; the data layer is the only major subsystem that doesn't follow this pattern. **The redesign aligns the data layer with the facet kernel** — mutators, queries, property schemas, and post-commit processors all become facet contributions.

### 1.3 Constraint: dynamic plugin loading

Plugins are loaded both at compile time (static imports under `src/plugins/`) and at runtime (renderer/extension blocks compiled via Babel, see `src/extensions/dynamicRenderers.ts`). The data-layer API has to:

- Be fully typed for static plugins (module augmentation for `repo.mutate.X` / `repo.query.X`).
- Accept dynamic plugins that aren't in the TypeScript module graph (string-keyed access, runtime schema validation).
- Expose the **same facet contribution shape** for both — only the typing channel differs.

### 1.4 Constraint: alpha; data is droppable

We're in alpha and don't need to preserve existing data. Schema breaks are taken cleanly (drop & recreate), no dual-reader logic, no migration scripts. This is a deliberate choice per the project's "no back-compat shims while in alpha" rule.

---

## 2. Goals

1. **Single read primitive: `Handle<T>`.** Every read returns a handle with `peek` / `load` / `subscribe`. One React hook, `useHandle(handle)`, adapts any handle to a component.
2. **Single write primitive: `repo.tx`.** All mutations go through transactional sessions backed by PowerSync's `writeTransaction`. One DB tx, one undo entry, one command-event row, atomic cache update — all per `repo.tx` call.
3. **Mutators are named, typed, and contributed via facet.** Anonymous callback mutations (`block.change(d => …)`) are removed. `repo.mutate.indent({ id })` is the public surface; typed via module augmentation for static plugins, runtime-validated for dynamic ones.
4. **Queries are facet contributions.** `findBacklinks` etc. become contributions to `queriesFacet`, alongside plugin queries. `repo.query.<name>` returns a `Handle`.
5. **Property schemas are facet contributions** (descriptor only; values stored separately). Plugins register their own. Includes runtime codecs for non-JSON values (`Date`, etc.).
6. **Post-commit work is facet-contributed.** Reference parsing, search indexing, anything else cross-cutting becomes a `postCommitProcessorsFacet` contribution.
7. **Tree walks push to SQL.** Recursive CTEs over `parent_id` replace JS-side parent-chain and subtree iteration. Sibling order comes from `order_key` (fractional indexing).
8. **`Block` becomes a sync view.** Loading is an explicit boundary (Suspense in React; `await repo.load(…)` in imperative code). Post-load access is sync.
9. **Event log is split.** `row_events` (trigger-written, audit + invalidation) and `command_events` (tx metadata + mutator calls) — neither tries to do both.
10. **Schema is redesigned.** New `blocks` shape: `parent_id + order_key`, no `child_ids_json`. Sibling concurrency stops being a parent-row LWW problem.

### 2.1 Non-goals

- Replacing PowerSync as the storage + sync layer.
- Switching to event sourcing (events as truth, rows as projection). Rows remain authoritative; events are the audit/change log.
- Differential dataflow / IVM for query invalidation. Re-run + structural diff is enough at our query depth.
- CRDT primitives beyond what PowerSync gives + fractional indexing.
- Cross-tab invalidation. Today's runtime sets `enableMultiTabs=false, useWebWorker=false` (`src/data/repoInstance.ts`); multi-tab is a separate work item, not part of this redesign. See §13.
- Preserving existing user data.

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
│ Repo (context-only; no module-singleton)                    │
│   repo.block(id)        → Handle<BlockData | null>          │
│   repo.subtree(id)      → Handle<BlockData[]>               │
│   repo.query.X(args)    → Handle<Result>                    │
│   repo.tx(fn, opts)     → Promise<TxResult>                 │
│   repo.mutate.X(args)   → Promise<Result>  // sugar over tx │
│   repo.run(name, args)  → Promise<unknown> // dynamic       │
│   repo.setFacetRuntime(rt) // lifecycle                     │
└──────┬──────────────────┬───────────────────────────────────┘
       │                  │
       ▼                  ▼
┌──────────────┐  ┌────────────────────────────────────────┐
│ HandleStore  │  │ Registries (snapshot of FacetRuntime)  │
│  identity-   │  │  mutators                              │
│  stable      │  │  queries                               │
│  GC by ref   │  │  property schemas                      │
│  count       │  │  post-commit processors                │
└──────┬───────┘  └─────────────────┬──────────────────────┘
       │                            │
       ▼                            ▼
┌─────────────────────────────────────────────────────────────┐
│ TxEngine                                                    │
│   db.writeTransaction(async (txDb) => {                     │
│     run mutator(s) on staged Tx                             │
│       reads: staged → cache → SQL via txDb                  │
│     run same-tx post-commit processors                      │
│     write rows + append command_event row                   │
│     row_events written by SQLite triggers                   │
│   })                                                        │
│   on success: hydrate cache, diff handles, fire             │
│   schedule follow-up post-commit processors                 │
│   record undo entry                                         │
│   on throw: PowerSync rolls back; cache untouched           │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ PowerSync SQLite                                            │
│   blocks (id, workspace_id, parent_id, order_key, …)        │
│   row_events (trigger-written; audit + invalidation)        │
│   command_events (tx metadata; tx_id, mutator_calls, …)     │
└─────────────────────────────────────────────────────────────┘
```

Two top-level abstractions: `Handle` (reads) and `Tx` (writes). All else either feeds them (facets) or is the storage layer (PowerSync) with a redesigned schema.

---

## 4. Schema (clean break)

Existing tables (`blocks` with `child_ids_json`, `block_events` mixing row diffs and tx metadata) are dropped. New schema:

### 4.1 `blocks`

```sql
CREATE TABLE blocks (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  parent_id       TEXT,                                       -- null for workspace root
  order_key       TEXT NOT NULL,                              -- fractional index among siblings
  content         TEXT NOT NULL DEFAULT '',
  properties_json TEXT NOT NULL DEFAULT '{}',                 -- flat: {[name]: value}, no descriptor metadata
  references_json TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  created_by      TEXT NOT NULL,
  updated_by      TEXT NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_blocks_parent_order
  ON blocks(parent_id, order_key) WHERE deleted = 0;

CREATE INDEX idx_blocks_workspace_active
  ON blocks(workspace_id) WHERE deleted = 0;

CREATE INDEX idx_blocks_workspace_with_references
  ON blocks(workspace_id) WHERE deleted = 0 AND references_json != '[]';
```

Ordering is via `order_key` (string, fractional index — see `fractional-indexing` library by @rocicorp). Inserting between siblings A and B means computing a new key between `A.order_key` and `B.order_key`. **This eliminates the parent-row LWW conflict** that `child_ids_json` had: two clients inserting under the same parent both produce distinct row inserts with distinct keys; both succeed and sort correctly. Moving a block updates `parent_id` and `order_key`; concurrent moves of the *same* block are still row-LWW on that single row, which is acceptable.

`properties_json` is now `Record<string, unknown>` — just the value, no descriptor metadata in storage. The descriptor lives in code (kernel + plugin exports).

### 4.2 `command_events`

```sql
CREATE TABLE command_events (
  tx_id           TEXT PRIMARY KEY,
  description     TEXT,
  scope           TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  workspace_id    TEXT,
  mutator_calls   TEXT NOT NULL,                              -- JSON array of {name, args}
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_command_events_created ON command_events(created_at DESC);
CREATE INDEX idx_command_events_workspace ON command_events(workspace_id, created_at DESC);
```

One row per `repo.tx` invocation. `mutator_calls` is the ordered list of named mutator calls executed within the tx (a tx can compose multiple mutators via `tx.run`). Used by post-commit processors and the audit-log devtool.

### 4.3 `row_events`

```sql
CREATE TABLE row_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id           TEXT NOT NULL,                              -- FK-ish to command_events.tx_id
  block_id        TEXT NOT NULL,
  kind            TEXT NOT NULL,                              -- 'create' | 'update' | 'delete'
  before_json     TEXT,                                       -- null on 'create'
  after_json      TEXT,                                       -- null on 'delete'
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_row_events_tx ON row_events(tx_id);
CREATE INDEX idx_row_events_block ON row_events(block_id, created_at DESC);
CREATE INDEX idx_row_events_created ON row_events(created_at DESC);
```

Written by SQLite triggers on `blocks` (one trigger per insert/update/delete). Audit + invalidation source. Reading the `before_json` is what enables undo to reconstruct prior states without us having to capture them in JS.

The triggers read `tx_id` from a per-connection variable that the TxEngine sets at the start of each `writeTransaction`:

```sql
CREATE TEMP TABLE _ctx (tx_id TEXT, user_id TEXT);
-- TxEngine: INSERT INTO _ctx VALUES (?, ?) at tx start; DELETE FROM _ctx at tx end.
-- Triggers: SELECT tx_id FROM _ctx for the inserted row_events.tx_id.
```

This replaces the existing `block_event_context` mechanism but with the same idea.

### 4.4 PowerSync sync-config

Sync config (`sync-config.yaml`) is updated to:
- Sync `blocks` (with the new shape).
- **Not** sync `row_events` / `command_events` from server initially. They start as local-only (events generated on each device). If we later want a server-side audit log, that's a separate decision — see §13.

The Postgres schema mirrors the local schema; both get the order_key column. The schema reset is shipped as a single migration on the Postgres side and a clean reset on the local side (drop the local DB on first launch under a new schema version).

---

## 5. Core types

These go in a new `src/data/api/` module, exported as the public data-layer surface. Internals live in `src/data/internals/`.

### 5.1 `Handle<T>`

```ts
export interface Handle<T> {
  /** Stable key — two handles with the same key are === to each other. */
  readonly key: string

  /** Sync read. Returns undefined if not yet loaded. Never throws.
   *  After a successful load, returns T (which may itself be e.g. null/[]/etc). */
  peek(): T | undefined

  /** Ensure loaded; resolve when value is available. Idempotent + deduped. */
  load(): Promise<T>

  /** Reactive subscription. Listener fires on structural change only. */
  subscribe(listener: (value: T) => void): Unsubscribe

  /** For React/Suspense paths: returns T or throws a Promise if not loaded.
   *  Used internally by useHandle. */
  read(): T

  /** Status accessor for code that needs to distinguish loading from loaded. */
  status(): 'idle' | 'loading' | 'ready' | 'error'
}
```

Identity rule: `repo.block(id) === repo.block(id)` for the same id. Same for `repo.subtree(rootId)`, `repo.query.X(sameArgs)`. Implementation: `HandleStore` keys handles by `(name, JSON.stringify(args))`, returns existing handle if present, GCs after `gcTime` of zero subscribers + zero in-flight loads.

**Missing vs not-loaded.** For potentially-missing single-row reads, the value type encodes it: `repo.block(id): Handle<BlockData | null>`. After a successful load:
- `peek()` returns `BlockData | null` (`null` = confirmed not-found).
- Before any load, `peek()` returns `undefined`.
- `status()` distinguishes: `'idle'` / `'loading'` / `'ready'` (regardless of value being null) / `'error'`.

This keeps Suspense semantics clean (suspending only happens on first load, never on "not found") and lets the existing missing-data-renderer UI keep working: `useHandle(repo.block(id))` returns `BlockData | null`; component checks for null.

For multi-result handles (`subtree`, `backlinks`, `query.byType`), the result is always an array — possibly empty, never null.

### 5.2 `Block` (sync view)

```ts
export interface Block {
  readonly id: string
  readonly repo: Repo

  /** Sync; throws BlockNotLoadedError if not in cache, BlockNotFoundError if confirmed missing. */
  readonly data: BlockData

  /** Soft access. */
  peek(): BlockData | undefined | null         // undefined = not loaded; null = not found
  load(): Promise<BlockData | null>

  /** Sync property access via descriptor.
   *  Returns descriptor.defaultValue if absent. */
  get<T>(schema: PropertySchema<T>): T
  /** Sync property access; returns undefined if absent (no default substitution). */
  peekProperty<T>(schema: PropertySchema<T>): T | undefined

  /** Sync sibling/parent access — relies on cached parent/children.
   *  Throws BlockNotLoadedError if the immediate relative isn't cached. */
  readonly parent: Block | null
  readonly children: Block[]                                  // ordered by order_key

  /** Subscribe to this block's data changes. */
  subscribe(listener: (data: BlockData | null) => void): Unsubscribe
}
```

`Block` is a thin facade over the cached `BlockData`. It carries no `currentUser`, no `undoRedoManager`, no methods that mutate. Mutation goes through `repo.tx` / `repo.mutate.X`.

`block.parent` / `block.children` access cached siblings synchronously, throwing if any required relative isn't cached. Multi-level walks go through tree queries; immediate-neighbor walks go through these getters.

### 5.3 `Tx` (transactional session, async reads)

```ts
export interface Tx {
  /** Read with read-your-own-writes:
   *  staged writes in this tx → cache → SQL via the active writeTransaction.
   *  Returns null if the row doesn't exist. */
  get(id: string): Promise<BlockData | null>

  /** Sync version: requires the row to be already preloaded into cache.
   *  Throws BlockNotLoadedError otherwise.
   *  Use only when the mutator has guaranteed preload (e.g. via opts.reads). */
  peek(id: string): BlockData | null

  /** Low-level primitives — used inside mutator implementations. */
  create(data: NewBlockData): string                          // returns new id
  update(id: string, patch: Partial<BlockData>): void
  delete(id: string): void                                    // soft delete (sets deleted=1)

  /** Run another mutator inside this tx. Reads see prior staged writes. */
  run<Args, R>(mutator: Mutator<Args, R>, args: Args): Promise<R>

  /** Within-tx queries — async, transactional. */
  childrenOf(parentId: string): Promise<BlockData[]>          // ordered by order_key
  parentOf(childId: string): Promise<BlockData | null>
  /** Run a registered query within this tx. */
  query<R>(query: Query<unknown, R>, args: unknown): Promise<R>

  /** Tx metadata. */
  readonly meta: { description?: string; scope: ChangeScope; user: User; txId: string }
}
```

**Reads are async** because they must be transactionally consistent — staged-or-cache hits are sync internally, but cache misses fall through to SQLite within the active `writeTransaction`. Making `tx.get` return a Promise hides that fall-through from callers and removes the "did you remember to preload?" footgun.

The signature of `apply` becomes:

```ts
apply: (tx: Tx, args: Args) => Promise<Result>                // always async
```

For mutators that genuinely read nothing (e.g., `setProperty`), the implementation is still `async` but trivial — fine.

**Optional preload via opts** for callers who want to amortize reads:

```ts
await repo.tx(fn, { reads: { blockIds: [a, b], subtreeOf: rootId }, … })
```

The TxEngine preloads these into the staged-read cache before calling `fn`, so subsequent `tx.get(a)` resolves synchronously. Purely an optimization; correctness is independent.

### 5.4 `Mutator<Args, Result>`

```ts
export interface Mutator<Args = unknown, Result = void> {
  readonly name: string                                       // 'indent', 'tasks:setDueDate'
  readonly argsSchema: Schema<Args>                           // zod (see §13.1)
  readonly resultSchema?: Schema<Result>
  readonly apply: (tx: Tx, args: Args) => Promise<Result>
  readonly describe?: (args: Args) => string
  /** Optional: declared loads, preloaded by the engine before apply runs.
   *  Pure performance hint; correctness is independent of this. */
  readonly reads?: (args: Args) => ReadHints
}
```

Mutators are **async, transactional, composable**. They read via `tx.get`, run other mutators via `tx.run`, but cannot perform IO outside the tx. Side effects (search index update, references) are post-commit processors, not part of the mutator.

### 5.5 `Query<Args, Result>`

```ts
export interface Query<Args, Result> {
  readonly name: string
  readonly argsSchema: Schema<Args>
  readonly resultSchema: Schema<Result>
  readonly resolve: (args: Args, ctx: QueryCtx) => Promise<Result>
  readonly invalidatedBy: QueryInvalidation
}

type QueryInvalidation =
  | { kind: 'tables'; tables: string[] }                      // any change to these tables
  | { kind: 'mutators'; names: string[] }                     // these mutator commits
  | { kind: 'rows'; predicate: (event: RowEvent) => boolean } // row-level

interface QueryCtx {
  db: PowerSyncDatabase                                       // raw SQL escape hatch
  repo: Repo                                                  // for handle composition
  hydrateBlocks(rows: BlockRow[]): BlockData[]
}
```

Built-in queries (`subtree`, `ancestors`, `backlinks`, `searchByContent`, `byType`, `firstChildByContent`, `firstRootBlock`, `aliasesInWorkspace`, `aliasMatches`) are kernel contributions to `queriesFacet`. Plugin queries register the same way.

### 5.6 `PropertySchema<T>`

```ts
export interface PropertySchema<T> {
  readonly name: string                                       // 'is-collapsed', 'tasks:due-date'
  readonly codec: Schema<T>                                   // (de)serialization for non-JSON values
  readonly defaultValue: T
  readonly changeScope: ChangeScope
  readonly category?: string                                  // for property-editor grouping
}
```

`codec` handles non-JSON primitives — `Date` ↔ ISO string, custom objects, etc. The descriptor's codec is invoked at the boundary where stored JSON meets typed code.

### 5.7 `PostCommitProcessor`

```ts
export interface PostCommitProcessor {
  readonly name: string
  /** Mutator names whose commits this processor reacts to. */
  readonly watches: string[]
  /** 'same-tx' runs inside the original tx (atomic);
   *  'follow-up' runs in a separate small tx after commit. */
  readonly mode: 'same-tx' | 'follow-up'
  readonly apply: (event: CommittedEvent, tx: Tx) => Promise<void>
}

interface CommittedEvent {
  txId: string
  matchedCalls: Array<{ name: string; args: unknown }>        // calls matching this processor's `watches`
  user: User
  workspaceId: string
}
```

Reference parsing is the canonical example and has its own design section (§7).

### 5.8 `ChangeScope` (typed)

```ts
export const ChangeScope = {
  BlockDefault: 'block-default',
  UiState: 'local-ui',                                        // not undoable; ui-only
  References: 'block-default:references',
} as const
export type ChangeScope = (typeof ChangeScope)[keyof typeof ChangeScope]
```

UI-state writes (`isCollapsed`, `isEditing`, focus, selection) use `ChangeScope.UiState` and are not part of the document undo stack.

Plugins extend via module augmentation:

```ts
declare module '@/data/api' {
  interface ChangeScopeRegistry {
    'tasks:agenda': true
  }
}
```

Dynamic-plugin scopes that can't augment at compile time are accepted as plain strings and validated at registration time.

---

## 6. Facets

Four new kernel facets contribute to the data layer. Defined in `src/data/api/facets.ts`, read by `Repo` after `setFacetRuntime` is called (see §8).

```ts
export const mutatorsFacet            = defineFacet<Mutator,             MutatorRegistry>({...})
export const queriesFacet             = defineFacet<Query,               QueryRegistry>({...})
export const propertySchemasFacet     = defineFacet<PropertySchema,      PropertySchemaRegistry>({...})
export const postCommitProcessorsFacet = defineFacet<PostCommitProcessor, PostCommitDispatcher>({...})
```

Each facet's `combine` builds a registry keyed by `name`; duplicate names log a warning and last-wins (matching `blockRenderersFacet`).

The kernel registers built-ins as plain contributions. There is **no two-tier system** — `core.indent` and `tasks:setDueDate` are both contributions, distinguishable only by `name` prefix convention.

### 6.1 Naming convention

- Kernel: bare names — `indent`, `outdent`, `setProperty`, `subtree`, `backlinks`.
- Plugin: `<plugin-id>:<name>` — `tasks:setDueDate`, `calendar:eventsInRange`.

The colon-prefix rule isn't enforced in code (a contribution could ship a bare-named version). It's a convention in `src/plugins/README.md`; lint follow-up if warranted.

---

## 7. Reference parsing — full design

The current `parseAndUpdateReferences` does materially more than "extract refs from content"; the redesign must preserve every behavior. This section enumerates them and maps each to the new model.

### 7.1 What today's code does

1. **Parse references** from `content` (look for `[[alias]]`, links, etc.).
2. **Resolve aliases**: for each parsed alias, look up an existing block in this workspace whose `aliases` property contains it.
3. **Create missing alias blocks**: if no existing block matches, create a new block with the alias as a property (call it the *alias-target* block).
4. **Daily notes**: for date-shaped aliases (e.g. `[[2026-04-28]]`), the alias-target block is a daily-note with a deterministic id (`daily/<workspaceId>/<date>`), so two clients creating it concurrently end up with the same row.
5. **Update `references` field** on the source block to the resolved id list.
6. **Self-destruct**: newly-created alias-target blocks that are *not* actually retained (e.g., the user typed `[[foo]]` and immediately deleted it within ~4s) auto-delete. Implemented as a deferred check.
7. **skipUndo + skipMetadataUpdate flags**: today's helpers run with these set so the parsing isn't a user-visible undoable action and doesn't bump `updated_at`/`updated_by`.

### 7.2 Mapping to the new model

| Concern | New shape |
|---|---|
| Trigger | `postCommitProcessorsFacet.of({ name: 'core.parseReferences', watches: ['setContent', 'create', 'splitBlock', 'mergeBlocks'], mode: 'same-tx', … })` |
| Parse refs | Inside `apply`, call existing `parseRefs(content)` helper. |
| Resolve aliases | `tx.query(aliasLookup, { workspaceId, alias })` — a kernel query that joins `properties_json` against the alias property. |
| Create missing | `tx.run(createAliasTarget, { alias, workspaceId })` — kernel mutator. |
| Daily notes | `createAliasTarget` checks if the alias is date-shaped; if so, computes deterministic id and uses `INSERT OR IGNORE` semantics (`tx.create({ id: deterministic, … })` returning existing id when already present). |
| Update `references` field | `tx.update(sourceId, { references: resolvedIds })`. |
| Self-destruct | A second processor `core.cleanupOrphanAliases` (mode: `'follow-up'`, debounce ~4s, watches `core.parseReferences` outputs). It looks for created alias-targets that are not referenced from any other block and deletes them. **Won't run if the alias was retained** — i.e., if any block's `references_json` contains the alias-target id. |
| skipUndo / skipMetadataUpdate | Same-tx processor writes are part of the user's tx (one undo entry overall). The metadata flag is replaced by the convention that processor-driven `update` calls don't bump `updated_at`/`updated_by` — which is enforced by the TxEngine looking at the *tx scope* and the *call origin*: writes from a same-tx processor inherit the original mutator's metadata. The follow-up processor *does* generate a fresh metadata stamp because it's a separate tx (and that's correct — the cleanup is its own action). |

### 7.3 Mutators introduced for this

```ts
// kernel mutator: create alias-target with deterministic id for date-shaped aliases
defineMutator({
  name: 'createAliasTarget',
  argsSchema: t.object({ alias: t.string(), workspaceId: t.string() }),
  resultSchema: t.object({ id: t.string(), createdNow: t.boolean() }),
  apply: async (tx, { alias, workspaceId }) => {
    const id = isDateAlias(alias)
      ? deterministicDailyId(workspaceId, parseDate(alias))
      : generateId()
    const existing = await tx.get(id)
    if (existing) return { id, createdNow: false }
    tx.create({ id, workspaceId, parent_id: ..., aliases: [alias], … })
    return { id, createdNow: true }
  }
})
```

### 7.4 Queries introduced for this

```ts
defineQuery({
  name: 'aliasLookup',
  argsSchema: t.object({ workspaceId: t.string(), alias: t.string() }),
  resultSchema: t.array(blockDataSchema),
  invalidatedBy: { kind: 'mutators', names: ['setProperty', 'create', 'delete'] },
  resolve: async ({ workspaceId, alias }, { db, hydrateBlocks }) => {
    const rows = await db.getAll(ALIAS_LOOKUP_SQL, [workspaceId, alias])
    return hydrateBlocks(rows)
  }
})
```

`ALIAS_LOOKUP_SQL` uses `json_each(properties_json -> 'aliases')` to find blocks containing the alias.

### 7.5 Test coverage required (from §11)

- A `setContent` mutator with `[[foo]]` creates an alias-target if none exists; same tx; one undo entry undoes both.
- Same with `[[2026-04-28]]` produces the deterministic daily-note id; two simultaneous creates resolve to the same row.
- Typing `[[foo]]` then deleting that text within 4s: `core.cleanupOrphanAliases` removes the orphan.
- Typing `[[foo]]`, then linking again from another block within 4s: orphan is *kept* (it's now referenced).

---

## 8. Repo / FacetRuntime lifecycle

Today's lifecycle has a bootstrap cycle: `Repo` is constructed in `RepoProvider`; `AppRuntimeProvider` builds the FacetRuntime from extensions; some extensions are loaded by querying through Repo. That's a circular dependency.

### 8.1 Lifecycle contract

1. **`Repo.constructor`** initializes with **kernel registries only** — built-in mutators/queries/property schemas/post-commit processors hard-coded into the `Repo` constructor's import list. No FacetRuntime needed.
2. **`AppRuntimeProvider`** reads existing extensions, builds the FacetRuntime, and calls **`repo.setFacetRuntime(runtime)`**. The Repo merges the runtime's facet contributions into its registries. This call may happen multiple times as the runtime rebuilds.
3. **`repo.tx`** snapshots the registries at tx start. Mid-tx runtime changes do not affect that tx.
4. **Removed dynamic processors do not fire on already-running follow-up txs** — follow-up processors execute against the registry snapshot from when they were scheduled.

### 8.2 What this means concretely

```ts
// src/data/repo.ts
export class Repo {
  private registries: Registries = buildKernelRegistries()    // bootstraps with kernel only

  setFacetRuntime(runtime: FacetRuntime): void {
    const fromFacets = readDataFacets(runtime)
    this.registries = mergeRegistries(buildKernelRegistries(), fromFacets)
    this.notifyRegistryListeners()                             // for handles tracking facet-defined queries
  }

  async tx<R>(fn, opts?): Promise<R> {
    const snapshot = this.registries                            // captured at tx start
    return runTxWithSnapshot(snapshot, fn, opts)
  }
}
```

### 8.3 Why this resolves the cycle

`Repo` no longer awaits FacetRuntime to start. Components that need data access work as soon as `Repo` is constructed. Plugin-contributed mutators/queries become available after the runtime is built and `setFacetRuntime` is called — that delay is acceptable because dynamic-plugin functionality wasn't usable before that point anyway. Static plugins already have their contributions in the kernel-or-runtime registry.

---

## 9. Reactivity & invalidation

### 9.1 Per-handle subscription

Every `Handle<T>` maintains:
- `value: T | undefined` — last computed result
- `listeners: Set<Listener>`
- `dependencies: Dependencies` — what would invalidate this handle's value

Handle implementations register dependencies during their first `load`. On a tx commit, the `TxEngine` walks the affected dependencies and re-runs handles.

### 9.2 What "affected" means

Three sources of invalidation:

1. **Row-level**: a row in `blocks` changed. Handles whose dependencies include that row id re-run. (`repo.block(id)` is the obvious case; `repo.subtree(rootId)` is invalidated if any descendant row changed.)
2. **Mutator-level**: a query declares `invalidatedBy: { kind: 'mutators', names: ['indent', 'outdent'] }` — re-runs only when those commit.
3. **Table-level**: catch-all coarse invalidation.

Kernel handles (`block`, `subtree`, `ancestors`, `backlinks`) declare row-level dependencies during their `resolve` (the resolver knows which row ids it touched). Plugin queries can declare any of the three; row-level is opt-in.

### 9.3 Invalidation source

The TxEngine drives invalidation directly from the staged-write set on commit success — it knows exactly which rows changed and what the new values are. `row_events` is the audit/cross-process source-of-truth log, but in-process invalidation does not wait on a `row_events` read; the TxEngine pushes the invalidations synchronously after `writeTransaction` resolves.

For multi-process invalidation (cross-tab), see §13 — out of scope for v1.

### 9.4 Structural diffing

After re-running, the new value is compared to the cached one. Default comparator: `lodash.isEqual`. Listeners only fire if the result actually changed. For specific result shapes a faster comparator can be supplied via `useHandle(handle, { eq })`.

### 9.5 React integration

`useHandle(handle)` is the only React adaptor:

```ts
export function useHandle<T>(
  handle: Handle<T>,
  options?: { selector?: (v: T) => unknown; eq?: EqualityFn }
): T
```

Bespoke hooks (`useBlockData`, `useSubtree`, etc.) are 1-line sugar; the primitive is `useHandle`.

---

## 10. Transaction commit pipeline

A `repo.tx(fn, opts)` call uses PowerSync's `writeTransaction`:

```
┌──────────────────────────────────────────────────────────────┐
│ 1. db.writeTransaction(async (txDb) => {                     │
│ 2.   set _ctx (tx_id, user_id) — for triggers                │
│ 3.   construct Tx (write-set staged in memory; reads use txDb)│
│ 4.   preload opts.reads (if provided)                        │
│ 5.   user fn(tx, opts) runs:                                 │
│        tx.update / tx.create / tx.delete / tx.run            │
│        reads: staged → cache → SQL via txDb                  │
│ 6.   run same-tx post-commit processors against staged calls │
│        (refs parsing happens here)                           │
│ 7.   write all rows to blocks (txDb)                          │
│ 8.   write command_event row (txDb)                          │
│        row_events written by triggers                        │
│ 9.   clear _ctx                                              │
│ 10. })  // PowerSync COMMIT or ROLLBACK                      │
│ 11. on success: hydrate cache, walk handles, diff, notify    │
│ 12. record undo entry from staged before-snapshots           │
│ 13. resolve repo.tx promise with user fn's return value      │
│ 14. schedule follow-up post-commit processors (own txs)      │
└──────────────────────────────────────────────────────────────┘
```

Steps 1–10 are PowerSync's atomic transaction. Step 11 happens after COMMIT but before `repo.tx` resolves — the cache and undo stack are updated **before** the promise resolves to the caller. Step 14 is fire-and-after, in its own writeTransactions.

If step 5 or 6 throws: `writeTransaction` rolls back; cache, command_events, row_events all unchanged; `repo.tx` rejects with the error.

If step 7 or 8 throws (DB-level): same — full rollback, error propagates.

### 10.1 `repo.mutate.X` is sugar for a 1-mutator tx

```ts
await repo.mutate.indent({ id })
// ≡
await repo.tx(async tx => tx.run(indentMutator, { id }), {
  description: indentMutator.describe?.({ id }),
  scope: ChangeScope.BlockDefault,
})
```

### 10.2 Read-your-own-writes

`tx.get(id)` checks the staged write-set first, then the cache, then SQLite via the active `writeTransaction`. The SQL fall-through reads from the same transaction — there is no race window between staged writes and committed state.

### 10.3 Same-tx vs follow-up processors

| Mode | When to use | Examples |
|---|---|---|
| `'same-tx'` | The processor's output must be atomic with the original write. | `core.parseReferences` (refs must be consistent with content) |
| `'follow-up'` | Eventual consistency is OK. | search indexing, the orphan-alias cleanup, telemetry |

Default for new processors: `'follow-up'`. Same-tx requires the processor be deterministic and fast (must complete before the user's tx commits).

### 10.4 UI-state writes

Mutators can declare `scope: ChangeScope.UiState`. Writes with that scope:
- Still go through the same tx pipeline.
- Are **not** added to the document undo stack.
- May be coalesced (debounced) at the call site (e.g., for selection updates) — coalescing is a caller concern, not a kernel feature.

### 10.5 Read-only mode

`Repo.isReadOnly` (existing flag) gates writes. `repo.tx` rejects with `ReadOnlyError` for any non-`UiState` mutator. UI-state mutations are still allowed (scrolling, selection, etc.). Behavior matches today.

---

## 11. Tree operations — push to SQL

With `parent_id + order_key`, recursive CTEs become straightforward:

### 11.1 Subtree

```sql
WITH RECURSIVE subtree AS (
  SELECT *, '' AS path
  FROM blocks
  WHERE id = :rootId AND deleted = 0
  UNION ALL
  SELECT child.*, subtree.path || '/' || child.order_key AS path
  FROM subtree
  JOIN blocks AS child ON child.parent_id = subtree.id
  WHERE child.deleted = 0
)
SELECT * FROM subtree ORDER BY path;
```

No more `json_each` over `child_ids_json`. `path` is the lexicographic concatenation of `order_key`s — sorts correctly without explicit depth tracking.

### 11.2 Ancestors

```sql
WITH RECURSIVE chain AS (
  SELECT * FROM blocks WHERE id = :id AND deleted = 0
  UNION ALL
  SELECT parent.*
  FROM chain
  JOIN blocks AS parent ON parent.id = chain.parent_id
  WHERE parent.deleted = 0
)
SELECT * FROM chain WHERE id != :id ORDER BY rowid;
```

### 11.3 isDescendantOf

```sql
WITH RECURSIVE chain AS (
  SELECT id, parent_id FROM blocks WHERE id = :id
  UNION ALL
  SELECT b.id, b.parent_id FROM blocks AS b JOIN chain ON chain.parent_id = b.id
)
SELECT 1 FROM chain WHERE id = :potentialAncestor LIMIT 1;
```

### 11.4 Children

```sql
SELECT * FROM blocks
WHERE parent_id = :id AND deleted = 0
ORDER BY order_key;
```

### 11.5 JS-side helpers gone

`block.parents()`, `block.isDescendantOf()`, `getRootBlock()`: replaced by `repo.query.ancestors({id})` (handle) or `tx.query(ancestors, {id})` (within a tx).

`visitBlocks`: `repo.subtree(rootId).load()` once, then in-memory traversal of the array. No per-level fetches.

---

## 12. Plugin extension model

### 12.1 Static plugins (compile-time)

```ts
// src/plugins/tasks/schema.ts
import { defineProperty, ChangeScope } from '@/data/api'
import { z } from 'zod'

export const dueDateProp = defineProperty('tasks:due-date', {
  codec: z.coerce.date(),
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

// src/plugins/tasks/mutators.ts
import { defineMutator } from '@/data/api'
import { dueDateProp } from './schema'

export const setDueDate = defineMutator({
  name: 'tasks:setDueDate',
  argsSchema: z.object({ id: z.string(), date: z.date() }),
  apply: async (tx, { id, date }) => {
    const block = await tx.get(id)
    if (!block) throw new Error(`Block ${id} not found`)
    tx.update(id, {
      properties: { ...block.properties, [dueDateProp.name]: date }
    })
  }
})

// src/plugins/tasks/index.ts
import { mutatorsFacet, propertySchemasFacet } from '@/data/api'
import { setDueDate } from './mutators'
import { dueDateProp } from './schema'

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
```

### 12.2 Dynamic plugins (runtime-loaded)

Renderer/extension blocks compiled via Babel use the same API at runtime:

```js
const setBookmark = defineMutator({
  name: 'bookmarks:set',
  argsSchema: z.object({ id: z.string(), url: z.string().url() }),
  apply: async (tx, { id, url }) => { /* ... */ }
})

contribute(mutatorsFacet, setBookmark)
```

Dynamic plugins can't use `declare module`, so calls go through the runtime registry:

```ts
await repo.run('bookmarks:set', { id, url: 'https://...' })
```

`repo.run` validates the args at call time (the registry has the schema) and returns `Promise<unknown>`. A dynamic plugin can ship a `.d.ts` companion that augments `MutatorRegistry` if it wants typed call sites elsewhere — optional.

### 12.3 Trust model

Static plugins are in the TS module graph and code-reviewed. Dynamic plugins run with kernel authority (no sandbox today). **Mutator args validate at the boundary** for both — even a buggy plugin can't write malformed data, only well-typed unwanted data. Sandboxing is out of scope.

---

## 13. Migration phases

Each phase is its own implementer-subagent task. Each phase keeps `yarn tsc -b` and `yarn vitest run` green. Phases land in order; later phases assume earlier ones merged. Cross-tab is explicitly **not** part of any phase here.

### Phase 1 — Schema reset

**Goal**: drop & recreate `blocks` (with `parent_id + order_key`); replace single `block_events` with `row_events` + `command_events`; add triggers; update PowerSync sync-config.

**Scope**:
- New SQL DDL per §4.
- Postgres migration: drop old tables, create new tables with same shape (server-side).
- Local DB schema version bump → drop & recreate on first launch under new version. No client-side migration of old data.
- SQLite triggers on `blocks` writing `row_events` rows.
- `blockSchema.ts` updated to new row shape (snake_case columns); `blockToRowParams` / `parseBlockRow` updated.
- `blockStorage.ts` adjusted: writes use `parent_id + order_key`; reads via the new schema.
- All readers/writers of `child_ids_json` updated to query children via `parent_id` ordered by `order_key`. (Kernel only at this phase; mutators that *change* order use the existing change-callback API but compute new order_keys.)
- Add `fractional-indexing` (or equivalent) library.
- `sync-config.yaml` updated.

**Out of scope this phase**: tx engine, named mutators, handles, facets. The existing `Block` / `Repo` / `block.change()` API still works; only its underlying storage shape changes.

**Acceptance**:
- App boots from empty DB.
- All existing tests pass after row-shape migration in test fixtures.
- Insert/move operations use `order_key`; concurrent sibling inserts under the same parent both persist.
- Triggers populate `row_events` correctly.

### Phase 2 — Tx engine on `writeTransaction`

**Goal**: introduce `repo.tx(fn, opts)` backed by PowerSync's `writeTransaction`. Route existing `applyBlockChange` through it. Real BEGIN/COMMIT/ROLLBACK. Single undo entry per tx. Async `tx.get` queries SQLite within the tx.

**Scope**:
- New `Tx` interface with async `get`, sync `peek` (cache-only), `update`, `create`, `delete`, `run`, `query`, `childrenOf`, `parentOf`.
- `repo.tx` opens `db.writeTransaction`, sets `_ctx`, runs fn, writes staged rows + `command_event`, clears `_ctx`, commits.
- `applyBlockChange` becomes a thin wrapper that compiles a callback into a 1-block tx with a synthetic mutator name `legacy.applyBlockChange`. **Same call sites, no API breakage** — temporary wrapper deleted in Phase 5.
- `block.change(d => …)` callback: same wrapping. Existing call sites continue to work.
- `UndoRedoManager` invoked once per `repo.tx` call (one entry per tx).
- Repo singleton (`repoInstance.ts`) deleted in this phase per `architectural-observations.md` #6 (clean lifecycle for tx; tests need fresh Repo per case).

**Out of scope**: named mutators, facets, handles, sync-Block migration.

**Acceptance**:
- Multi-block ops (`indent`, `outdent`, `delete`) wrap a single `writeTransaction`.
- Crash/abort mid-tx (simulated by throwing in the user fn) leaves DB and cache untouched.
- Undo entries are 1-per-tx. `block_events`-equivalent rows are split: one `command_event`, multiple `row_events` (trigger-written).
- Existing tests pass without modification.

### Phase 3 — Sync `Block` + Handles + React migration

**Goal**: replace async-cascading `Block` API with a sync view; introduce `Handle<T>` and `useHandle`; migrate React components.

**Scope**:
- `Block.data` becomes a sync getter (throws if not loaded; nullable for not-found).
- `Block.dataSync` deleted.
- `Block.parent` / `Block.children` become sync (cached relatives).
- `repo.load(id, opts)` with `{ ancestors?, descendants?: number }` for explicit preload.
- New `HandleStore` with identity-stable lookup and ref-count GC.
- `repo.block(id)` returns `Handle<BlockData | null>`.
- `repo.subtree(id)` etc. return handles (still using existing repo-internal queries; the queries-as-facet move comes in Phase 5).
- `useHandle(handle)` uses `useSyncExternalStore` + Suspense.
- `useBlockData`, `useSubtree`, `useChildren`, `useBacklinks`, `useParents` rewrite as 1-line sugar over `useHandle`.
- `useDataWithSelector` → `useHandle(handle, { selector })`.
- All `await block.data()` sites migrate to `await repo.load(id)` + sync access (or `useHandle(...)` in components).
- Dev-mode wrapper that reports the call stack on `BlockNotLoadedError` (helps catch missing preloads during migration).

**Acceptance**:
- No `dataSync` references remain.
- No `await block.data()` calls remain.
- `useBacklinks` etc. no longer use ad-hoc `useEffect`-based reload logic.
- Ancestor/descendant preloads in `repo.load(...)` are typed and required at every imperative call site that accesses non-immediate relatives.

### Phase 4 — Named mutators + post-commit processors as facets

**Goal**: introduce `mutatorsFacet`, `postCommitProcessorsFacet`. Migrate every kernel mutation to a named mutator. Implement `repo.setFacetRuntime` lifecycle.

**Depends on**: `tasks/plugins-architecture.md` having landed.

**Scope**:
- Define `mutatorsFacet` and `postCommitProcessorsFacet` per §6.
- `Repo` constructor builds kernel registries directly; `repo.setFacetRuntime(rt)` merges facet contributions.
- Kernel mutators registered: `setContent`, `setProperty`, `indent`, `outdent`, `move`, `split`, `merge`, `delete`, `insertChildren`, `createChild`, `createSiblingAbove`, `createSiblingBelow`, `setOrderKey`, `createAliasTarget`. Names finalize during this phase; final list is captured in PR description.
- Reference parsing migrated to `core.parseReferences` post-commit processor (mode: `'same-tx'`) per §7. Includes alias creation, daily-note deterministic id, and the orphan-cleanup follow-up processor.
- `repo.mutate.X` / `repo.run('name', args)` accessor surfaces — typed via module augmentation; runtime path validates args.
- `block.change(d => ...)` and the legacy `applyBlockChange` wrapper deleted.
- All call sites use `repo.mutate.<name>(args)` or `repo.tx(tx => …)`.
- ChangeScope typed (`architectural-observations.md` #7); `local-ui` scope wired.

**Acceptance**:
- `block.change` no longer exists.
- A new plugin can register a mutator and call site invokes via `repo.mutate['plugin:foo']({...})` with full typing.
- Reference parsing produces identical results to today's behavior in tests covering: alias resolution, alias creation, daily-note creation under concurrency, orphan cleanup with and without retention.
- `repo.setFacetRuntime` snapshot semantics hold — a runtime change mid-tx doesn't affect that tx.

### Phase 5 — Queries facet + property schemas facet

**Goal**: migrate kernel queries and property schemas to facets. Property schema split (descriptor only in code, flat values in storage).

**Scope**:
- `queriesFacet` defined; kernel queries migrated: `subtree`, `ancestors`, `backlinks`, `byType`, `searchByContent`, `firstChildByContent`, `aliasesInWorkspace`, `aliasMatches`, `firstRootBlock`, `aliasLookup`.
- `propertySchemasFacet` defined; existing `xxxProp` exports refactored as descriptors with codecs (see §5.6).
- `properties_json` in storage becomes flat `{[name]: T}` — descriptor metadata removed from storage. (Phase 1 already prepared this — Phase 5 stops emitting the descriptor metadata; the codec (de)serializes typed values.)
- `block.set(schema, value)` / `block.get(schema)` / `block.peekProperty(schema)` are the ergonomic API.
- `BlockProperty` union deleted.

**Acceptance**:
- All `as T` casts on `properties[name].value` removed.
- All `xxxProp` exports are `PropertySchema` descriptors.
- A plugin can register a `dueDateProp` with a `Date` codec and the typed `block.get(dueDateProp)` returns `Date | undefined`.

### Phase 6 — SQL tree helpers

**Goal**: replace JS-side recursion with recursive CTEs.

**Scope**:
- `ANCESTORS_SQL`, updated `SUBTREE_SQL` (using `parent_id`), `IS_DESCENDANT_OF_SQL`.
- Kernel queries `subtree`, `ancestors`, `isDescendantOf` registered at Phase 5 use these CTEs.
- `visitBlocks` rewritten to load subtree once and walk in memory.
- `getRootBlock` rewritten as `repo.query.ancestors({id}).load()` + last element.

**Acceptance**:
- No `await block.parent()` in a loop.
- Subtree benchmark: 1000 blocks 5 levels deep = 1 SQL query, not N+1.

---

## 14. Tests

For each phase:

- **Phase 1**: row CRUD via new schema; trigger writes correct `row_events`; `order_key` insertion is conflict-free for two simultaneous parent siblings.
- **Phase 2**: atomicity (mid-tx throw rolls back DB + cache + undo); nested `tx.run`; multi-block writes commit together; `tx.get` falls through to SQL when not cached; `command_event` and `row_events` are coherent (same `tx_id`).
- **Phase 3**: `block.data` throws `BlockNotLoadedError` when not loaded; `repo.load` populates; Suspense-driven render in a React test; `Handle<BlockData | null>` distinguishes not-loaded from not-found via `status()`.
- **Phase 4**: registering a mutator from a contribution makes it callable via `repo.mutate`; duplicate names log warning + last-wins; runtime args validation rejects invalid args; **reference parsing**: full coverage per §7.5, including daily-note determinism under concurrent creation.
- **Phase 5**: identity stability across calls; GC after subscribers detach; structural diffing prevents spurious notifications; descriptor codec round-trips `Date` correctly.
- **Phase 6**: ancestors/subtree/isDescendantOf return correct results; no per-level fetches in observed network.

A new `src/data/test/factories.ts` (per `architectural-observations.md` #8) provides `createTestRepo({ user?, initialBlocks?, plugins? })` to reduce setup boilerplate.

---

## 15. Invariants worth nailing

1. **Read-only mode**: `repo.tx` rejects non-`UiState` mutators when `repo.isReadOnly`. UI-state writes always allowed.
2. **UI-state scope**: `ChangeScope.UiState` writes don't enter the document undo stack. They go through the same tx pipeline (still atomic with whatever else is in the tx).
3. **Codecs at boundaries only**: descriptor `codec` runs at `block.set`/`block.get`. The on-disk shape is JSON; codec lifts to/from typed values. No codec inside mutators (they take typed args).
4. **Order-key concurrency**: concurrent inserts under the same parent never conflict (different rows, different keys). Concurrent moves of the *same* block remain row-LWW; document this explicitly.
5. **Tx snapshot**: `repo.tx` runs against the registry snapshot taken at tx start. Mid-tx facet runtime changes do not affect the running tx.
6. **Same-tx processors are deterministic**: their writes are part of the user's tx — they must not depend on time, randomness, or external IO. Follow-up processors may be non-deterministic.
7. **`tx.get` is consistent**: staged → cache → SQL via the active `writeTransaction`. No partial-read window.
8. **Block.data is sync after load; never returns stale values mid-tx**: the cache update in step 11 of the pipeline (§10) happens before `repo.tx` resolves, so any code that awaits the tx and then reads `block.data` sees the post-tx state.
9. **Trigger metadata via `_ctx`**: `tx_id` and `user_id` flow into `row_events` only via the `_ctx` temp table set at tx start. Writes outside a `repo.tx` are forbidden by convention; in practice nothing should bypass `repo.tx`.

---

## 16. Open questions / decide during implementation

### 16.1 zod vs Effect Schema

Default to **zod** (smaller bundle, broader React-ecosystem familiarity). Effect Schema is interesting but requires the Effect runtime. **Decide at Phase 4 start.**

### 16.2 Same-tx vs follow-up default

Default new processors to `'follow-up'`. Same-tx is opt-in. Reference parsing is the rare exception (atomic refs are a correctness need).

### 16.3 Plugin-owned entity tables

Out of scope for v1. Plugins use properties for everything. Revisit when at least one plugin actually needs its own table.

### 16.4 Checkpoints for undo coalescing (TinyBase-style)

Defer. Tx-level undo is enough for v1. Add when typing UX demands it.

### 16.5 Signals vs `useSyncExternalStore`

`useHandle` uses `useSyncExternalStore`. Future: signals (Solid-style) for finer-grained tracking. Defer; revisit if React perf becomes a bottleneck.

### 16.6 Events-derived undo

If we ever want persistent / cross-process undo, `row_events` already has `before_json` — reconstruct undo from it instead of in-memory. Defer; out of scope for this redesign.

### 16.7 Cross-tab invalidation

Out of scope. Today's `enableMultiTabs=false, useWebWorker=false` (`src/data/repoInstance.ts`) is preserved. Multi-tab is a separate work item that requires:
- Enabling the shared-worker mode in PowerSync.
- Subscribing to `row_events` in each tab and replaying invalidation through `HandleStore`.
- Deciding cross-tab undo semantics (probably: each tab has its own undo stack initially).

A follow-up task spec should pick this up after this redesign lands.

### 16.8 Server-side audit log

`row_events` and `command_events` are local-only initially. If we want a server-side audit log, sync them up via PowerSync. Defer.

### 16.9 Order-key rebalancing

Fractional indexing produces ever-longer keys under repeated insert-in-the-same-spot. A periodic rebalance pass that rewrites `order_key`s for a given parent is straightforward but can be deferred until keys actually grow. Defer.

### 16.10 What to do with `aliases` property

Today's properties include an `aliases` list; the alias-lookup query reads it. The new model keeps this. Alternative: separate `block_aliases` table for indexing. Defer unless the JSON-extract query is too slow.

---

## 17. Out of scope

- Replacing PowerSync.
- Adopting TanStack DB / Replicache / Zero / LiveStore wholesale.
- CRDTs beyond row-LWW + fractional ordering.
- Differential dataflow / IVM.
- Cross-tab invalidation (see §16.7).
- Server-side audit log.
- Sandboxing dynamic plugins.
- Migration of existing user data (alpha).
- Full event sourcing (rows stay authoritative).
- Plugin-owned entity tables.

---

## 18. References

### Existing code (current state)
- `src/data/block.ts` — `Block` class (transformed in Phase 3).
- `src/data/repo.ts` — `Repo` class (re-shaped through phases 2–5).
- `src/data/repoInstance.ts` — module singleton (deleted in Phase 2).
- `src/data/blockStorage.ts` — write queue / writeLock (replaced by `writeTransaction` in Phase 2).
- `src/data/blockQueries.ts` — SQL templates (rewritten Phase 1 + Phase 6).
- `src/data/blockSchema.ts` — `BlockRow` / `BlockData` shapes (rewritten Phase 1).
- `src/data/blockCache.ts` — in-memory cache (kept; integrates with handles in Phase 3).
- `src/data/undoRedo.ts` — kept; entries become 1-per-tx in Phase 2.
- `src/data/properties.ts` — refactored Phase 5 (descriptors with codecs).
- `src/extensions/facet.ts` — `defineFacet`, `FacetRuntime` (kernel; reused).
- `src/extensions/core.ts` — existing facets (sibling to new data-layer facets).
- `src/hooks/block.ts` — replaced Phase 3.
- `src/context/repo.tsx` — `RepoProvider` (kept; lifecycle simplified Phase 2).

### Related task specs
- `tasks/architectural-observations.md` — items #2, #3, #6, #7, #9 subsumed.
- `tasks/property-access-refactor.md` — subsumed by Phase 5.
- `tasks/plugins-architecture.md` — must land before Phase 4.
- `tasks/decorator-facet-design.md` — pattern reference for facet decoration.
- `tasks/actionManager-refactor.md` — orthogonal.

### External design references
- LiveStore — past-tense events, sync queries, signals reactivity. https://docs.livestore.dev/
- Replicache — named mutators, server-replay-rebase. https://doc.replicache.dev/
- Zero (Rocicorp) — relational query API + IVM. https://zero.rocicorp.dev/
- TanStack DB w/ PowerSync — closest layerable alternative; declined. https://tanstack.com/db/latest/docs/overview
- TinyBase — Checkpoints undo pattern (deferred).
- `fractional-indexing` (Rocicorp) — order_key generation. https://github.com/rocicorp/fractional-indexing
- PowerSync `writeTransaction` docs — https://docs.powersync.com/

---

## 19. Acceptance for the spec itself

- [ ] Reviewer's P0 findings addressed: event log split (§4), tx reads no longer cache-fragile (§5.3), reference processor full semantics (§7).
- [ ] Reviewer's P1 findings addressed: writeTransaction (§10), order_key schema (§4.1), cross-tab out of scope (§16.7), Repo lifecycle (§8).
- [ ] Reviewer's P2 finding addressed: Handle nullable for not-found (§5.1).
- [ ] Phase ordering reflects dependencies: schema → tx → handles+sync-Block → mutators+processors → queries+properties → tree.
- [ ] Each phase ships independently with a green build.
- [ ] Open questions §16 are tracked; §16.1 and §16.2 must resolve before Phase 4 starts.
- [ ] Dynamic-plugin lifecycle (§8) is constructible at runtime by code that can't use module augmentation.
- [ ] Invariants (§15) are referenced in test plans (§14).
