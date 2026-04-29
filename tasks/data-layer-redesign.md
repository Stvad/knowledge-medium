# Task: Data layer redesign — handles + tx + facet-contributed mutators/queries

Owner role: architect (this doc) → implementer subagents (per phase)
Type: architectural rewrite (multi-phase). Includes a **schema reset** — existing data is wiped on upgrade. We're in alpha; no back-compat shims.
Estimated scope: large. Touches `src/data/**`, `src/hooks/block.ts`, `src/extensions/{facet,core}.ts`, every shortcut handler, every component that reads block data. ~50+ files. Plus a SQLite schema reset + PowerSync sync-config update.

> **Revision history:**
> - v1: initial sketch.
> - v2: event-log split, schema reset accepted, `writeTransaction`, async `tx.get`, reference processor full semantics, Repo lifecycle, Handle nullable.
> - v3: regular `tx_context` table; bounded tx-read primitives; honest Phase 1 break; jittered order_key + `id` tiebreak; `Mutator.scope`; `tx.afterCommit`; upload triggers preserved.
> - v4: `parseReferences` is a **follow-up** processor (not same-tx); `tx.aliasLookup` dropped; no sync-apply wrapper required (trigger gates on `source = 'user'`, `row_events.source` COALESCE-defaults to `'sync'`); separate INSERT/UPDATE/DELETE triggers; `tx.update` options typed with `skipMetadata`; `tx.setProperty`/`tx.getProperty` to keep codecs at the boundary; `PropertySchema.codec` is a real bidirectional `Codec<T>`.
> - v4.1 (this): `PropertySchema` extended with `kind: PropertyKind` (required UI hint), optional `label` / `Editor` / `Renderer` for plugin-defined custom UI. Added §5.6.1 documenting how the property panel renders from the descriptor registry, with graceful degradation when a property's schema is not registered (e.g., plugin uninstalled). Closes the "how does the property UI know how to render now?" gap.

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

### 1.2 Constraint: facet kernel

The codebase has a kernel + facet architecture (`src/extensions/facet.ts`). UI features contribute via facets; the data layer is the only major subsystem that doesn't follow this pattern. **The redesign aligns the data layer with the facet kernel** — mutators, queries, property schemas, and post-commit processors all become facet contributions.

### 1.3 Constraint: dynamic plugin loading

Plugins are loaded both at compile time (static imports) and at runtime (extension blocks compiled via Babel). The data API has to:
- Be fully typed for static plugins (module augmentation for `repo.mutate.X` / `repo.query.X`).
- Accept dynamic plugins that can't use `declare module` (string-keyed access, runtime schema validation).
- Expose the **same facet contribution shape** for both — only the typing channel differs.

### 1.4 Constraint: alpha; data is droppable

We're in alpha. Schema breaks are taken cleanly (drop & recreate), no dual-reader logic, no migration scripts. This is a deliberate choice per the project's no-back-compat-in-alpha rule.

---

## 2. Goals

1. **Single read primitive: `Handle<T>`.** Every read returns a handle with `peek` / `load` / `subscribe`. One React hook, `useHandle(handle)`, adapts any handle to a component.
2. **Single write primitive: `repo.tx`.** All mutations go through transactional sessions backed by PowerSync's `writeTransaction`. One DB tx, one undo entry, one command-event row, atomic cache update — all per `repo.tx` call.
3. **Mutators are named, typed, and contributed via facet.** Anonymous callback mutations (`block.change(d => …)`) are removed. `repo.mutate.indent({ id })` is the public surface; typed via module augmentation for static plugins, runtime-validated for dynamic ones.
4. **Queries are facet contributions.** `findBacklinks` etc. become contributions to `queriesFacet`, alongside plugin queries. `repo.query.<name>` returns a `Handle`.
5. **Property schemas are facet contributions** (descriptor only; values stored flat). Plugins register their own. Includes runtime codecs for non-JSON values (`Date`, etc.).
6. **Post-commit work is facet-contributed.** Reference parsing, search indexing, anything cross-cutting becomes a `postCommitProcessorsFacet` contribution.
7. **Tree walks push to SQL.** Recursive CTEs over `parent_id` replace JS-side chains. Sibling order from `order_key` (jittered fractional index) with `id` tiebreak.
8. **`Block` becomes a sync view.** Loading is an explicit boundary (Suspense in React; `await repo.load(…)` in imperative code). Post-load access is sync.
9. **Event log is split.** `row_events` (trigger-written, audit + invalidation) and `command_events` (tx metadata + mutator calls) — neither tries to do both.
10. **Schema is redesigned.** New `blocks` shape: `parent_id + order_key`, no `child_ids_json`. Sibling concurrency stops being a parent-row LWW problem.

### 2.1 Non-goals

- Replacing PowerSync.
- Switching to event sourcing (events as truth, rows as projection). Rows remain authoritative; events are the audit/change log.
- Differential dataflow / IVM for query invalidation. Re-run + structural diff is enough.
- CRDT primitives beyond row-LWW + jittered fractional ordering.
- Cross-tab invalidation. Today's runtime sets `enableMultiTabs=false, useWebWorker=false` (`src/data/repoInstance.ts`); see §16.7.
- Preserving existing user data.
- Back-compat shims of any kind.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ React UI                                                    │
│   useHandle(handle); <Suspense> for first load              │
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
│   repo.setFacetRuntime(rt)                                  │
└──────┬──────────────────┬───────────────────────────────────┘
       │                  │
       ▼                  ▼
┌──────────────┐  ┌────────────────────────────────────────┐
│ HandleStore  │  │ Registries (snapshot of FacetRuntime)  │
│  identity-   │  │  mutators / queries / property         │
│  stable      │  │  schemas / post-commit processors      │
└──────┬───────┘  └─────────────────┬──────────────────────┘
       │                            │
       ▼                            ▼
┌─────────────────────────────────────────────────────────────┐
│ TxEngine (db.writeTransaction)                              │
│   set tx_context (tx_id, user_id, scope, source)            │
│   stage writes; reads = staged → cache → SQL via txDb       │
│   run same-tx processors (refs, ...)                        │
│   write blocks rows + command_events row                    │
│   row_events written by triggers (read tx_context)          │
│   trigger forwards to powersync_crud unless source=sync|ephem│
│ on success: hydrate cache, diff handles, fire, undo entry   │
│              run scheduled tx.afterCommit jobs              │
│ on throw: full rollback                                      │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ PowerSync SQLite                                            │
│   blocks (id, workspace_id, parent_id, order_key, …)        │
│   row_events       (audit + invalidation, trigger-written)  │
│   command_events   (per-tx metadata)                        │
│   tx_context       (one row, set per tx)                    │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Schema (clean break)

Existing tables are dropped and recreated. Postgres migration mirrors local. PowerSync sync-config rewritten.

### 4.1 `blocks`

```sql
CREATE TABLE blocks (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  parent_id       TEXT,                                     -- null for workspace root
  order_key       TEXT NOT NULL,                            -- jittered fractional index
  content         TEXT NOT NULL DEFAULT '',
  properties_json TEXT NOT NULL DEFAULT '{}',               -- flat: {[name]: T}, no descriptor metadata
  references_json TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  created_by      TEXT NOT NULL,
  updated_by      TEXT NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_blocks_parent_order
  ON blocks(parent_id, order_key, id) WHERE deleted = 0;     -- (id) is the secondary tiebreak

CREATE INDEX idx_blocks_workspace_active
  ON blocks(workspace_id) WHERE deleted = 0;

CREATE INDEX idx_blocks_workspace_with_references
  ON blocks(workspace_id) WHERE deleted = 0 AND references_json != '[]';
```

**Order strategy**: `order_key` is generated via a jittered fractional index (`fractional-indexing-jittered` or equivalent). Jittering reduces the probability of two clients computing the same key when inserting between the same neighbors, but **does not guarantee uniqueness**. We accept the residual collision and resolve it via a deterministic secondary sort:

```sql
-- canonical sort:
ORDER BY order_key, id
```

Concurrency story:
- Two clients insert different rows under the same parent at the same position → most likely distinct order_keys; if equal, secondary sort by `id` makes the resulting order deterministic post-sync.
- Two clients move the *same* block concurrently → row-LWW on `parent_id` and `order_key` of that single row.
- Clients on the same actor running fractional-indexing-jittered always produce monotonically distinct keys for sequential inserts; the collision case is strictly cross-actor concurrent inserts at the same spot.

A periodic rebalance pass (defer; §16.9) can rewrite keys when they grow too long, but is not required for correctness.

`properties_json` is `Record<string, unknown>` — just the value, codec-deserialized at read time via the descriptor (§5.6).

### 4.2 `tx_context`

```sql
CREATE TABLE tx_context (
  id        INTEGER PRIMARY KEY CHECK (id = 1),             -- single-row table
  tx_id     TEXT,
  user_id   TEXT,
  scope     TEXT,
  source    TEXT                                            -- 'user' | 'local-ephemeral'; NULL when no repo.tx is active
);
INSERT OR IGNORE INTO tx_context (id) VALUES (1);
```

A normal one-row table (mirroring today's `block_event_context` pattern). Triggers read via `(SELECT … FROM tx_context WHERE id = 1)`. **Why not a TEMP table**: SQLite triggers in `main` schema cannot reference `temp.X` tables.

The TxEngine sets `tx_context` at the start of `writeTransaction` (source = `'user'` or `'local-ephemeral'`) and clears it at the end (source = `NULL`). **Sync-applied writes (PowerSync's CRUD apply) bypass `repo.tx`**, so they leave `tx_context.source = NULL`. Triggers treat `NULL` as a synthetic `'sync'` (via `COALESCE`). No wrapper around PowerSync's CRUD apply is required — the absence of a tx_context entry is itself the signal.

The discipline this requires: every write to `blocks` either goes through `repo.tx` (which sets source) or is a PowerSync sync-apply (which doesn't). No third path. The codebase already follows this — the new `Repo` enforces it by removing every other write path.

### 4.3 `row_events`

```sql
CREATE TABLE row_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id           TEXT,                                     -- NULL for sync-applied
  block_id        TEXT NOT NULL,
  kind            TEXT NOT NULL,                            -- 'create' | 'update' | 'delete'
  before_json     TEXT,
  after_json      TEXT,
  source          TEXT NOT NULL,                            -- COALESCE(tx_context.source, 'sync')
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_row_events_tx ON row_events(tx_id);
CREATE INDEX idx_row_events_block ON row_events(block_id, created_at DESC);
CREATE INDEX idx_row_events_created ON row_events(created_at DESC);
```

Written by SQLite triggers on `blocks` (one per insert/update/delete). Triggers pull `tx_id` and `source` from `tx_context`. The audit + invalidation source-of-truth.

### 4.4 `command_events`

```sql
CREATE TABLE command_events (
  tx_id           TEXT PRIMARY KEY,
  description     TEXT,
  scope           TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  workspace_id    TEXT,
  mutator_calls   TEXT NOT NULL,                            -- JSON array of {name, args}
  source          TEXT NOT NULL,                            -- 'user' | 'local-ephemeral'  (sync writes don't produce command_events)
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_command_events_created ON command_events(created_at DESC);
CREATE INDEX idx_command_events_workspace ON command_events(workspace_id, created_at DESC);
```

One row per `repo.tx` invocation. Sync-applied writes don't go through `repo.tx` so they don't produce `command_events`; their row_events have `tx_id = NULL` and `source = 'sync'`.

### 4.5 Upload routing triggers

SQLite doesn't allow `INSERT OR UPDATE OR DELETE` in a single trigger — three separate triggers, gated identically on `source = 'user'`:

```sql
-- Forward LOCAL USER writes to powersync_crud (PowerSync's outgoing queue).
-- Sync-applied writes (source = NULL → COALESCE to 'sync') and UI-state writes
-- (source = 'local-ephemeral') do NOT upload.

CREATE TRIGGER blocks_upload_insert
AFTER INSERT ON blocks
WHEN (SELECT source FROM tx_context WHERE id = 1) = 'user'
BEGIN
  -- forward INSERT to powersync_crud (existing schema)
  …
END;

CREATE TRIGGER blocks_upload_update
AFTER UPDATE ON blocks
WHEN (SELECT source FROM tx_context WHERE id = 1) = 'user'
BEGIN
  -- forward UPDATE to powersync_crud
  …
END;

CREATE TRIGGER blocks_upload_delete
AFTER DELETE ON blocks
WHEN (SELECT source FROM tx_context WHERE id = 1) = 'user'
BEGIN
  -- forward DELETE to powersync_crud
  …
END;
```

The same INSERT/UPDATE/DELETE-split pattern is used for the `row_events` triggers (each with its own `INSERT INTO row_events SELECT … COALESCE((SELECT source FROM tx_context …), 'sync') …`).

### 4.6 PowerSync sync-config

`sync-config.yaml` is updated to:
- Sync `blocks` with the new shape.
- Not sync `tx_context`, `row_events`, `command_events` (local-only initially; see §16.8).

---

## 5. Core types

In `src/data/api/`. Internals in `src/data/internals/`.

### 5.1 `Handle<T>`

```ts
export interface Handle<T> {
  readonly key: string

  /** Sync read. undefined = not yet loaded; never throws. */
  peek(): T | undefined

  /** Ensure loaded; idempotent + deduped. */
  load(): Promise<T>

  /** Reactive subscription. Listener fires on structural change only. */
  subscribe(listener: (value: T) => void): Unsubscribe

  /** For Suspense paths: returns T or throws a Promise if not loaded. */
  read(): T

  status(): 'idle' | 'loading' | 'ready' | 'error'
}
```

Identity rule: same `(name, JSON.stringify(args))` → same handle instance. GC after `gcTime` of zero subscribers + zero in-flight loads.

**Missing vs not-loaded**: `repo.block(id): Handle<BlockData | null>`. After load, `null` = confirmed missing; `peek()` returns `BlockData | null` post-load. Before any load, `peek()` returns `undefined`. `status()` distinguishes loading from loaded.

For multi-result handles (`subtree`, `backlinks`, query results), the type is `Handle<BlockData[]>` — possibly empty, never null.

### 5.2 `Block` (sync view)

```ts
export interface Block {
  readonly id: string
  readonly repo: Repo

  /** Sync; throws BlockNotLoadedError if not in cache, BlockNotFoundError if confirmed missing. */
  readonly data: BlockData

  /** Soft access. */
  peek(): BlockData | undefined | null   // undefined = not loaded; null = not found
  load(): Promise<BlockData | null>

  /** Sync property access via descriptor. */
  get<T>(schema: PropertySchema<T>): T                       // returns descriptor.defaultValue if absent
  peekProperty<T>(schema: PropertySchema<T>): T | undefined  // no default substitution

  /** Sync relatives. childIds is computed from cache (must be loaded);
   *  parent and children Block objects are sync facades. */
  readonly childIds: string[]                                // ordered by (order_key, id), from cache
  readonly children: Block[]
  readonly parent: Block | null

  subscribe(listener: (data: BlockData | null) => void): Unsubscribe
}
```

`Block` is a thin facade. `childIds` is **derived from the cache** (other blocks with `parent_id = this.id`), not stored on `BlockData`. `BlockData` matches the row shape — no `childIds` field. The facade computes children on demand from the in-memory cache, throwing `BlockNotLoadedError` if any child row isn't loaded. (The hydrator preloads sibling ranges as part of `repo.load(id, { descendants: 1 })` etc.)

Mutation goes through `repo.tx` / `repo.mutate.X`. The Block facade has **no** mutating methods — even kernel ops like `indent` are accessed as `repo.mutate.indent({ id: block.id })`, not `block.indent()`.

### 5.3 `Tx` (transactional session, async reads, no arbitrary queries)

```ts
export interface Tx {
  /** Read with read-your-own-writes:
   *  staged writes in this tx → cache → SQL via the active writeTransaction.
   *  Returns null if the row doesn't exist. */
  get(id: string): Promise<BlockData | null>

  /** Sync version: requires the row to be already preloaded into cache or staged. */
  peek(id: string): BlockData | null

  /** Low-level primitives. */
  create(data: NewBlockData, opts?: TxWriteOpts): string     // returns new id
  update(id: string, patch: Partial<BlockData>, opts?: TxWriteOpts): void
  delete(id: string): void                                   // soft delete (sets deleted=1)

  /** Typed property primitives — the only path that runs codecs.
   *  setProperty: codec.encode applied; engine merges into properties_json patch.
   *  getProperty: codec.decode applied to the staged-or-cache-or-DB value.
   *  Direct properties manipulation via tx.update(...) bypasses codecs and is
   *  reserved for cases where the caller is intentionally working at the JSON level. */
  setProperty<T>(id: string, schema: PropertySchema<T>, value: T, opts?: TxWriteOpts): void
  getProperty<T>(id: string, schema: PropertySchema<T>): Promise<T | undefined>

  /** Compose another mutator. Reads see prior staged writes. */
  run<Args, R>(mutator: Mutator<Args, R>, args: Args): Promise<R>

  /** Within-tx tree primitives. Engine merges staged writes with SQL results explicitly. */
  childrenOf(parentId: string): Promise<BlockData[]>          // ordered by (order_key, id)
  parentOf(childId: string): Promise<BlockData | null>

  /** Schedule a follow-up post-commit job. Runs in its own writeTransaction
   *  after this tx commits. Does NOT run if the tx rolls back. */
  afterCommit(processorName: string, args: unknown, options?: { delayMs?: number }): void

  /** Tx metadata. */
  readonly meta: { description?: string; scope: ChangeScope; user: User; txId: string; source: TxSource }
}

interface TxWriteOpts {
  /** When true, engine does NOT auto-bump updated_at/updated_by (or created_at/created_by
   *  on tx.create). Used by same-tx processors whose writes are bookkeeping, not user
   *  intent. Default false. User-facing mutators should not set this. */
  skipMetadata?: boolean
}

type TxSource = 'user' | 'local-ephemeral'                   // 'sync' is set externally for sync-apply
```

**No arbitrary `tx.query`.** Arbitrary queries cannot honestly overlay staged writes (the Query.resolve gets raw SQL, doesn't know about the tx). Within-tx reads are limited to: `tx.get`/`tx.peek` (single block) and `tx.childrenOf`/`tx.parentOf` (immediate relatives). The engine implements these with explicit overlay logic.

If a mutator needs broader information (e.g., "all blocks of a type in this workspace"), it should:
- Call `await query.load()` *before* opening the tx (passing results in via args), or
- Call `tx.childrenOf` repeatedly to traverse a known structure, or
- For derived state, use a post-commit processor that reads the committed state.

This is the same constraint Replicache and Zero accept: tx reads are limited to what the engine can overlay. Anything richer happens outside the tx.

### 5.4 `Mutator<Args, Result>`

```ts
export interface Mutator<Args = unknown, Result = void> {
  readonly name: string
  readonly argsSchema: Schema<Args>
  readonly resultSchema?: Schema<Result>
  readonly apply: (tx: Tx, args: Args) => Promise<Result>
  readonly describe?: (args: Args) => string

  /** Scope drives undo behavior + read-only gating + upload routing.
   *  Function form lets a single mutator run as user vs ui-state based on args. */
  readonly scope: ChangeScope | ((args: Args) => ChangeScope)

  /** Optional preload hint; engine may preload these into cache before apply. */
  readonly reads?: (args: Args) => ReadHints
}
```

Scope semantics:
- `ChangeScope.BlockDefault` (or any document scope): undoable, uploads to server.
- `ChangeScope.UiState` (`'local-ui'`): not undoable; **`source='local-ephemeral'` set on `tx_context`**, so the upload trigger excludes these writes.
- Read-only mode: `repo.tx` rejects unless every mutator in the tx has UiState scope.
- Different mutators in the same tx with different scopes are not allowed (engine throws); a tx is one scope.

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
  | { kind: 'tables'; tables: string[] }
  | { kind: 'mutators'; names: string[] }
  | { kind: 'rows'; predicate: (event: RowEvent) => boolean }

interface QueryCtx {
  db: PowerSyncDatabase                                     // raw SQL
  repo: Repo
  hydrateBlocks(rows: BlockRow[]): BlockData[]
}
```

Queries are out-of-tx. Built-in queries (`subtree`, `ancestors`, `backlinks`, `searchByContent`, `byType`, `firstChildByContent`, `firstRootBlock`, `aliasesInWorkspace`, `aliasMatches`, `aliasLookup`) are kernel facet contributions.

### 5.6 `PropertySchema<T>` and `Codec<T>`

zod schemas validate but don't bidirectionally serialize (e.g. `z.coerce.date()` decodes ISO → Date but doesn't re-encode). Property storage needs both directions, so we ship a small `Codec` interface separate from zod (which we still use for mutator `argsSchema` validation):

```ts
export interface Codec<T> {
  encode(value: T): unknown                                  // → JSON-serializable
  decode(json: unknown): T                                   // ← from JSON-decoded; throws on mismatch
}

// Built-in helpers shipped from @/data/api:
export const codecs = {
  identity: <T>(): Codec<T> => ({ encode: x => x, decode: x => x as T }),
  string: codecs.identity<string>(),
  number: codecs.identity<number>(),
  boolean: codecs.identity<boolean>(),
  date: {
    encode: (d: Date) => d.toISOString(),
    decode: (s: unknown) => {
      if (typeof s !== 'string') throw new Error('date codec expects string')
      return new Date(s)
    },
  } satisfies Codec<Date>,
}

export type PropertyKind =
  | 'string' | 'number' | 'boolean' | 'list' | 'object' | 'date'

export interface PropertySchema<T> {
  readonly name: string

  /** Storage codec; runs only at the four boundary call sites listed below. */
  readonly codec: Codec<T>

  readonly defaultValue: T
  readonly changeScope: ChangeScope

  /** UI hint. The kernel ships a default editor + renderer per kind.
   *  Plugins with primitive types pick the matching kind and (optionally) override
   *  Editor/Renderer for richer UX. */
  readonly kind: PropertyKind

  /** UI metadata. */
  readonly label?: string                                    // human-readable; defaults to `name`
  readonly category?: string                                 // for property-editor grouping

  /** Optional custom UI. Override the default editor/renderer for this kind. */
  readonly Editor?: PropertyEditor<T>
  readonly Renderer?: PropertyRenderer<T>
}

interface PropertyEditor<T> {
  (props: { value: T; onChange: (next: T) => void; block: Block }): JSX.Element
}
interface PropertyRenderer<T> {
  (props: { value: T; block: Block }): JSX.Element
}
```

**Codec call sites are exactly four** (the boundary between typed values and stored JSON):
- `block.set(schema, value)` → `codec.encode`
- `block.get(schema)` → `codec.decode`
- `tx.setProperty(id, schema, value)` → `codec.encode`
- `tx.getProperty(id, schema)` → `codec.decode`

Storage (`properties_json`) and cache always hold the encoded shape. Codecs do not run inside the storage layer, the cache, the trigger, or PowerSync sync.

### 5.6.1 How the property UI renders from descriptors

The property panel (`BlockProperties.tsx`) iterates over `block.data.properties` (a `Record<string, unknown>` of encoded values) and for each entry:

1. Look up the schema in `propertySchemasFacet`'s registry by `name`.
2. **If known**: `codec.decode` the stored value; render via `schema.Editor ?? defaultEditorForKind(schema.kind)`.
3. **If unknown** (no plugin registered the schema, or plugin was uninstalled): infer a `PropertyKind` from the JSON shape (`string` / `number` / `boolean` / `list` / `object`); render via the default editor for that inferred kind. Show a small "schema not registered" indicator so users know edits may not round-trip cleanly through the original plugin's codec.

Default editors/renderers per kind ship from the kernel. Custom ones from plugins override per-property. Unknown properties never disappear from the UI — they degrade gracefully to JSON-shape inference. This keeps data discoverable when plugins are absent (after uninstall, before a slow plugin loads, etc.).

The `category` field groups properties in the panel. The `label` field is the display name (defaults to `name`).

The trade we're making by lifting schema out of stored values: gain plugin extension + type safety + single-source-of-truth for descriptor metadata, accept that "schema not registered" is a state the UI must handle. The fallback is straightforward; the benefits compound.

### 5.7 `PostCommitProcessor`

```ts
export interface PostCommitProcessor {
  readonly name: string

  /** Mutator names whose commits this processor reacts to. */
  readonly watches: string[]

  /** 'same-tx' runs inside the user's tx (atomic);
   *  'follow-up' runs after commit in its own writeTransaction. */
  readonly mode: 'same-tx' | 'follow-up'

  readonly apply: (event: CommittedEvent, tx: Tx) => Promise<void>
}

interface CommittedEvent {
  txId: string
  matchedCalls: Array<{ name: string; args: unknown }>
  user: User
  workspaceId: string

  /** Args passed via tx.afterCommit by an earlier processor (when mode='follow-up'
   *  and the processor was scheduled rather than name-matched). */
  scheduledArgs?: unknown
}
```

Two scheduling channels:
1. **Mutator-name match** (`watches`): processor fires when a tx commits and contains any matching mutator call. Args come from the matched call.
2. **Explicit schedule** (`tx.afterCommit(name, args, opts)`): processor fires after the tx commits with the supplied args via `event.scheduledArgs`. Used by chained processors (e.g. `parseReferences` schedules `cleanupOrphanAliases` with the just-created alias ids).

Same-tx processors should not use `tx.afterCommit` to schedule themselves — only follow-up scheduling makes sense after the current tx commits.

### 5.8 `ChangeScope` (typed)

```ts
export const ChangeScope = {
  BlockDefault: 'block-default',
  UiState: 'local-ui',
  References: 'block-default:references',
} as const
export type ChangeScope = (typeof ChangeScope)[keyof typeof ChangeScope]

declare module '@/data/api' {
  interface ChangeScopeRegistry { /* plugin augmentation */ }
}
```

---

## 6. Facets

```ts
mutatorsFacet            : Facet<Mutator,             MutatorRegistry>
queriesFacet             : Facet<Query,               QueryRegistry>
propertySchemasFacet     : Facet<PropertySchema,      PropertySchemaRegistry>
postCommitProcessorsFacet: Facet<PostCommitProcessor, PostCommitDispatcher>
```

Each facet's `combine` builds a registry keyed by `name`; duplicate names log a warning and last-wins.

The kernel registers built-ins as plain contributions. There is no two-tier system — `core.indent` and `tasks:setDueDate` are both contributions.

Naming convention: kernel uses bare names; plugins prefix with `<plugin-id>:`. Convention only.

---

## 7. Reference parsing — full design

The current `parseAndUpdateReferences` runs **after** content changes, fire-and-forget, with `skipUndo: true`. The redesign keeps that shape — a follow-up processor with its own scope — and adds explicit scheduling for the orphan-cleanup step.

### 7.1 Why follow-up, not same-tx

Same-tx parseReferences would be cleaner in theory: refs and content commit atomically, no brief-stale-window for backlinks panels, undo undoes both naturally. The cost is typing latency: every `setContent` (per-keystroke, per-debounce, etc.) waits for parseReferences to complete inside the writeTransaction.

Today's app already runs parseReferences fire-and-forget. Users expect (and apparently don't notice) the brief stale window. Going same-tx would *upgrade* atomicity in exchange for adding latency to a hot path — the wrong trade.

Follow-up keeps the existing UX, removes typing latency entirely, and avoids the engine-side overlay machinery that same-tx required.

### 7.2 Mapping today's behaviors

| Current behavior | New shape |
|---|---|
| Trigger on content change | `postCommitProcessorsFacet.of({ name: 'core.parseReferences', watches: ['setContent', 'create', 'splitBlock', 'mergeBlocks'], mode: 'follow-up' })`. Engine debounces invocations per-block (default 100ms) so a typing burst on one block resolves to a single processor run. |
| Parse refs | Inside `apply`, call `parseRefs(content)` helper. |
| Resolve aliases | Plain query against committed state — `tx.get` for known ids, kernel `aliasLookup` query for alias-by-name. The processor runs *after* the user's tx commits, so committed-state queries are correct. |
| Create missing alias-target | `tx.run(createAliasTarget, { alias, workspaceId })` inside the processor's own tx. |
| Daily-note deterministic id | `createAliasTarget` computes `daily/<workspaceId>/<date>` for date-shaped aliases. Two clients creating concurrently → same id; `tx.create` is idempotent on conflict (existing row wins). |
| Update `references` field | `tx.update(sourceId, { references: resolvedIds }, { skipMetadata: true })`. `skipMetadata` prevents the bookkeeping write from bumping `updated_at`/`updated_by`. The processor's tx uses `scope: ChangeScope.References` so it doesn't enter the document undo stack. |
| Self-destruct (newly-created alias-target dropped if not retained within ~4s) | `parseReferences` schedules `tx.afterCommit('core.cleanupOrphanAliases', { createdIds: [...] }, { delayMs: 4000 })`. Cleanup processor checks each id: if no block's `references_json` contains it, delete. |
| `skipUndo` (today) | Replaced by the processor's tx using `scope: ChangeScope.References` (separate undo stack — invisible to document undo). |
| `skipMetadataUpdate` (today) | Replaced by `tx.update(..., { skipMetadata: true })`. |

### 7.3 Undo interaction

Because parseReferences is follow-up with `scope: References`:
- User does `setContent` → undo entry recorded in document scope.
- parseReferences fires after commit, updates refs in References scope (its own undo stack, but in practice we don't expose References undo to users).
- User hits undo → setContent reverts → parseReferences fires again on the reverted content → refs converge to the pre-edit state.

This matches today's behavior. No "two undos to revert one edit" UX issue.

### 7.4 Test coverage required

- `setContent` with `[[foo]]` (alias not yet existing) → after debounce, alias-target exists; source block's `references` includes it.
- `[[2026-04-28]]` produces deterministic daily-note id; two simultaneous creates resolve to the same row.
- Typing `[[foo]]` then deleting that text within 4s → orphan removed by cleanup.
- Typing `[[foo]]`, then linking from another block within 4s → orphan kept (referenced).
- Rapid typing inside an existing `[[alias]]` (no alias-set change) → debounce coalesces; at most one processor run per block per debounce window.
- Undo of `setContent` → `references` converges back to pre-edit state.

---

## 8. Repo / FacetRuntime lifecycle

Bootstrap cycle today: `Repo` constructed in `RepoProvider`; `AppRuntimeProvider` builds FacetRuntime; some extensions are loaded via Repo. Resolution:

1. **`Repo.constructor`** initializes with **kernel registries only** (built-ins hard-coded into the constructor's import list). No FacetRuntime needed.
2. **`AppRuntimeProvider`** builds the FacetRuntime, calls **`repo.setFacetRuntime(runtime)`**. Repo merges contributions into its registries. Idempotent under multiple calls.
3. **`repo.tx`** snapshots registries at tx start; mid-tx runtime changes don't affect that tx.
4. **Removed dynamic processors don't fire on already-running follow-up txs** — follow-up processors execute against the snapshot from when they were scheduled.

```ts
class Repo {
  private registries: Registries = buildKernelRegistries()

  setFacetRuntime(runtime: FacetRuntime): void {
    const fromFacets = readDataFacets(runtime)
    this.registries = mergeRegistries(buildKernelRegistries(), fromFacets)
    this.notifyRegistryListeners()                            // for handles tracking facet-defined queries
  }

  async tx<R>(fn, opts?): Promise<R> {
    const snapshot = this.registries
    return runTxWithSnapshot(snapshot, fn, opts)
  }
}
```

---

## 9. Reactivity & invalidation

### 9.1 Per-handle subscription

`Handle<T>` keeps `value`, `listeners`, `dependencies`. Registered with `HandleStore`'s invalidation index on first load. On tx commit, `TxEngine` walks affected dependencies and re-runs handles synchronously.

### 9.2 What "affected" means

1. **Row-level**: a row in `blocks` changed. Handles whose dependencies include that row id re-run.
2. **Mutator-level**: `invalidatedBy: { kind: 'mutators', names: […] }` re-runs only when those commit.
3. **Table-level**: catch-all coarse invalidation.

Kernel handles declare row-level deps during `resolve` (the resolver knows which row ids it touched). Plugin queries opt into row-level if they want it.

### 9.3 Invalidation source

The TxEngine drives invalidation directly from the staged write-set on commit success. `row_events` is the audit / cross-process source-of-truth log; in-process invalidation does **not** wait on `row_events`.

For multi-process invalidation (cross-tab) — out of scope; see §16.7.

### 9.4 Structural diffing

`lodash.isEqual` default. `useHandle(handle, { eq })` for custom comparators.

### 9.5 React integration

```ts
useHandle<T>(handle, options?: { selector?, eq? }): T
```

Bespoke hooks (`useBlockData`, `useSubtree`, etc.) are 1-line sugar; primitive is `useHandle`.

---

## 10. Transaction commit pipeline

```
┌──────────────────────────────────────────────────────────────┐
│  pre-tx: engine preloads opts.reads (and mutator.reads)      │
│ ─────────────────────────────────────────────────────────── │
│ db.writeTransaction(async (txDb) => {                        │
│   1. UPDATE tx_context SET tx_id, user_id, scope, source     │
│   2. construct Tx (staged write-set; reads via cache + txDb) │
│   3. user fn(tx) runs:                                       │
│        tx.create/update/delete/setProperty/run/...           │
│        reads: staged → cache → txDb                          │
│   4. run same-tx post-commit processors against staged calls │
│        (none in v1 — parseReferences is follow-up;           │
│         hook exists for future processors that need atomicity)│
│   5. engine auto-bumps metadata fields on writes that didn't │
│        opt out via skipMetadata; codecs already applied for  │
│        any tx.setProperty calls                              │
│   6. flush staged writes to blocks (txDb)                    │
│        triggers fire: row_events rows, upload routing        │
│   7. INSERT command_event row (txDb)                         │
│   8. UPDATE tx_context SET source = NULL                     │
│ })   // PowerSync COMMIT or ROLLBACK                         │
│                                                              │
│ on success:                                                  │
│   9. hydrate cache from staged writes (encoded shape)        │
│   10. walk affected handles, structural-diff, fire           │
│   11. record undo entry from staged before/after snapshots   │
│   12. resolve repo.tx promise with user fn's return value    │
│   13. dispatch tx.afterCommit jobs (own writeTransactions)   │
│        and watch-matched follow-up processors                │
└──────────────────────────────────────────────────────────────┘
```

Steps 1–7 are atomic. 8–11 happen synchronously after COMMIT, before `repo.tx` resolves to caller. 12 is fire-and-after.

If 3 or 4 throws → rollback. Cache untouched, no command_event, no row_events, no undo entry. `repo.tx` rejects with the error.

If 5 or 6 throws (DB-level) → rollback, same.

### 10.1 `repo.mutate.X` is a 1-mutator tx

```ts
await repo.mutate.indent({ id })
// ≡
await repo.tx(async tx => tx.run(indentMutator, { id }), {
  description: indentMutator.describe?.({ id }),
  scope: indentMutator.scope,                                 // taken from the mutator def
})
```

### 10.2 Scope unification within a tx

A tx has one `scope`. Mixing scopes inside `tx.run` is rejected at the engine level (sub-mutator's scope must equal the tx scope). This keeps undo / upload semantics coherent.

For UI-state mutations interleaved with document mutations, callers issue separate `repo.tx` calls.

### 10.3 Read-only mode

`repo.tx` rejects with `ReadOnlyError` for any document-scope tx when `repo.isReadOnly`. UI-state txs always allowed.

---

## 11. Tree operations — push to SQL

### 11.1 Subtree

```sql
WITH RECURSIVE subtree AS (
  SELECT *, '' AS path
  FROM blocks
  WHERE id = :rootId AND deleted = 0
  UNION ALL
  SELECT child.*, subtree.path || '/' || child.order_key || ':' || child.id
  FROM subtree
  JOIN blocks AS child ON child.parent_id = subtree.id
  WHERE child.deleted = 0
)
SELECT * FROM subtree ORDER BY path;
```

Path includes `id` after `order_key` to make the sort deterministic on order_key collisions.

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
SELECT * FROM chain WHERE id != :id;
```

Returned in chain order (leaf to root) by virtue of the recursion order.

### 11.3 isDescendantOf

```sql
WITH RECURSIVE chain AS (
  SELECT id, parent_id FROM blocks WHERE id = :id
  UNION ALL
  SELECT b.id, b.parent_id FROM blocks AS b JOIN chain ON chain.parent_id = b.id
)
SELECT 1 FROM chain WHERE id = :potentialAncestor LIMIT 1;
```

### 11.4 Children of one parent

```sql
SELECT * FROM blocks
WHERE parent_id = :id AND deleted = 0
ORDER BY order_key, id;
```

### 11.5 JS-side helpers gone

`block.parents()`, `block.isDescendantOf()`, `getRootBlock()`: replaced by `repo.query.ancestors({ id })` (handle) or `await tx.parentOf(id)` walks within a tx.

`visitBlocks`: load subtree once, walk in memory.

---

## 12. Plugin extension model

### 12.1 Static plugins (compile-time)

```ts
// schema.ts
import { codecs } from '@/data/api'
import { TaskDueDateEditor } from './editors'

export const dueDateProp = defineProperty('tasks:due-date', {
  codec: codecs.date,                              // bidirectional Codec<Date>, NOT a zod schema
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  kind: 'date',                                    // default editor: ISO date input
  label: 'Due date',
  category: 'Tasks',
  Editor: TaskDueDateEditor,                       // optional: custom calendar picker overrides default
})

// mutators.ts
export const setDueDate = defineMutator({
  name: 'tasks:setDueDate',
  argsSchema: z.object({ id: z.string(), date: z.date() }),     // zod is for arg validation
  scope: ChangeScope.BlockDefault,
  apply: async (tx, { id, date }) => {
    // tx.setProperty applies the codec; the engine writes the encoded value
    // into properties_json. tx.update with raw properties bypasses the codec.
    tx.setProperty(id, dueDateProp, date)
  }
})

// index.ts
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

Caller (typed):

```ts
await repo.mutate['tasks:setDueDate']({ id, date })
```

### 12.2 Dynamic plugins (runtime-loaded)

```js
const setBookmark = defineMutator({
  name: 'bookmarks:set',
  argsSchema: z.object({ id: z.string(), url: z.string().url() }),
  scope: ChangeScope.BlockDefault,
  apply: async (tx, { id, url }) => { /* ... */ }
})

contribute(mutatorsFacet, setBookmark)
```

Calls go through the runtime registry:

```ts
await repo.run('bookmarks:set', { id, url: 'https://...' })
```

`repo.run` validates args at call time and returns `Promise<unknown>`. Optional `.d.ts` companion can augment `MutatorRegistry` for typed calls.

### 12.3 Trust model

Static plugins are in the TS module graph and code-reviewed. Dynamic plugins run with kernel authority. Args validate at the boundary for both. Sandboxing is out of scope.

---

## 13. Migration phases

Each phase ships independently; build stays green between them. **No back-compat shims** at any phase boundary.

### Phase 1 — Schema + Tx engine + tree-API rewrite (the big one)

This phase is the clean break. It absorbs everything that's incoherent to land separately.

**Scope**:
- New SQL DDL: `blocks` (with `parent_id + order_key`), `tx_context` (one-row), `row_events`, `command_events`. Drop existing tables.
- Triggers: `row_events` insert on `blocks` change; upload-routing trigger preserving today's behavior, rewired to read `tx_context.source`.
- Sync-apply wrapper that sets `tx_context.source = 'sync'` before PowerSync's CRUD apply runs; clears after.
- Postgres mirror schema. PowerSync sync-config rewrite.
- New `repo.tx(fn, opts)` on `db.writeTransaction`. Async `tx.get`. `tx.peek`, `tx.create`, `tx.update`, `tx.delete`, `tx.run`, `tx.childrenOf`, `tx.parentOf`, `tx.afterCommit`. No `tx.query`.
- `BlockData` type updated: no `childIds` field.
- `Block` facade: `block.childIds` is a sync getter computed from cache (sibling lookup); `block.children` returns sync `Block` array; `block.parent` sync.
- Properties stored flat: `properties_json` is `Record<string, unknown>`. Property descriptors live as plain `xxxProp` exports for now (facet wrapping in Phase 3).
- Tree mutations rewritten as kernel functions on `repo` (not on `Block`): `repo.indent(id)`, `repo.outdent(id, opts)`, `repo.move(id, opts)`, `repo.delete(id)`, `repo.createChild(parentId, opts)`, `repo.split(id, at)`, `repo.merge(a, b)`, `repo.insertChildren(parentId, items)`. Each runs inside `repo.tx` and uses `parent_id + order_key` patches.
- `block.change(callback)` is **deleted**, not wrapped. Call sites that mutated content/properties via callbacks migrate to `block.update({ content })` / `block.set(prop, v)` (which dispatch a 1-block tx) or to the dedicated kernel functions for tree ops.
- `applyBlockChange`, `_change`, `_transaction`, `getProperty`/`setProperty` (record-shape), `dataSync`, `requireSnapshot`-style throws — all deleted.
- `getProperty`/`setProperty` replaced by `block.get(schema)`/`block.set(schema, v)` operating on the new flat shape.
- Reference parsing remains as today's inline behavior — it still exists, still runs after content changes, but it now runs inside `repo.tx` (synchronously triggered by setContent), not as a fire-and-forget. Move to a proper post-commit processor in Phase 3.
- All call sites updated. (This is mechanical and broad: every shortcut handler, every renderer, every selector touching `block.data.childIds`, `block.data.properties[name].value`, or `block.change(...)`.)
- `repoInstance.ts` deleted; access via `RepoContext` only.

**Why this phase is large**: with no back-compat, the schema reset and the tree-API rewrite cannot land separately. Either the storage shape changes and we keep the old API (impossible without `child_ids_json`), or we change both at once. Property storage flatness is in the same situation. The phase is large but mechanical.

**Acceptance**:
- App boots from empty DB.
- All tests pass after fixture migration to new shapes.
- Multi-block ops wrap one `writeTransaction`. Crash mid-tx leaves no partial state.
- Sibling concurrent inserts both persist; ordering is deterministic post-sync (via `(order_key, id)` tiebreak).
- UI-state writes set `source='local-ephemeral'` and don't enter the upload queue.
- Sync-applied writes set `source='sync'` and don't loop through the upload trigger.
- `block.change`, `dataSync`, `applyBlockChange`, callback-mutation API: all gone.

### Phase 2 — Sync `Block` + Handles + React migration

**Scope**:
- `HandleStore` with identity-stable lookup and ref-count GC.
- `repo.block(id)`, `repo.subtree(id)`, `repo.ancestors(id)`, `repo.backlinks(id)` return handles.
- `useHandle(handle)` uses `useSyncExternalStore` + Suspense.
- `useBlockData`, `useSubtree`, `useChildren`, `useBacklinks`, `useParents` rewrite as 1-line sugar.
- `useDataWithSelector` deleted; `useHandle(handle, { selector })`.
- All `await block.data()`-style sites become `await repo.load(id)` + sync access.
- React component migration: Suspense boundaries placed where loading-states live.

**Acceptance**:
- No `await block.data()` calls remain.
- `useBacklinks`, `useParents` etc. no longer use ad-hoc `useEffect` reload.
- `Handle<BlockData | null>` distinguishes loading vs. not-found via `status()`.

### Phase 3 — Named mutators + post-commit processors as facets

**Scope**:
- `mutatorsFacet`, `postCommitProcessorsFacet` defined per §6.
- Repo lifecycle (`setFacetRuntime`) implemented per §8.
- Kernel mutators registered (names finalize during phase): `setContent`, `setProperty`, `indent`, `outdent`, `move`, `split`, `merge`, `delete`, `insertChildren`, `createChild`, `createSiblingAbove`, `createSiblingBelow`, `setOrderKey`, `createAliasTarget`. The `repo.indent(id)` etc. kernel functions from Phase 1 become `repo.mutate.indent({ id })` (sugar over a 1-mutator tx).
- Reference parsing migrated to `core.parseReferences` (mode `'same-tx'`) per §7. Includes the alias prefetch logic, the deterministic daily-note id, the `tx.afterCommit('core.cleanupOrphanAliases', …)` scheduling.
- `repo.mutate.X` accessor surface (typed via module augmentation) and `repo.run('name', args)` (runtime-validated, dynamic).
- `propertySchemasFacet` for descriptors (still flat in storage; facet just wraps the existing descriptor exports).
- ChangeScope type-augmentation hook for plugin scopes.

**Acceptance**:
- Reference parsing produces identical results to today across all behaviors per §7.2.
- A new plugin can register a mutator and call site invokes via `repo.mutate['plugin:foo']({...})` typed.
- `repo.setFacetRuntime` snapshot semantics hold.

### Phase 4 — Queries facet

**Scope**:
- `queriesFacet` defined.
- Kernel queries migrated: `subtree`, `ancestors`, `backlinks`, `byType`, `searchByContent`, `firstChildByContent`, `aliasesInWorkspace`, `aliasMatches`, `firstRootBlock`, `aliasLookup`.
- `repo.query.X(args)` accessor surface (typed via module augmentation) and `repo.runQuery('name', args)`.

**Acceptance**:
- Plugin can register a query and call site invokes via `useHandle(repo.query['plugin:foo'](args))` typed.

### Phase 5 — SQL tree helpers (CTE migration)

**Scope**:
- `ANCESTORS_SQL`, `IS_DESCENDANT_OF_SQL`, updated `SUBTREE_SQL` per §11.
- Kernel queries `subtree`, `ancestors`, `isDescendantOf` rewritten to use these CTEs.
- `visitBlocks` rewritten: load subtree, walk in memory.
- `getRootBlock` rewritten as `await repo.query.ancestors({id}).load()` + last element.

**Acceptance**:
- No `await block.parent()` in a loop.
- Subtree benchmark: 1000 blocks 5 levels deep = 1 SQL query.

---

## 14. Tests

For each phase:

- **Phase 1**: row CRUD via new schema; trigger writes correct `row_events`; concurrent sibling inserts both persist; UI-state writes don't upload; sync-applied writes don't re-route; `tx.get` falls through to SQL when not cached; mid-tx throw rolls back; multi-block writes are atomic; `tx.afterCommit` jobs run after commit and do not run on rollback.
- **Phase 2**: `block.data` throws `BlockNotLoadedError` when not loaded; `repo.load` populates; Suspense-driven render in a React test; `Handle<BlockData | null>` distinguishes loading vs. not-found.
- **Phase 3**: registering a mutator from a contribution makes it callable; duplicate names log warning + last-wins; runtime args validation rejects invalid args; **reference parsing**: full coverage per §7.4 (eventual-consistency model — assertions wait for the debounce + processor run before checking `references_json`); daily-note determinism under concurrent creation; orphan cleanup with and without retention.
- **Phase 4**: identity stability across calls; GC after subscribers detach; structural diffing prevents spurious notifications.
- **Phase 5**: ancestors/subtree/isDescendantOf return correct results with deterministic order on order_key collisions.

A `src/data/test/factories.ts` provides `createTestRepo({ user?, initialBlocks?, plugins? })`. Comes in Phase 1.

---

## 15. Invariants worth nailing

1. **Read-only mode**: `repo.tx` rejects document-scope txs when `repo.isReadOnly`. UI-state txs always allowed.
2. **Scope is per-tx, not per-call**: every mutator call within a tx must share the tx's scope. Mixing throws.
3. **UI-state isolation**: UI-state txs set `tx_context.source='local-ephemeral'`; upload trigger excludes; not in undo stack.
4. **Sync-applied writes**: bypass `repo.tx`; have `tx_context.source='sync'`; produce row_events with `tx_id=NULL`; don't trigger upload-routing.
5. **Order_key determinism**: `ORDER BY order_key, id` everywhere children are listed. Order_key collisions are possible (concurrent inserts at same position) and resolve via `id` tiebreak.
6. **Codecs at boundaries only**: descriptor `codec.encode`/`codec.decode` runs only at `block.set` / `block.get` / `tx.setProperty` / `tx.getProperty`. Storage and cache always hold encoded shape. `tx.update(..., { properties: ... })` bypasses codecs and is opt-in.
7. **Metadata auto-bump**: engine sets `updated_at` / `updated_by` on writes by default. Same-tx processors and other bookkeeping writes opt out via `{ skipMetadata: true }`.
8. **Tx snapshot**: `repo.tx` runs against the registry snapshot taken at tx start. Mid-tx facet-runtime changes don't affect the running tx.
9. **Tx queries are limited**: only `tx.get`, `tx.peek`, `tx.childrenOf`, `tx.parentOf`. Arbitrary cross-row reads happen out-of-tx (caller awaits a query handle, then passes results via args). Engine merges staged + SQL for the four primitives above.
10. **Same-tx processors are deterministic**: writes are atomic with the user's tx. No time, randomness, or external IO. (None ship in v1; the hook is reserved.)
11. **`tx.afterCommit` doesn't run on rollback**: scheduled jobs only fire if the parent tx commits.
12. **`block.data` is sync after load**: after `repo.tx` resolves, any `block.data` read sees the post-tx state — the cache update happens before the promise resolves.
13. **No `block.data.childIds`**: `BlockData` matches the row shape; `childIds` is computed on `Block` from the cache. Storage source-of-truth is `parent_id + order_key`.
14. **Reference parsing is eventually consistent**: `references_json` lags content by the parseReferences debounce window (~100ms typical). Code that reads backlinks accepts this.

---

## 16. Open questions / decide during implementation

### 16.1 zod vs Effect Schema

Default to **zod**. Decide at Phase 1 start (used immediately by mutator argsSchema).

### 16.2 Same-tx vs follow-up default

Default new processors to `'follow-up'` — including `core.parseReferences` (decided; see §7.1 — keeps typing fast and matches today's UX). Same-tx is opt-in for cases that genuinely need atomicity. v1 ships zero same-tx processors; the hook exists for future use.

### 16.3 Plugin-owned entity tables

Out of scope for v1. Plugins use properties.

### 16.4 Checkpoints for undo coalescing

Defer.

### 16.5 Signals vs `useSyncExternalStore`

`useHandle` uses `useSyncExternalStore`. Signals deferred.

### 16.6 Events-derived undo

Defer; `row_events.before_json` enables it later.

### 16.7 Cross-tab invalidation

Out of scope. Today's `enableMultiTabs=false, useWebWorker=false` is preserved. Multi-tab is a separate work item.

### 16.8 Server-side audit log

`row_events` and `command_events` are local-only initially. Sync-up via PowerSync is a follow-up.

### 16.9 Order-key rebalancing

Defer until keys actually grow.

### 16.10 Aliases storage

Today's properties include an `aliases` list; the alias-lookup query reads it. The new model keeps this. Defer separate `block_aliases` table unless JSON-extract is too slow.

### 16.11 `tx.get` fallthrough cost

Every cache miss inside a mutator does a SQL read inside the writeTransaction. For deep mutators reading dozens of blocks, this can be slow. Mitigations: `mutator.reads(args)` preload hints; engine batches preload reads into a single SQL query before `apply` runs. Implement preload in Phase 1; profile when complex mutators land.

### 16.12 Order-key generation choice

`fractional-indexing-jittered` vs. plain `fractional-indexing` + `id` tiebreak. **Decision criterion**: pick whichever is cheaper to implement. Both are correct; jittered reduces secondary-tiebreak frequency at no cost to determinism. Default to **jittered** unless the library is too heavy.

---

## 17. Out of scope

- Replacing PowerSync.
- Adopting TanStack DB / Replicache / Zero / LiveStore wholesale.
- CRDTs beyond row-LWW + jittered fractional indexing.
- Differential dataflow / IVM.
- Cross-tab invalidation (see §16.7).
- Server-side audit log.
- Sandboxing dynamic plugins.
- Migration of existing user data (alpha; data is droppable).
- Full event sourcing (rows stay authoritative).
- Plugin-owned entity tables.
- Back-compat shims of any kind.

---

## 18. References

### Existing code (current state)
- `src/data/block.ts` — `Block` class (transformed in Phase 1).
- `src/data/repo.ts` — `Repo` class (re-shaped Phase 1, then refined).
- `src/data/repoInstance.ts` — module singleton (deleted in Phase 1).
- `src/data/blockStorage.ts` — write queue / writeLock (replaced by `writeTransaction` in Phase 1).
- `src/data/blockQueries.ts` — SQL templates (rewritten Phase 1; CTEs upgraded Phase 5).
- `src/data/blockSchema.ts` — `BlockRow` / `BlockData` shapes (rewritten Phase 1; `childIds` removed).
- `src/data/blockCache.ts` — in-memory cache (kept; integrates with handles in Phase 2).
- `src/data/undoRedo.ts` — kept; entries become 1-per-tx in Phase 1.
- `src/data/properties.ts` — flat in storage from Phase 1; descriptor-as-facet in Phase 3.
- `src/extensions/facet.ts` — `defineFacet`, `FacetRuntime` (kernel; reused).
- `src/extensions/core.ts` — existing facets (sibling to new data-layer facets).
- `src/hooks/block.ts` — replaced Phase 2.
- `src/context/repo.tsx` — `RepoProvider` (kept; lifecycle simplified Phase 1).

### External design references
- LiveStore — past-tense events, sync queries, signals reactivity. https://docs.livestore.dev/
- Replicache — named mutators, server-replay-rebase, in-tx read constraints. https://doc.replicache.dev/
- Zero (Rocicorp) — relational query API + IVM. https://zero.rocicorp.dev/
- TanStack DB w/ PowerSync — closest layerable alternative; declined.
- TinyBase — Checkpoints undo (deferred).
- PowerSync `writeTransaction` docs — https://docs.powersync.com/
- `fractional-indexing-jittered` — https://github.com/rocicorp/fractional-indexing-jittered

---

## 19. Acceptance for the spec itself

- [ ] Reviewer's P0 findings (round 2) addressed: `tx_context` is a regular table not TEMP (§4.2); `tx.query` removed in favor of bounded primitives with explicit overlay (§5.3); Phase 1 acknowledges full break (no `block.change` survival, no `childIds` in `BlockData`, properties flat, tree API rewrite all in Phase 1) (§13.1); order_key uses jittered + `(id)` tiebreak (§4.1, §11, §15).
- [ ] Reviewer's P1 findings (round 2) addressed: upload trigger preservation with `source` gating (§4.5); property shape consistent — flat from Phase 1 (§13.1); `tx.afterCommit` for processor scheduling (§5.3, §5.7, §7); `Mutator.scope` field (§5.4).
- [ ] Reviewer's round-3 findings addressed: parseReferences is follow-up (typing latency concern resolved by matching today's UX, §7.1); no PowerSync sync-apply wrapper required (`source = NULL` ↔ sync, §4.2/§4.5); separate INSERT/UPDATE/DELETE triggers (§4.5); `TxWriteOpts.skipMetadata` typed on `tx.create`/`tx.update`/`tx.setProperty` (§5.3); `tx.setProperty`/`tx.getProperty` keep codecs at the boundary (§5.3, §5.6); `Codec<T>` is a real bidirectional codec, not a zod schema (§5.6).
- [ ] Each phase ships with a green build and meets acceptance criteria.
- [ ] §16.1, §16.12 must resolve before Phase 1 starts.
- [ ] Dynamic-plugin lifecycle is constructible at runtime (§8, §12.2).
