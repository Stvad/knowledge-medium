# Task: Data layer redesign — handles + tx + facet-contributed mutators/queries

Owner role: architect (this doc) → implementer subagents (per phase)
Type: architectural rewrite (multi-phase). Includes a **schema reset** — existing data is wiped on upgrade. We're in alpha; no back-compat shims.
Estimated scope: large. Touches `src/data/**`, `src/hooks/block.ts`, `src/extensions/{facet,core}.ts`, every shortcut handler, every component that reads block data. ~50+ files. Plus a SQLite schema reset + PowerSync sync-config update.

> **Design notes worth keeping near the top.** Granular per-round history lives in git (`git log tasks/data-layer-redesign.md`). What's listed below is the load-bearing rationale and the simplification trajectory — things easy to undo by accident, or temptations a future reader needs the why for.
>
> **Architecture decisions:**
> - **Schema reset; no back-compat.** Existing data drops on upgrade (alpha). New Supabase project; server schema is just `blocks`; `tx_context` / `row_events` / `command_events` and the seven triggers (5 audit/upload + 2 workspace-invariant) are client-only. Service-role key never reaches the browser (`.env` carries only `VITE_*` keys; tracked-file `git grep` guard).
> - **`parseReferences` is a follow-up post-commit processor, not same-tx.** Same-tx would add typing latency to a hot path; today's app already accepts the brief stale-backlinks window. Don't "upgrade" to atomic — it's the wrong trade.
> - **No PowerSync sync-apply wrapper.** Sync writes leave `tx_context.source = NULL`; the COALESCE-to-`'sync'` and `= 'user'` upload-gate pair handles tagging without one. Don't try to hook PowerSync's CRUD-apply path.
> - **Bidirectional `Codec<T>` separate from zod.** Properties need encode + decode; zod is unidirectional. Codec runs at exactly four boundary call sites; storage and cache hold encoded shape.
> - **Cycle prevention is two layers + a detection log** (§4.7): local validation in move mutators, depth-100 CTE guards in every recursive query, plus a row_events-tail scan that logs sync-introduced cycles for telemetry. **No automatic repair** — alpha cut, revisit if the log fires in practice.
> - **Workspace invariant enforced server-side** via composite FK `(workspace_id, parent_id) → blocks (workspace_id, id)` (§4.1.1). Tree queries can rely on it; no per-query workspace filter needed. Cross-workspace edges can't sync in.
> - **Bootstrap is staged** (§8). Stage 1 registers kernel + static contributions synchronously at `AppRuntimeProvider` mount; Stage 2 registers dynamic plugins after the discovery query resolves. The Stage 0 → Stage 1 window is one React render.
> - **In-tx reads are limited** to `tx.get` / `tx.peek` / `tx.childrenOf` / `tx.parentOf`. No arbitrary `tx.query`. Broader information passes via mutator args (loaded outside the tx) or post-commit processors. Same constraint Replicache and Zero accept.
>
> **Recent simplification trajectory** (read as guard-rails — multiple rounds led to these and re-adding them is a regression):
> - **v4.20: four dead-code drops.** `mode: 'same-tx'` processors removed (zero v1 callers; the hypothetical use case was rejected in v4.4 anyway). `watches.kind: 'mutator'` removed (field-watching is the correctness path; mutator-name watches miss plugin mutators that bypass the named one). `tx.create({...}, { onConflict: 'ignore' })` replaced by `tx.createOrGet(data) → { id, inserted: boolean }`. `ChangeScopeRegistry` removed (plugin scopes were behaving as `BlockDefault` anyway).
> - **v4.21: write-through Tx primitives.** No staged write-set; no flush step. Each `tx.create` / `tx.update` / `tx.delete` / `tx.setProperty` runs INSERT/UPDATE inline against SQL; engine captures `(before, after)` per id in a tx-private snapshots map for handle diffing / undo. Reads inside a tx see own writes natively (`tx.get` via writeTransaction; `tx.peek` via snapshots-then-cache fallback). Made possible by v4.20 dropping the two consumers of pre-flush state (same-tx processors, createOrGet's reconciliation hook). **The shared cache is updated on commit walk only — see v4.24 below; do NOT re-add inline cache writes during the tx.**
> - **v4.23: drop deterministic cycle repair entirely.** The old Layer 2 (post-sync deterministic repair via `repairTreeInvariants` + lex-smallest-loser) is removed. The protocol becomes: Layer 1 (local move-mutator validation) + Layer 2 (depth-100 CTE guards, formerly Layer 3) + a row_events-tail detection scan that logs cycles for telemetry. **`ChangeScope.Repair`, `repo.repairTreeInvariants`, `repo.canWrite`, the `repairCycle` kernel mutator, and the per-workspace repair gating prose are all gone.** Rationale: cycles are a narrow concurrent-write window; alpha population is small; the two remaining layers keep queries finite under any cyclic state; revisit auto-repair only if the detection log fires. **Don't re-add this without telemetry showing it's needed** — v4.12 → v4.18 chased per-workspace repair plumbing through several round-trips before v4.23 cut the whole branch.
> - **v4.24: reviewer-found correctness fixes.** Seven changes, all addressing real bugs the spec previously hand-waved:
>   1. **`tx.createOrGet` restores soft-deleted rows** in-place (§5.3, §10.4). Previously `[[foo]]` typed → cleaned-up → re-typed would resolve to a hidden tombstone; now it un-soft-deletes via `ON CONFLICT DO UPDATE … WHERE blocks.deleted = 1` and returns `inserted: true`. The "restore = inserted:true" semantic keeps §7's cleanup-eligibility filter correct.
>   2. **Cache update deferred to commit walk** (§5.3, §10). SQL is still write-through inside `db.writeTransaction`; the shared cache is no longer mutated mid-tx. `tx.peek` reads snapshots-then-cache; outside-tx readers see only committed state. Closes the dirty-read window. v4.21's "no staged write-set" intent stands — write-through is just to SQL, the cache update is batched into the commit walk that fires handles.
>   3. **Engine-side cycle validation** on every parent_id-changing write (§4.7 Layer 1). `tx.update` and the restore branch of `tx.createOrGet` now go through the same `isDescendantOf` check that kernel move mutators previously did themselves; bypassing via plugin or direct `repo.tx` body is no longer possible.
>   4. **CTE visited-id guards** via path INSTR (§11.1/.2/.3). Cycles produce cleanly-truncated, dedup'd results — no UNION-ALL duplicate explosion at depth 100.
>   5. **Trigger count corrected to 7** (§4.5, §13.1): 5 audit/upload + 2 workspace-invariant.
>   6. **Local trigger drops "not soft-deleted"** (§4.1.1) — aligns with the server-side composite FK. Mutator-level validation still throws `ParentDeletedError` for fresh local writes (UX layer).
>   7. **Single-workspace per tx** invariant (§5.3, §15 #11). Engine pins `meta.workspaceId` from the first write and throws `WorkspaceMismatchError` on mismatched subsequent writes.
>
>   Plus: **Phase 5 collapsed** (§13) — tree CTEs land in Phase 1 since the engine needs them for cycle validation and tree mutations from day one. **Stale prose swept**: "before staging the write" → "before issuing the write"; `mode: 'follow-up'` dropped from the §7 example (only one mode since v4.20); round-6/-7/-8/-9 acceptance bullets collapsed to prevent accidental resurrection of deleted design.
>
> **Resolved open questions:**
> - **zod** for argsSchema (v4.10). Bundle weight + React-ecosystem familiarity beat Effect Schema; bidirectional encode/decode handled separately by `Codec<T>`. Valibot is a near-mechanical fallback if bundle pressure shows up later.
> - **`fractional-indexing-jittered`** for order keys (v4.10). Reduces collision probability between distinct clients; `(order_key, id)` secondary sort handles residuals.
> - **No checkpoints / undo coalescing in v1** (§16.4). Today's CodeMirror coarse-grained writes mean per-tx undo is fine. Add when per-keystroke writes route through `repo.tx`.

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
2. **Single write primitive: `repo.tx`.** All mutations go through transactional sessions backed by PowerSync's `writeTransaction`. One DB tx, one undo entry, one command-event row, one cache-update batch on commit walk — all per `repo.tx` call.
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
│   repo.children(id)     → Handle<BlockData[]>               │
│   repo.subtree(id)      → Handle<BlockData[]>               │
│   repo.ancestors(id)    → Handle<BlockData[]>               │
│   repo.backlinks(id)    → Handle<BlockData[]>               │
│   repo.query.X(args)    → Handle<Result>                    │
│   repo.load(id, opts?)  → Promise<BlockData | null>         │
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
│   write-through to SQL: each tx primitive runs its INSERT/  │
│     UPDATE immediately; engine captures (before, after) per │
│     id in a tx-private snapshots map. Cache is NOT mutated  │
│     here — outside-tx readers see only committed state.     │
│   tx.peek = snapshots → cache (tx-private fallback).        │
│   tx.get  = SQL via txDb (read-your-own-writes).            │
│   row_events written by triggers (read tx_context)          │
│   trigger forwards to powersync_crud unless source=sync|ephem│
│   write command_events row                                  │
│ on success: walk snapshots, update cache to `after`, diff   │
│              handles, fire, undo entry; then dispatch       │
│              tx.afterCommit + field-watch follow-up         │
│              processors                                     │
│ on throw: db.writeTransaction rollback; snapshots map is    │
│           discarded (cache was never mutated, nothing to     │
│           revert)                                            │
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

Schema lives in two places: **Postgres (server, synced)** and **local SQLite (client, bootstrapped at app startup)**. Each has different concerns:

- Postgres holds only the synced row-shaped data. `blocks` is the only synced table.
- Local SQLite holds the synced `blocks` (managed by PowerSync) plus client-only auxiliary tables: `tx_context`, `row_events`, `command_events`. None of these are synced — they're the local mechanism for tx context, audit, and invalidation.
- Triggers (row_events writes, upload routing into `powersync_crud`) live on the **client only** — Postgres has no `powersync_crud` and no need for these triggers.

Existing tables are dropped and recreated on both sides.

### 4.1 `blocks` (server + client)

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
- Two clients move *different* blocks concurrently in a way that creates a cycle → can survive sync because each move is a separate row update under LWW. **Cycle prevention has its own protocol** — see §4.7.
- Clients on the same actor running fractional-indexing-jittered produce distinct keys for sequential inserts; collisions are strictly cross-actor concurrent inserts at the same spot.

A periodic rebalance pass (defer; §16.9) can rewrite keys when they grow too long, but is not required for correctness.

**Workspace invariant**: a block's parent (if any) must be in the same workspace. Otherwise tree queries crossing `parent_id` would silently leak rows from one workspace into another's subtree, and per-workspace permission decisions (upload routing, RLS) become ambiguous.

```sql
-- enforced both client-side (SQLite) and server-side (Postgres):
-- INVARIANT: parent_id IS NULL
--         OR (SELECT workspace_id FROM blocks WHERE id = parent_id) = workspace_id
```

SQLite enforcement (per-statement triggers, since SQLite CHECK constraints can't reference other rows):

```sql
CREATE TRIGGER blocks_parent_workspace_check_insert
BEFORE INSERT ON blocks
WHEN NEW.parent_id IS NOT NULL
  AND (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL    -- LOCAL writes only
BEGIN
  SELECT RAISE(ABORT, 'parent must exist and share workspace_id')
  WHERE NOT EXISTS (
    SELECT 1 FROM blocks
    WHERE id = NEW.parent_id
      AND workspace_id = NEW.workspace_id
  );
END;

CREATE TRIGGER blocks_parent_workspace_check_update
BEFORE UPDATE OF parent_id, workspace_id ON blocks
WHEN NEW.parent_id IS NOT NULL
  AND (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL    -- LOCAL writes only
BEGIN
  SELECT RAISE(ABORT, 'parent must exist and share workspace_id')
  WHERE NOT EXISTS (
    SELECT 1 FROM blocks
    WHERE id = NEW.parent_id
      AND workspace_id = NEW.workspace_id
  );
END;
```

The `NOT EXISTS` predicate catches two failure modes in one check: dangling parent (id pointing to nothing) and cross-workspace parent. **It does NOT filter on `deleted = 0`** — the local trigger and the server-side composite FK both accept soft-deleted parents (v4.24 alignment). The previous version (v4.17) used `(SELECT workspace_id ...) IS NOT NULL AND != NEW.workspace_id`, which silently accepted dangling parents — the predicate evaluated to NULL and didn't ABORT. The `NOT EXISTS` form catches both.

**Soft-deleted parents are accepted at the storage layer.** Tree queries filter `deleted = 0` so a child whose parent is soft-deleted is unreachable in tree views (its subtree doesn't render under the deleted parent), but the row exists. This is intentional: if a parent gets soft-deleted *after* its children exist, retroactively rejecting them would be worse than orphaning them. Mutator-level validation (next paragraph) prevents users from creating *new* children under a soft-deleted parent — that's the user-experience layer; the storage layer accepts what sync brings in.

**Why client/server alignment matters here**: pre-v4.24, the local trigger had `AND deleted = 0` while the server FK didn't, so a server-accepted child whose parent had been soft-deleted (race: client A creates child while client B soft-deletes parent; both writes survive sync) would land locally — bypassing the local trigger via the `source IS NOT NULL` gate — and disagree with what fresh local writes were allowed. Dropping the local rule keeps local and remote state-acceptance consistent; the user-experience rule lives in mutator-level validation only.

**The `source IS NOT NULL` gate is load-bearing**: sync-applied writes leave `tx_context.source = NULL` (no `repo.tx` is open during PowerSync's CRUD apply, per §4.2). Without the gate, the local trigger would abort sync-applied cross-workspace edges before row_events could record them, leaving PowerSync stuck retrying valid syncs. With the gate, sync writes land locally as the server already validated them (see Postgres enforcement below).

**Server-side (Postgres) — canonical enforcement via composite FK.** The cleanest declarative shape:

```sql
CREATE TABLE blocks (
  id            TEXT NOT NULL PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  parent_id     TEXT,
  ...
  UNIQUE (workspace_id, id),                                  -- enables composite FK reference
  FOREIGN KEY (workspace_id, parent_id) REFERENCES blocks (workspace_id, id) DEFERRABLE
);
```

The composite FK guarantees both that `parent_id` exists *and* that the parent shares `workspace_id` — `parent_id IS NULL` satisfies the FK trivially. This is the load-bearing guarantee: a malicious or buggy client cannot produce cross-workspace edges that survive sync. Soft-delete (parent's `deleted = 1`) is allowed by the FK *and by the local trigger* (v4.24 alignment); the "don't create new children under a soft-deleted parent" rule lives in mutator-level validation only — better error messages there, and the storage layer doesn't care.

**Mutator-level validation** is the better-error-message layer: `move`, `indent`, `outdent`, `createChild`, `insertChildren`, etc. validate the workspace/existence invariant client-side before issuing the write and throw `WorkspaceMismatchError` / `ParentNotFoundError`. They additionally reject *new* children under a soft-deleted parent (`ParentDeletedError`) — a user-experience rule, not a storage rule (the storage layer accepts soft-deleted parents per v4.24 alignment; see SQLite enforcement above). The local trigger is the workspace/existence safety net. (Cycle validation lives in the engine per §4.7 Layer 1, so mutators don't repeat it.)

**No sync-time workspace repair.** v4.17 had the row_events tail detecting cross-workspace edges and demoting them via a repair pattern. With the server-side composite FK, cross-workspace edges cannot survive sync — they're rejected at the server boundary. The depth-100 CTE guards (§4.7 Layer 2) keep queries finite if this assumption ever breaks (e.g. a server-side migration drops the FK accidentally), but the recovery path is "fix the server constraint," not "client-side repair."

Tree queries in §11 do not need a workspace predicate when the invariant holds — `parent_id` chains stay within one workspace by construction. The queries filter by `deleted = 0`; adding a `workspace_id = ?` filter would be harmless but redundant.

`properties_json` is `Record<string, unknown>` — just the value, codec-deserialized at read time via the descriptor (§5.6).

### 4.1.1 `BlockData` (TS domain shape) — public, camelCase

The SQL columns above are the **storage shape** (snake_case). The **public TypeScript shape** is camelCase and is what every API in this spec exposes — `tx.update`, handle results, mutator args, post-commit processor `changedRows`, undo snapshots, all of it.

```ts
export interface BlockReference {
  /** Resolved target block id. */
  id: string
  /** Original alias text from the source content (e.g. the body of `[[Inbox]]`).
   *  Preserved so wikilink rendering can show the alias text the user typed,
   *  which may differ from the target block's current name/aliases. */
  alias: string
}

export interface BlockData {
  id: string
  workspaceId: string
  parentId: string | null
  orderKey: string
  content: string
  properties: Record<string, unknown>           // codec-encoded values; not "properties_json"
  references: BlockReference[]                  // {id, alias} pairs; not "references_json"
  createdAt: number
  updatedAt: number
  createdBy: string
  updatedBy: string
  deleted: boolean                              // hydrated from 0/1
}

/** Allowed patch shape for tx.update — excludes:
 *  - immutable fields (id, workspaceId)
 *  - engine-managed metadata (createdAt, createdBy, updatedAt, updatedBy)
 *  - deleted (lifecycle goes through tx.delete; restore is not a v1 primitive)
 *
 *  The undo machinery does NOT use tx.update / BlockDataPatch — it has its
 *  own engine-internal applier that writes raw rows from before/after
 *  snapshots, so excluding `deleted` from the user-facing patch type doesn't
 *  prevent undo from restoring a soft-deleted block. */
export type BlockDataPatch = Partial<Omit<
  BlockData,
  'id' | 'workspaceId' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy' | 'deleted'
>>

/** Allowed shape for tx.create.
 *  - id: optional. If omitted, the engine generates a UUID. If present,
 *    used verbatim — used by deterministic-id mutators like
 *    core.createAliasTarget for daily notes.
 *  - workspaceId: required (a row's workspace is fixed at creation).
 *  - parentId, orderKey: required (every row has a tree position).
 *  - content / properties / references: optional with defaults
 *    ('', {}, [] respectively).
 *  - createdAt, createdBy, updatedAt, updatedBy: NOT accepted —
 *    engine sets all four from tx_context at the write site (just
 *    before issuing the INSERT). Passing them is a compile error.
 *  - deleted: NOT accepted — newly-created blocks default to false;
 *    soft-delete goes through tx.delete, not tx.create. */
export type NewBlockData = {
  id?: string
  workspaceId: string
  parentId: string | null
  orderKey: string
  content?: string
  properties?: Record<string, unknown>
  references?: BlockReference[]
}
```

**Storage ↔ domain mapping** lives in two functions in `src/data/blockSchema.ts`:
- `parseBlockRow(row: BlockRow): BlockData` — snake_case + JSON strings → camelCase + parsed JSON.
- `blockToRow(data: BlockData): BlockRow` — the inverse.

The mapping is the only place either shape leaks into the other. Triggers, raw SQL, and PowerSync's CRUD apply use the storage shape (snake_case). Mutators, queries, processors, handles, and React all use the domain shape (camelCase). Examples throughout this spec use the domain shape — `tx.update(id, { parentId: null })`, not `{ parent_id: null }`; `tx.update(id, { references: ids })`, not `{ references_json: '[...]' }`.

This boundary is identical to today's `BlockRow` / `BlockData` split; the redesign keeps it.

### 4.2 `tx_context` (client only)

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

### 4.3 `row_events` (client only)

```sql
CREATE TABLE row_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id           TEXT,                                     -- NULL for sync-applied
  block_id        TEXT NOT NULL,
  kind            TEXT NOT NULL,                            -- 'create' | 'update' | 'soft-delete' | 'delete'
  before_json     TEXT,
  after_json      TEXT,
  source          TEXT NOT NULL,                            -- COALESCE(tx_context.source, 'sync')
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_row_events_tx ON row_events(tx_id);
CREATE INDEX idx_row_events_block ON row_events(block_id, created_at DESC);
CREATE INDEX idx_row_events_created ON row_events(created_at DESC);
```

Written by SQLite triggers on `blocks` (one per insert/update/delete). Triggers pull `tx_id` and `source` from `tx_context`. **Belt-and-suspenders for the sync case**: triggers compute `tx_id` as `CASE WHEN ctx.source IS NULL THEN NULL ELSE ctx.tx_id END` so a sync-applied write always emits `tx_id = NULL`, regardless of any stale tx_id left in `tx_context` from the previous local tx. The TxEngine clears all four fields at end-of-tx (§10), but the trigger logic is the load-bearing correctness check.

**Soft-delete semantics**: `tx.delete(id)` sets `deleted = 1` (an UPDATE), so it fires the UPDATE trigger, not the DELETE trigger. To distinguish soft-deletes from regular updates, the UPDATE trigger inspects whether the `deleted` column transitioned from 0 to 1 and writes `kind = 'soft-delete'` instead of `'update'`. Consumers (handles, devtools, the cycle detector) treat soft-delete as a logical removal.

The DELETE trigger is reserved for **hard purges** — physically removing rows from the local DB. v1 ships no purge mechanism; the trigger exists for future use (e.g., a cleanup job that purges soft-deleted rows older than N days). Hard deletes do not sync to other clients (PowerSync sees the row vanish locally, but soft-delete via the synced `deleted` column is what propagates "this row is gone" through sync).

### 4.4 `command_events` (client only)

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

### 4.5 Upload routing triggers (client only)

Two upload-routing triggers in v1: one for INSERT, one for UPDATE. SQLite doesn't allow combined-event triggers, and DELETE is intentionally absent (see end of section).

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

-- v1: NO upload-routing trigger for DELETE. Hard-delete (physical removal) is
-- not a v1 operation and would require a separate purge-semantics decision —
-- see §4.3 row_events. Soft-deletes go through tx.delete → UPDATE deleted = 1
-- → fires the UPDATE trigger above, which forwards correctly.
-- A future hard-purge mechanism can add this trigger when its sync policy
-- (sync hard-deletes vs. local-only purge) is decided.
```

`row_events` writers are a **separate set of three triggers** (INSERT/UPDATE/DELETE), each appending a row to `row_events` with `COALESCE((SELECT source FROM tx_context WHERE id = 1), 'sync')`. The DELETE row_events writer exists for audit (recording any future hard-purge) — it does not forward to `powersync_crud`.

Total v1 trigger count on `blocks`: **7** = 5 audit/upload (3 row_events writers + 2 upload-routing) + 2 workspace-invariant (BEFORE INSERT and BEFORE UPDATE OF parent_id, workspace_id; defined in §4.1.1). The audit/upload triggers are AFTER, gate on `tx_context.source`, and run for both local and sync writes (the sync case COALESCEs to 'sync'). The workspace-invariant triggers are BEFORE, gate on `source IS NOT NULL` (local writes only), and serve as the safety net for the §4.1.1 client-side rule.

### 4.6 PowerSync sync-config

`sync-config.yaml` is updated to:
- Sync `blocks` with the new shape.
- Not sync `tx_context`, `row_events`, `command_events` (local-only initially; see §16.8).

### 4.7 Cycle prevention

`parent_id + order_key` with row-LWW under sync admits parent cycles in the worst case. Example: client A moves X under Y; client B concurrently moves Y under X. Each is a single-row update; both survive sync; the resulting tree has `X.parent_id = Y` and `Y.parent_id = X` — a cycle. The recursive CTEs in §11 would recurse until SQLite's depth limit and either error or return garbage if unguarded.

Two layers of defense + one observability hook:

**Layer 1 — Engine-side validation on every parent_id write.** The TxEngine intercepts any primitive that sets `parent_id` on an *existing* row (i.e. `tx.update(id, patch)` or `tx.createOrGet(...)` whose `WHERE blocks.deleted = 1` restore branch fires) and runs a single `isDescendantOf` query (§11.3) before issuing the SQL: would the new parent be a descendant of `id`? If yes, throw `CycleError` and abort the primitive (the writeTransaction will roll back when the user fn propagates the throw, or callers can `try`/`catch` and continue).

Why engine-side, not mutator-side: kernel mutators (`move`, `indent`, `outdent`) could enforce this themselves, but `tx.update(id, { parentId })` is callable directly from any plugin mutator or `repo.tx` body. Putting the check in the engine localizes the rule to one place, guarantees no caller can bypass it, and matches v4.23's "no per-caller workspace plumbing" simplification ethos. Cost: one `isDescendantOf` query per parent_id-changing write (a single recursive CTE bounded by depth-100), which is what kernel move mutators were already doing — the relocation is uniform, not additional.

`tx.create` doesn't need this check: a brand-new id has no descendants, so the proposed parent is trivially not a descendant of it. Same for the fresh-insert branch of `tx.createOrGet`. Only writes against pre-existing rows (`tx.update`, the restore branch of `tx.createOrGet`) carry the check.

**Layer 2 — CTE guards (depth + visited-id).** Every recursive CTE in §11 (subtree, ancestors, isDescendantOf) carries two guards: a `depth < 100` defensive cap, and a visited-id check via path-INSTR (§11.1) that skips any row whose id already appears in the recursion path-so-far. Even if a sync-applied cycle slips through Layer 1, the visited-id guard truncates the cyclic subtree at the cycle entry — each block appears at most once in the result, no UNION-ALL duplicate explosion — and the depth guard is the additional safety net for any pathological non-cycle deep tree (a 200-level deep, non-cyclic tree gets capped, but that's an extreme corner case). This is what gives the UI a clean, finite result it can render with a "cycle here" marker against the truncation point.

**Detection-only telemetry.** When the row_events tail (§9.3) sees sync-applied writes that changed `parent_id`, the engine runs a bounded scan scoped to the affected ids:

```sql
WITH RECURSIVE chain(start_id, id, parent_id, depth) AS (
  SELECT id, id, parent_id, 0 FROM blocks WHERE id IN (:affected_ids) AND deleted = 0
  UNION ALL
  SELECT chain.start_id, b.id, b.parent_id, chain.depth + 1
  FROM chain JOIN blocks b ON b.id = chain.parent_id
  WHERE b.deleted = 0 AND chain.depth < 100        -- defensive
)
SELECT DISTINCT start_id, MIN(depth) AS cycle_depth
FROM chain
WHERE depth > 0 AND id = start_id
GROUP BY start_id;
```

Each result row gives `(start_id, cycle_depth)`. When the result set is non-empty, the engine emits a single warning log (`console.warn` + a `repo.events.cycleDetected` event with `{ startIds, workspaceId, txIdsInvolved }`) so the team finds out *that* a cycle happened in the wild. **No automatic repair.** The cycle stays in the data; queries truncate at depth 100; one of the cycle members has to be moved by a user (any move that breaks the loop works) or by manual operator intervention before the affected subtree renders in full.

This is a deliberate alpha cut. Cycles only arise from concurrent moves on overlapping subtrees by writable peers in the same workspace — a narrow window in a small alpha population. Layers 1 + 2 keep the local view *correct* (just visually capped) under any cyclic state syncs in. The detection log gives us the data to revisit deterministic auto-repair (lex-smallest-loser, per-workspace-canWrite-gating) in a later round if it becomes a real problem; until then, none of that machinery exists in the engine, on `Repo`, or in the type system.

Operational runbook on a logged cycle: identify the cycle members from the log payload, decide which edge to break (typically the most recent move), and have the relevant user perform a move that takes one of the members out of the loop. The depth-100 truncation means the cyclic subtree is reachable for inspection — every member appears in some other tree query at depth ≤ 100 — so the UI can still show the operator what to act on.

This is roughly the pattern Linear / Roam / Logseq use for hierarchical data under last-writer-wins sync, minus the auto-repair step we're not yet adding.

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

  /** Sync relatives. Require that the relevant set has been preloaded:
   *  - childIds / children: requires `repo.load(id, { children: true })` previously
   *    succeeded for this id (cache marks "all children loaded" on completion).
   *    Throws ChildrenNotLoadedError if the marker isn't set. The cache CANNOT
   *    distinguish "no children" from "children not loaded" by sibling-scanning
   *    alone — a parent with zero loaded children might be a leaf, or might
   *    just have unloaded children. The marker is the only honest signal.
   *  - parent: requires the parent row to be in cache (preloaded via
   *    `repo.load(id, { ancestors: true })` or natural neighborhood loads).
   *  Components that need reactive children should use useHandle(repo.children(id))
   *  instead — that's a Handle<BlockData[]> with first-class load + subscribe. */
  readonly childIds: string[]                                // ordered by (order_key, id)
  readonly children: Block[]
  readonly parent: Block | null

  subscribe(listener: (data: BlockData | null) => void): Unsubscribe

  /** Single-block write sugar — each is a 1-mutator tx.
   *  These exist because `await block.set(prop, value)` reads dramatically better
   *  than `await repo.mutate.setProperty({ id: block.id, schema: prop, value })`
   *  at the call sites where we'd write it most. They are NOT a parallel API;
   *  each method is a thin wrapper around the corresponding kernel mutator,
   *  and the same write goes through the same tx pipeline. */
  set<T>(schema: PropertySchema<T>, value: T): Promise<void>     // → setProperty mutator
  setContent(content: string): Promise<void>                     // → setContent mutator
  delete(): Promise<void>                                        // → delete mutator
}
```

`Block` is a thin facade. `childIds` is **derived from the cache** (other blocks with `parent_id = this.id`), not stored on `BlockData`. `BlockData` matches the row shape — no `childIds` field.

**Cache loaded-range markers.** The cache tracks per-parent metadata: `{ allChildrenLoaded: boolean }`. `repo.load(id, { children: true })` runs the children SQL, hydrates each child into the cache, and sets the marker for the parent on completion. `repo.subtree(rootId)`'s loader sets the marker for every visited parent. PowerSync sync-applied inserts of new children clear the marker for the affected parent (the row_events tail in §9.3 detects parent_id assignments and clears the corresponding marker). Children handles re-resolve naturally on the same invalidation.

The full `repo.load` signature:

```ts
repo.load(id: string, opts?: {
  children?: boolean        // load id's immediate children; sets allChildrenLoaded marker
  ancestors?: boolean       // load id's full parent chain
  descendants?: number      // load N levels of descendants (recursive CTE)
}): Promise<BlockData | null>
```

`repo.load(id)` with no opts loads just the row itself. The opts are flags telling the loader which neighborhoods to populate alongside.

The facade's sync `childIds` getter checks the marker; if unset, throws `ChildrenNotLoadedError(id)`. This is the only honest contract — the cache cannot distinguish a leaf from "I haven't asked yet." Reactive children access goes through `useHandle(repo.children(id))` instead of the facade.

The single-block sugar above (`set`, `setContent`, `delete`) is the only mutating surface on `Block`. Composite operations across multiple blocks (indent, outdent, move, split, merge) are not on `Block` — call them via `repo.mutate.indent({ id: block.id })` or `repo.tx`. Rationale: those operations need broader context (UI state for outdent's `topLevel`, etc.) that doesn't fit cleanly on a per-block facade.

### 5.3 `Tx` (transactional session, async reads, no arbitrary queries)

```ts
export interface Tx {
  /** Read with read-your-own-writes. The Tx runs inside `db.writeTransaction`,
   *  so SQL sees writes already issued by this tx natively — no staged-write
   *  overlay. Returns null if the row doesn't exist. */
  get(id: string): Promise<BlockData | null>

  /** Sync read. Reads the **tx-private snapshots map first** (own writes
   *  in this tx), then falls back to the shared cache. Returns null if the
   *  row isn't in either. Use `get` for the source-of-truth read.
   *
   *  **Cache is NOT updated mid-tx** (v4.24): the shared cache is updated
   *  on commit walk only, so outside-tx readers (other components, imperative
   *  `block.peek` calls in unrelated code paths) never observe in-flight tx
   *  state that may roll back. Within-tx reads see own writes via the
   *  snapshots-first lookup; SQL reads via `tx.get` see them natively
   *  (read-your-own-writes inside the writeTransaction). */
  peek(id: string): BlockData | null

  /** Low-level primitives. Each runs its INSERT / UPDATE immediately within
   *  the active writeTransaction (write-through to SQL); the engine captures
   *  (before, after) per id in a tx-private snapshots map. Triggers fire per
   *  primitive call (row_events written, upload routing decided), not in a
   *  flush batch.
   *
   *  **Cache update is deferred to commit walk** (v4.24): the snapshots map
   *  is the single source of "what this tx wrote." On commit, the engine walks
   *  snapshots, updates cache entries, and fires handles in one synchronous
   *  pass. On rollback, the snapshots map is discarded and cache stays at its
   *  pre-tx state. This preserves v4.21's "no staged write-set" intent for
   *  SQL while keeping cache consistent with committed state only. */
  create(data: NewBlockData, opts?: TxWriteOpts): string     // throws DuplicateIdError on PK conflict
  /** Insert OR produce a live row at the deterministic id, with explicit
   *  insertion status. Required for deterministic-id callers
   *  (createAliasTargetInline; daily notes).
   *
   *  - id is REQUIRED on the input — without an id, conflict semantics are undefined.
   *  - **No row exists** → INSERT runs; returns `{ id, inserted: true }`; engine
   *    captures (null, after).
   *  - **Row exists, `deleted = 0`** → SELECTs the live row inside the same
   *    writeTransaction, returns `{ id, inserted: false }`; engine captures no
   *    snapshot for this id (the row didn't change). Subsequent `tx.get(id)`
   *    reads the live row from SQL.
   *  - **Row exists, `deleted = 1`** (soft-deleted) → UPDATEs the row in place:
   *    sets `deleted = 0` and overwrites the input fields with the new values
   *    (semantically: "the page is back; treat it like a fresh creation"),
   *    returns `{ id, inserted: true }`. Engine captures (before-row, after-row)
   *    in the snapshots map. **`inserted: true` is honest here** — from the
   *    user's POV a live row at this id was produced by this tx, which is exactly
   *    what the cleanup-eligibility filter in §7 needs. (See §10.4 for the
   *    discriminating SQL.)
   *
   *  Why restore-on-conflict (not "return inserted:false even when un-soft-deleted"):
   *  the deterministic-id contract is "two clients writing the same id converge to
   *  the same live row." If client A typed `[[foo]]`, deleted it (soft-delete via
   *  cleanup), then later types `[[foo]]` again, the user's intent on the second
   *  type is "create [[foo]]" — they don't know about the soft-deleted tombstone
   *  and shouldn't see the alias resolve to a hidden row. Restoring is the only
   *  behavior that makes typing `[[foo]]` after a delete work correctly. */
  createOrGet(data: NewBlockData & { id: string }, opts?: TxWriteOpts): Promise<{ id: string; inserted: boolean }>
  update(id: string, patch: BlockDataPatch, opts?: TxWriteOpts): void
  delete(id: string): void                                   // soft delete (sets deleted=1; fires UPDATE triggers — see §4.5 row_events kind)

  /** Typed property primitives — the only path that runs codecs.
   *  setProperty: codec.encode applied; engine merges into the row's `properties`
   *    map and writes through immediately.
   *  getProperty: codec.decode applied to the value read from SQL/cache.
   *  Direct properties manipulation via tx.update(id, { properties: ... }) writes raw
   *  encoded values and bypasses codecs — reserved for cases where the caller is
   *  intentionally working at the encoded-JSON level. */
  setProperty<T>(id: string, schema: PropertySchema<T>, value: T, opts?: TxWriteOpts): void
  getProperty<T>(id: string, schema: PropertySchema<T>): Promise<T | undefined>

  /** Compose another mutator. Sub-mutator's writes go through immediately; the
   *  parent's subsequent reads see them via SQL (read-your-own-writes inside
   *  the writeTransaction). No overlay arithmetic. */
  run<Args, R>(mutator: Mutator<Args, R>, args: Args): Promise<R>

  /** Within-tx tree primitives. Plain SQL against the writeTransaction; sees
   *  writes already issued by this tx. */
  childrenOf(parentId: string): Promise<BlockData[]>          // ordered by (order_key, id)
  parentOf(childId: string): Promise<BlockData | null>

  /** Schedule a follow-up post-commit job. Runs in its own writeTransaction
   *  after this tx commits. Does NOT run if the tx rolls back.
   *
   *  Args are typed via the `PostCommitProcessorRegistry` (augmented per
   *  processor like `MutatorRegistry` is for mutators). Statically-known
   *  processors get full type inference; unknown names (e.g. dynamic-plugin
   *  processors not yet in the registry) get `args: unknown` and rely on
   *  runtime `scheduledArgsSchema.parse()` validation at enqueue time. */
  afterCommit<P extends string>(
    processorName: P,
    args: ScheduledArgsFor<P>,
    options?: { delayMs?: number },
  ): void

  /** Tx metadata. `workspaceId` is derived from the first write in the tx
   *  and validated against every subsequent write — see the single-workspace
   *  invariant below. */
  readonly meta: { description?: string; scope: ChangeScope; user: User; txId: string; source: TxSource; workspaceId: string | null }
}

/** Single-workspace invariant (v4.24): every write inside a single `repo.tx`
 *  must target the same workspace_id.
 *
 *  - The engine reads workspace_id from the first write's row (for tx.update,
 *    tx.delete, tx.setProperty: read from SQL; for tx.create / tx.createOrGet:
 *    use the input data.workspaceId). It pins this as `meta.workspaceId` for
 *    the rest of the tx and records it in `command_events.workspace_id` and
 *    `CommittedEvent.workspaceId`.
 *  - Every subsequent primitive validates that its target row's workspace_id
 *    matches `meta.workspaceId`. Mismatch throws `WorkspaceMismatchError` and
 *    aborts the primitive (the writeTransaction rolls back when the user fn
 *    propagates the throw).
 *  - A tx with zero writes leaves `meta.workspaceId = null`; this is fine
 *    because such a tx produces no row_events / command_events rows that
 *    need the workspaceId disambiguated.
 *
 *  Why enforce: command_events, CommittedEvent, and processor alias-lookup
 *  all carry one workspace_id. Cross-workspace writes inside a single tx
 *  would make those fields ambiguous (which workspace's audit row? which
 *  processor's workspace-bound query?). v1 has zero kernel mutators that
 *  span workspaces; the constraint is free here. Plugins that legitimately
 *  need cross-workspace effect should issue separate `repo.tx` calls. */

/** Source is derived from scope alone — callers never pass it:
 *  - BlockDefault / References → 'user' (uploads)
 *  - UiState                   → 'local-ephemeral' (no upload)
 *  ('sync' is reserved for sync-applied writes that bypass repo.tx entirely;
 *  it is not assignable from anywhere in this API.) */

export interface RepoTxOptions {
  scope: ChangeScope
  description?: string
  reads?: { blockIds?: string[]; subtreeOf?: string }
}
```

```ts
interface TxWriteOpts {
  /** When true, engine does NOT auto-bump updated_at/updated_by (or created_at/created_by
   *  on tx.create). Used for bookkeeping writes whose state isn't user intent —
   *  e.g. parseReferences updating the `references` field. Default false.
   *  User-facing mutators should not set this. */
  skipMetadata?: boolean
}

type TxSource = 'user' | 'local-ephemeral'                   // sync writes bypass repo.tx; tx_context.source stays NULL for them, COALESCE'd to 'sync' in row_events
```

**No arbitrary `tx.query`.** Even with write-through making own-writes visible to SQL, queries are still kept off the Tx surface. Reasons: (a) `Query` handles maintain dynamic dependency declarations (§5.5) for invalidation, which only make sense for live handles outside a tx; running them inside a tx tangles their dep-graph with the tx's lifecycle. (b) Most query results are reactive views the caller already has via `useHandle` outside the tx; running them again inside is duplication. (c) Limiting in-tx reads to `tx.get` / `tx.peek` / `tx.childrenOf` / `tx.parentOf` keeps mutator code shaped around well-defined neighborhoods and makes preload hints (`mutator.reads`) meaningful.

If a mutator needs broader information (e.g., "all blocks of a type in this workspace"), it should:
- Call `await query.load()` *before* opening the tx (passing results in via args), or
- Call `tx.childrenOf` repeatedly to traverse a known structure, or
- For derived state, use a post-commit processor that reads the committed state.

This is the same constraint Replicache and Zero accept: in-tx reads stay on the row-and-immediate-relatives shape. Anything richer happens outside the tx.

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
- Read-only mode: `repo.tx` rejects unless every mutator in the tx has `UiState` scope. `BlockDefault` and `References` are both rejected.
- Different mutators in the same tx with different scopes are not allowed (engine throws); a tx is one scope.

### 5.5 `Query<Args, Result>`

```ts
export interface Query<Args, Result> {
  readonly name: string
  readonly argsSchema: Schema<Args>
  readonly resultSchema: Schema<Result>

  /** resolve runs the query and declares dependencies via ctx.depend(...).
   *  Dependencies are dynamic — gathered during execution from the rows the
   *  resolver actually touched — not declared statically up front. */
  readonly resolve: (args: Args, ctx: QueryCtx) => Promise<Result>

  /** Optional coarse pre-filter for the invalidation engine.
   *  If absent, the engine subscribes to all blocks/row_events changes
   *  for this handle. Set this to limit pre-filtering work; dynamic deps
   *  from resolve always take precedence for precision. */
  readonly coarseScope?: { tables?: string[]; mutators?: string[] }
}

interface QueryCtx {
  db: PowerSyncDatabase                                     // raw SQL escape hatch
  repo: Repo
  hydrateBlocks(rows: BlockRow[]): BlockData[]

  /** Declare a dependency. Call multiple times during resolve.
   *  Engine collects all deps and uses them to invalidate this handle. */
  depend(dep: Dependency): void
}

type Dependency =
  | { kind: 'row'; id: string }                              // exact row
  | { kind: 'parent-edge'; parentId: string }                // any row with parent_id = this
  | { kind: 'workspace'; workspaceId: string }               // any row in this workspace
  | { kind: 'table'; table: string }                         // catch-all coarse
```

Queries are out-of-tx. Built-in queries (`subtree`, `ancestors`, `backlinks`, `searchByContent`, `byType`, `firstChildByContent`, `firstRootBlock`, `aliasesInWorkspace`, `aliasMatches`, `aliasLookup`, `children`) are kernel facet contributions and call `ctx.depend` appropriately. Plugin queries do the same; without dep declarations a query's handle effectively never invalidates (table-coarse fallback handles this safely but inefficiently).

**Universal rule for resolvers**: declare deps for "things this query is asked about" **before** running the SQL. If the query result is empty (e.g., the requested id doesn't exist yet), only the upfront deps remain — and those need to cover the case where the missing thing is later created. After the SQL, fine-grained deps for visited rows / parent edges add precision.

Example dep declarations:

```ts
// repo.block(id):
resolve: async ({ id }, ctx) => {
  ctx.depend({ kind: 'row', id })
  return ctx.hydrateBlocks(await ctx.db.getAll('SELECT * FROM blocks WHERE id = ?', [id]))[0] ?? null
}

// repo.children(id):
resolve: async ({ id }, ctx) => {
  ctx.depend({ kind: 'parent-edge', parentId: id })       // upfront — covers empty-result case
  return ctx.hydrateBlocks(await ctx.db.getAll(
    'SELECT * FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id', [id]
  ))
}

// repo.subtree(rootId):
resolve: async ({ rootId }, ctx) => {
  // Declare deps for "things this query asks about" BEFORE running, not after.
  // If rootId doesn't exist, the SQL returns empty and the for-loop below adds
  // nothing — without these upfront deps, the handle would never invalidate
  // when rootId is later created.
  ctx.depend({ kind: 'row', id: rootId })
  ctx.depend({ kind: 'parent-edge', parentId: rootId })

  const rows = await ctx.db.getAll(SUBTREE_SQL, [rootId])
  for (const row of rows) {
    ctx.depend({ kind: 'row', id: row.id })
    ctx.depend({ kind: 'parent-edge', parentId: row.id })   // any new child invalidates
  }
  return ctx.hydrateBlocks(rows)
}
```

### 5.6 `PropertySchema<T>` and `Codec<T>`

zod schemas validate but don't bidirectionally serialize (e.g. `z.coerce.date()` decodes ISO → Date but doesn't re-encode). Property storage needs both directions, so we ship a small `Codec` interface separate from zod (which we still use for mutator `argsSchema` validation):

```ts
export interface Codec<T> {
  encode(value: T): unknown                                  // → JSON-serializable
  decode(json: unknown): T                                   // ← from JSON-decoded; throws on mismatch
}

// Built-in helpers shipped from @/data/api:
export const codecs = {
  /** Built-in primitive codecs validate on decode (throw CodecError on shape mismatch).
   *  Cheap typeof checks — runtime cost is negligible, safety is real. */
  string: {
    encode: (v: string) => v,
    decode: (j: unknown) => {
      if (typeof j !== 'string') throw new CodecError('string', j)
      return j
    },
  } satisfies Codec<string>,
  number: {
    encode: (v: number) => v,
    decode: (j: unknown) => {
      if (typeof j !== 'number') throw new CodecError('number', j)
      return j
    },
  } satisfies Codec<number>,
  boolean: {
    encode: (v: boolean) => v,
    decode: (j: unknown) => {
      if (typeof j !== 'boolean') throw new CodecError('boolean', j)
      return j
    },
  } satisfies Codec<boolean>,
  date: {
    encode: (d: Date) => d.toISOString(),
    decode: (j: unknown) => {
      if (typeof j !== 'string') throw new CodecError('date', j)
      return new Date(j)
    },
  } satisfies Codec<Date>,

  /** Wraps a codec to allow undefined: stored as JSON null; decode passes null/missing through. */
  optional<T>(inner: Codec<T>): Codec<T | undefined> {
    return {
      encode: v => (v === undefined ? null : inner.encode(v)),
      decode: j => (j === null || j === undefined ? undefined : inner.decode(j)),
    }
  },

  /** Escape hatch — explicitly unsafe cast. Reserved for kernel-internal use where
   *  the JSON shape is guaranteed by construction. NOT a default for plugin authors. */
  unsafeIdentity: <T>(): Codec<T> => ({ encode: x => x, decode: x => x as T }),

  /** Compose for arbitrary structural shapes — author writes encode/decode by hand
   *  with field-level validation. Helper available but not enumerated here. */
}

export class CodecError extends Error {
  constructor(expected: string, got: unknown) {
    super(`expected ${expected}, got ${typeof got} (${JSON.stringify(got)?.slice(0, 80)})`)
  }
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
/** All processors run as follow-ups in their own writeTransaction, after the
 *  originating user tx commits. (v4.20 dropped the same-tx mode — see §16.2.)
 *
 *  Discriminated on watches.kind:
 *  - 'field':    fires when the originating tx wrote any of the named fields
 *                on `blocks`. The robust correctness path — catches every
 *                code path that touches the field, including plugin mutators
 *                that bypass a specific named mutator. scheduledArgs is undefined.
 *  - 'explicit': fires only when a previous tx called tx.afterCommit with this
 *                processor's name and supplied args. Used by chained processors
 *                (e.g. cleanupOrphanAliases scheduled by parseReferences).
 *                scheduledArgsSchema is REQUIRED (engine validates at enqueue).
 *
 *  v4.20 also dropped watches.kind: 'mutator' — the mutator-name match channel
 *  shipped zero v1 processors and the design itself argued for `field` whenever
 *  correctness matters. See §16.2. */
export type PostCommitProcessor<ScheduledArgs = unknown> = {
  name: string
  apply: (event: CommittedEvent<ScheduledArgs>, ctx: ProcessorCtx) => Promise<void>
} & ProcessorWatches<ScheduledArgs>

type ProcessorWatches<ScheduledArgs> =
  | { watches: { kind: 'field';    table: 'blocks'; fields: Array<keyof BlockData> }; scheduledArgsSchema?: never }
  | { watches: { kind: 'explicit' };                                                  scheduledArgsSchema:  Schema<ScheduledArgs> }   // REQUIRED

/** Plugin-augmentable type registry for processor scheduled args. Mirrors
 *  MutatorRegistry's role for mutators. Built-ins augment this for their own
 *  scheduled args (e.g. core.cleanupOrphanAliases below); plugins do the same. */
export interface PostCommitProcessorRegistry { /* augmented via declare module */ }

export type ScheduledArgsFor<P extends string> =
  P extends keyof PostCommitProcessorRegistry ? PostCommitProcessorRegistry[P] : unknown

// Built-in registration (kernel):
declare module '@/data/api' {
  interface PostCommitProcessorRegistry {
    'core.cleanupOrphanAliases': { newlyInsertedAliasTargetIds: string[] }
  }
}

interface CommittedEvent<ScheduledArgs = unknown> {
  txId: string                                                           // originating tx
  changedRows: Array<{ id: string; before: BlockData | null; after: BlockData | null }>  // populated for kind='field'
  user: User
  workspaceId: string
  scheduledArgs?: ScheduledArgs                                          // typed; populated for kind='explicit'
}

interface ProcessorCtx {
  /** The processor's own tx (its own writeTransaction). Writes commit when
   *  the processor's apply resolves. */
  tx: Tx

  /** Raw SQL for reads — sees committed state at processor-fire time
   *  (the originating user tx is already committed by definition). */
  db: PowerSyncDatabase

  /** For handle composition or invoking other mutators. */
  repo: Repo
}
```

**On `tx.afterCommit` arg validation**:

```ts
afterCommit<P extends string>(
  processorName: P,
  args: ScheduledArgsFor<P>,             // type narrowed by the registered processor
  options?: { delayMs?: number }
): void
```

The engine looks up the processor by name in the snapshot, applies its `scheduledArgsSchema.parse(args)`, and throws `CodecError` on mismatch. Validation runs **at enqueue time** so a buggy caller fails the originating tx (clean rollback) rather than failing silently later when the processor fires.

**Schema is required for `watches.kind: 'explicit'` processors** — enforced at the type level (`scheduledArgsSchema: Schema<ScheduledArgs>` is non-optional on that variant of the union). No kernel escape hatch; even built-ins must declare a schema. This closes the dynamic-plugin bypass that an "optional + comment-required" shape allowed.

For `kind: 'field'` processors, scheduledArgs is undefined (they fire on commit conditions, not on `tx.afterCommit` calls), so no schema applies. The discriminated union encodes this via `scheduledArgsSchema?: never` on that variant.

Two scheduling channels:
1. **Field-write match** (`watches: { kind: 'field', table, fields }`): processor fires when the tx wrote to any of the specified fields on the table — regardless of which mutator did the write. Args come from `event.changedRows`.
2. **Explicit schedule** (`tx.afterCommit(name, args, opts)`): processor fires after the tx commits with supplied args via `event.scheduledArgs`. Used by chained processors. The processor's `watches` is `{ kind: 'explicit' }`.

`core.parseReferences` uses field-watching: `{ kind: 'field', table: 'blocks', fields: ['content'] }`. A plugin mutator that does `tx.update(id, { content: '...' })` directly (without going through the kernel's `setContent` mutator) will still trigger reference parsing. This is correctness-critical: reference parsing must not be bypassable. Field-watching is the only mechanism that guarantees that property — which is why v4.20 dropped mutator-name watching as a redundant footgun (see §16.2).

### 5.8 `ChangeScope` (typed)

```ts
export const ChangeScope = {
  BlockDefault: 'block-default',           // user document edits; undoable; uploads
  UiState: 'local-ui',                     // selection/focus/etc; not undoable; never uploads
  References: 'block-default:references',  // ref-parsing bookkeeping; separate undo bucket; uploads
} as const

export type ChangeScope = (typeof ChangeScope)[keyof typeof ChangeScope]
```

**Plugin scopes** (v1): there is no plugin-extensible scope registry. Plugins use one of the three built-in scopes — pick the one whose engine semantics (undoable / uploads / read-only-allowed) match your need. If a plugin genuinely needs a custom scope (its own undo bucket separate from BlockDefault, or a different upload semantic), we'll add a metadata-shaped registry then; for v1, the registry was ceremonious for what it bought (plugin scopes inherited BlockDefault semantics anyway, so they were functionally identical to using BlockDefault directly).

Scope semantics matrix:

| Scope | Undoable? | Uploads? | Allowed in read-only? |
|---|---|---|---|
| `BlockDefault` | yes (user undo stack) | yes | no |
| `UiState` | no | no (`source = 'local-ephemeral'`) | yes |
| `References` | yes (separate ref bucket; not exposed to user undo) | yes | no |

---

## 6. Facets

```ts
mutatorsFacet            : Facet<Mutator,             MutatorRegistry>
queriesFacet             : Facet<Query,               QueryRegistry>
propertySchemasFacet     : Facet<PropertySchema,      PropertySchemaRegistry>
postCommitProcessorsFacet: Facet<PostCommitProcessor, PostCommitDispatcher>
```

Each facet's `combine` builds a registry keyed by `name`; duplicate names log a warning and last-wins.

The kernel registers built-ins as plain contributions. There is no two-tier system — `core.indent` and `tasks:setDueDate` are both contributions, both flow through `setFacetRuntime` (§8), neither is hardcoded in the Repo constructor.

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
| Trigger on content change | `postCommitProcessorsFacet.of({ name: 'core.parseReferences', watches: { kind: 'field', table: 'blocks', fields: ['content'] } })`. Field-watching is correctness-critical: any tx that writes `blocks.content` triggers ref parsing, including plugin mutators that bypass the `setContent` kernel mutator. Engine debounces invocations per-block (default 100ms) so a typing burst on one block resolves to a single processor run. (No `mode` field — v4.20 dropped same-tx mode, follow-up is the only behavior; see §16.2.) |
| Parse refs | Inside `apply`, call `parseRefs(content)` helper. |
| Resolve aliases | Plain query against committed state — `ctx.tx.get` for known ids; for alias-by-name lookup, raw SQL via `ctx.db.getAll(ALIAS_LOOKUP_SQL, [workspaceId, alias])` in Phase 3 (no queriesFacet yet), switching to `repo.query.aliasLookup({...}).load()` in Phase 4 (same SQL, queriesFacet wrapper). The processor runs *after* the user's tx commits, so committed-state queries are correct. |
| Create missing alias-target | Plain helper function `createAliasTargetInline(tx, alias, workspaceId): Promise<{ id: string; inserted: boolean }>` called inside the processor's apply. **NOT a registered Mutator** — registering it via `mutatorsFacet` would make it callable as `repo.mutate.createAliasTarget(...)` from any scope, bypassing the parseReferences flow. The helper computes the deterministic id, calls `tx.createOrGet({ id, ... })` (per §5.3), and returns both the id and whether *this* tx was the one that inserted. The `inserted` boolean drives cleanup eligibility (see Self-destruct row). |
| Daily-note deterministic id | `createAliasTargetInline` computes a deterministic id for date-shaped aliases (alphanumeric encoding — no `/` — so it doesn't conflict with §11.1's path encoding). Two clients creating concurrently → same id; `tx.createOrGet` ensures convergence: one client gets `inserted: true`, the other gets `inserted: false` and reads the existing live row from SQL. **Date alias targets are NEVER added to `newlyInsertedAliasTargetIds`** (see Self-destruct row) — daily notes persist regardless of whether a referencing block is removed within 4s. |
| Update `references` field | `tx.update(sourceId, { references: refs }, { skipMetadata: true })` where `refs: BlockReference[]` (each `{ id, alias }` from the parsed wikilinks). `skipMetadata` prevents the bookkeeping write from bumping `updatedAt` / `updatedBy`. The processor's tx uses `scope: ChangeScope.References` so it doesn't enter the document undo stack. |
| Self-destruct (NON-DATE alias-target dropped if not retained within ~4s AND inserted by this tx) | `parseReferences` schedules `tx.afterCommit('core.cleanupOrphanAliases', { newlyInsertedAliasTargetIds: [...] }, { delayMs: 4000 })`. **`newlyInsertedAliasTargetIds`** is built by filtering `createAliasTargetInline` results: include only ids where `inserted === true` AND the id is non-date-shaped. This is the literal honest meaning — `tx.createOrGet` returns `inserted` directly, so we know at parse time which ids this tx actually wrote vs which ones already existed. The cleanup processor (`watches.kind: 'explicit'`) declares `scheduledArgsSchema = z.object({ newlyInsertedAliasTargetIds: z.array(z.string()) })` so the engine validates at `tx.afterCommit` enqueue. Cleanup runs **one gate**: verify no block's `references` contains the id (a `ctx.db` query against `references_json`); skip if any does. When the gate passes, `ctx.tx.delete(id)` proceeds. (No row_events insertion check needed — the `inserted` boolean from `tx.createOrGet` already gave us that information at the call site, before we even scheduled cleanup.) |
| `skipUndo` (today) | Replaced by the processor's tx using `scope: ChangeScope.References` (separate undo stack — invisible to document undo). |
| `skipMetadataUpdate` (today) | Replaced by `tx.update(..., { skipMetadata: true })`. |

### 7.3 Undo interaction

Because parseReferences is follow-up with `scope: References`:
- User does `setContent` → undo entry recorded in document scope.
- parseReferences fires after commit, updates refs in References scope (its own undo stack, but in practice we don't expose References undo to users).
- User hits undo → setContent reverts → parseReferences fires again on the reverted content → refs converge to the pre-edit state.

This matches today's behavior. No "two undos to revert one edit" UX issue.

### 7.6 Daily-note exemption from cleanup

Today's app deliberately exempts date-shaped alias targets from the self-destruct mechanism: a daily note like `[[2026-04-28]]` persists even if the typing user removes the text within 4s. Rationale: daily notes are anchors users navigate to throughout the day; their existence is independent of any one referencing block. The redesign preserves this by **not adding date-shaped alias-target ids to `newlyInsertedAliasTargetIds`** in the first place — `parseReferences` checks each id returned by `createAliasTargetInline` against the daily-note format and excludes matches.

Implementation:

```ts
function isDateAliasTargetId(id: string): boolean {
  // matches the deterministic daily-note id format produced by createAliasTargetInline
  return /^daily-[a-z0-9]+-\d{4}-\d{2}-\d{2}$/.test(id)
}

// inside parseReferences:
//   - For every parsed alias not already resolved by aliasLookup, call
//     createAliasTargetInline(tx, alias, workspaceId) — a plain helper, NOT a
//     registered mutator (see §7 mapping). Helper internally does
//     tx.createOrGet({ id, ..., aliases: [alias] }) and returns
//     { id, inserted: boolean }.
//   - Build the cleanup candidates: non-date ids that THIS tx actually inserted.
const results = await Promise.all(
  unresolvedAliases.map(alias => createAliasTargetInline(tx, alias, workspaceId))
)
const newlyInsertedAliasTargetIds = results
  .filter(r => r.inserted && !isDateAliasTargetId(r.id))
  .map(r => r.id)
if (newlyInsertedAliasTargetIds.length > 0) {
  tx.afterCommit('core.cleanupOrphanAliases', { newlyInsertedAliasTargetIds }, { delayMs: 4000 })
}
```

Two filters: `inserted === true` (this tx wrote the row, not a pre-existing one) and `!isDateAliasTargetId` (skip daily notes). The combination of these two static conditions makes cleanup's job a single check ("any block references this id?") at fire time.

### 7.5 Why cleanup uses `inserted`, not "any block references it"

Consider this race:

1. Alice creates page "Inbox" via the create-page UI (NOT via `[[Inbox]]` typing). Alice's Inbox row has no incoming `references_json` entries from any block.
2. Sync propagates Alice's Inbox to Bob's local DB.
3. Bob types `[[Inbox]]` somewhere. parseReferences resolves the alias to Alice's existing Inbox via `tx.createOrGet({ id: ..., aliases: ['Inbox'], ... })`, which returns `{ id, inserted: false }` (row already existed).
4. parseReferences sees `inserted: false` for Inbox's id and **does not add it to `newlyInsertedAliasTargetIds`** — so cleanup never considers it.
5. Bob deletes the `[[Inbox]]` text within 4s. parseReferences re-runs, removing the reference from Bob's block.
6. Cleanup runs after 4s. Inbox's id was never on the cleanup list, so Alice's Inbox is safely preserved.

A naive design (cleanup removes any alias-target with no incoming references) would delete Alice's Inbox. The fix isn't a row_events gate — it's filtering at schedule time by the `inserted` boolean that `tx.createOrGet` returns directly. The "no references" check is the *only* runtime gate cleanup needs; the "did this tx insert?" question is answered statically at the `createOrGet` call site, before the cleanup is even scheduled.

(Pre-v4.20 designs queried `row_events` post-commit to recover insertion identity, because the earlier `tx.create({...}, { onConflict: 'ignore' })` primitive didn't return it. v4.20's `tx.createOrGet` makes the boolean a return value, eliminating the post-commit query.)

### 7.4 Test coverage required

- `setContent` with `[[foo]]` (alias not yet existing) → after debounce, alias-target exists; source block's `references` includes it.
- `[[2026-04-28]]` produces deterministic daily-note id; two simultaneous creates resolve to the same row.
- Typing `[[foo]]` (foo new, non-date) then deleting that text within 4s → orphan removed by cleanup. `tx.createOrGet` returned `inserted: true`; `newlyInsertedAliasTargetIds` includes foo's id; reference check passes (no block references it after deletion); cleanup deletes.
- Typing `[[foo]]` (foo new), then linking from another block within 4s → orphan kept. Same as above except the reference check fails.
- **Typing `[[Inbox]]` where Inbox already existed before this user typed it**, then deleting within 4s → existing Inbox is **kept**. `tx.createOrGet` returned `inserted: false`; Inbox's id is filtered out of `newlyInsertedAliasTargetIds` at schedule time; cleanup never considers it. §7.5 race; must not regress.
- **Typing `[[2026-04-28]]` (newly creates the daily note)**, then deleting within 4s → daily note is **kept** (date-shaped target excluded from `newlyInsertedAliasTargetIds` even though `inserted: true`). §7.6 daily-note exemption; must not regress.
- Two clients concurrently typing `[[2026-04-28]]` → deterministic daily-note id; both `tx.createOrGet` calls converge on the same row. One returns `inserted: true`, the other `inserted: false`; either way both clients' `references` arrays end up containing `{id, alias: '2026-04-28'}`.
- **Re-typing `[[foo]]` after a previous create-and-cleanup cycle** → restored row visible. Sequence: type `[[foo]]` (createOrGet returns `inserted: true`); delete the text within 4s (cleanup soft-deletes foo); ≥4s passes; type `[[foo]]` again. The second `createOrGet` matches the soft-deleted row's id, hits the restore path (`ON CONFLICT DO UPDATE … WHERE blocks.deleted = 1`), returns `inserted: true`, and the restored row's `deleted = 0`. Source block's `references` resolves to a visible alias target; subsequent backlinks queries find it. Tree views render it. Must not return a soft-deleted tombstone or `inserted: false`. (P0 v4.24 — covers the soft-delete-then-recreate flow; without restore semantics, the alias would silently resolve to a hidden row.)
- Rapid typing inside an existing `[[alias]]` (no alias-set change) → debounce coalesces; at most one processor run per block per debounce window.
- Undo of `setContent` → `references` converges back to pre-edit state.

---

## 8. Repo / FacetRuntime lifecycle

Bootstrap cycle today: `Repo` is constructed in `RepoProvider`; `AppRuntimeProvider` builds the FacetRuntime; **dynamic plugins are themselves discovered by querying the database** (extension blocks → compile → contributions). The dependency chain — dynamic plugins need a `findExtensionBlocks` query, which is a kernel facet contribution, which lives inside the FacetRuntime — is broken by **incremental, staged** `setFacetRuntime` calls. Kernel and static contributions are loaded first; dynamic ones land in a second wave once the discovery query has resolved.

The kernel/static/dynamic distinction is purely *timing*. Every contribution flows through the same `setFacetRuntime` path. Nothing is hardcoded in the Repo constructor.

1. **`Repo.constructor`** takes infrastructure only (`db`, `cache`, `undoManager`, `handleStore`). Registries start empty. `repo.tx(fn, opts)` is callable with empty registries — `fn` may freely use tx primitives (`tx.create`, `tx.update`, `tx.delete`, `tx.setProperty`, `tx.get`, `tx.peek`, `tx.childrenOf`, `tx.parentOf`); only **dispatch sites** (`tx.run(mutator)`, `repo.mutate.X(...)`, `repo.run('name', ...)`) reject with `MutatorNotRegisteredError` if the named mutator isn't in the snapshot. Handles for not-yet-registered query names sit in `'idle'` until the resolver appears.
2. **`setFacetRuntime(runtime)`** replaces registries with the merged contributions read from `runtime`. The caller passes a *cumulative* FacetRuntime — kernel + static + whatever dynamic contributions have been discovered so far — so each call is a full snapshot, not a delta. Notifies listeners so handles for newly-resolved (or newly-removed) queries re-run.
3. **`repo.tx`** snapshots registries at tx start; mid-tx runtime changes don't affect that tx.
4. **Follow-up processors snapshot at schedule time**: a processor scheduled via `tx.afterCommit` (or watch-matched at commit) fires against the registry snapshot from when it was scheduled, not the current one. A plugin removed between schedule and fire doesn't disrupt in-flight follow-ups.

### Bootstrap stages

```
Stage 0  new Repo(db, cache, undoManager, handleStore)
         registries = {}
         repo.tx callable but tx.run / repo.mutate.X throw MutatorNotRegisteredError
         query handles sit in 'idle' until their resolver registers

Stage 1  AppRuntimeProvider mounts (synchronous, same React render)
         → build FacetRuntime from { kernel facets, statically-imported plugins }
         → repo.setFacetRuntime(staticRuntime)
         registries contain whatever facets exist for the current phase:
           Phases 1-3:  mutatorsFacet (Phase 3+), postCommitProcessorsFacet
                        (Phase 3+), propertySchemasFacet (Phase 3+).
                        NO queriesFacet — kernel/plugin queries don't exist
                        as facet contributions yet. Code that needs queries
                        (parseReferences's alias lookup, dynamic-plugin
                        discovery in Stage 2 below) uses transitional raw-SQL
                        helpers via the Repo's db handle.
           Phase 4+:    queriesFacet added; the kernel queries
                        (subtree, ancestors, backlinks, aliasLookup,
                        findExtensionBlocks, etc.) register in Stage 1.
                        Existing transitional raw-SQL call sites switch to
                        repo.query.X(...).load() with no behavior change.

Stage 2  AppRuntimeProvider effect: discover & load dynamic plugins
         Phase 4+ (queriesFacet exists):
           → blocks = await repo.query.findExtensionBlocks(...).load()
         Phases 1-3 (queriesFacet not yet introduced; see §13):
           → blocks = await findExtensionBlocksLegacy(repo)
             — a transitional helper that calls today's existing
             dynamic-renderer discovery code path (raw SQL via PowerSync,
             no facet wrapping). Phase 4 wraps this same SQL into a
             queriesFacet contribution and the discovery call switches
             to repo.query.findExtensionBlocks. No behavior change at
             the switchover; this is a packaging migration.
         → contribs = await Promise.all(blocks.map(compileExtension))
         → fullRuntime = mergeFacetRuntimes(staticRuntime, contribs)
         → repo.setFacetRuntime(fullRuntime)
         registries now contain dynamic plugin contributions

Stage N  Plugin enabled / disabled / hot-reloaded at runtime
         → caller rebuilds the cumulative FacetRuntime
         → repo.setFacetRuntime(newRuntime)
```

The Stage 0 → Stage 1 window is intentionally tiny — both happen inside the same React render. No user-triggered mutation can land in it. Bootstrap-time logic that needs to mutate (e.g., creating a workspace root on first run) waits for Stage 1 the same way hook-driven code does.

```ts
class Repo {
  private registries: Registries = emptyRegistries()

  setFacetRuntime(runtime: FacetRuntime): void {
    const fromFacets = readDataFacets(runtime)               // kernel + plugin contributions, uniform
    this.registries = buildRegistries(fromFacets)
    this.notifyRegistryListeners()                            // re-resolves handles for newly-registered queries
  }

  async tx<R>(fn, opts?): Promise<R> {
    const snapshot = this.registries                          // may be empty pre-Stage-1
    return runTxWithSnapshot(snapshot, fn, opts)              // tx.run / repo.mutate.X enforce registry at dispatch
  }
}
```

---

## 9. Reactivity & invalidation

### 9.1 Per-handle subscription

`Handle<T>` keeps `value`, `listeners`, `dependencies`. Registered with `HandleStore`'s invalidation index on first load. On tx commit, `TxEngine` walks affected dependencies and re-runs handles synchronously.

### 9.2 What "affected" means

Handles declare dependencies. The invalidation engine matches dependencies against changes:

```ts
type Dependency =
  | { kind: 'row'; id: string }                          // exact row id
  | { kind: 'parent-edge'; parentId: string }            // any row whose parent_id = parentId
  | { kind: 'workspace'; workspaceId: string }           // any row in this workspace
  | { kind: 'table'; table: string }                     // catch-all coarse

type Invalidation =
  | { kind: 'rows'; predicate: (event: RowEvent) => boolean }
```

(The mutator-name match channel was dropped in v4.20 alongside `watches.kind: 'mutator'` — the same rationale applies: no `Dependency` kind matches mutator names, no plugin used it, and field/row-shaped invalidation is the correctness path.)

**Why parent-edge and not just row-level for tree queries**: a query like `subtree(root)` declared row-level deps on the descendants it observed. If a *new* row appears with a `parent_id` pointing into the subtree, that row's id was never in the dependency set — pure row-level invalidation misses it. Parent-edge dependencies fix this: `subtree(root)` declares parent-edge deps on every visited node id; any row write whose `parent_id` (before *or* after the change) matches one of those parentIds invalidates the handle.

Kernel handles declare these deps automatically during `resolve` — the resolver tracks visited row ids (for row-level) and visited parent ids (for parent-edge). Plugin queries opt into whichever is correct for their shape.

For changes that affect the parent-edge itself (a row's `parent_id` changes), the invalidation engine fires for *both* the old and new parent ids — both subtrees that include or exclude the moved row need re-resolution.

### 9.3 Invalidation has two sources

Invalidation feeds the same handle-walk logic from two places:

1. **TxEngine fast path** (local writes via `repo.tx`): on commit success, the engine has the per-tx snapshots map (id → before, after, captured at write site) and walks affected handles synchronously. Cheap, immediate, no DB round-trip. This is the primary path for everything the user does in this tab.

2. **`row_events` tail** (sync-applied writes from PowerSync): PowerSync's CRUD apply writes directly to the local SQLite, bypassing `repo.tx`. Those writes don't go through any TxEngine snapshots — but they *do* fire the row_events trigger, which appends rows tagged (via `COALESCE(tx_context.source, 'sync')`) as `source = 'sync'`. The Repo subscribes to `row_events` via `db.onChange`, **filters to `source = 'sync'`**, consumes new rows since the last seen `id`, and walks the same handle-invalidation logic. Throttled (~100ms; see §16.13) to coalesce sync-burst invalidations.

   **Filter rationale**: `db.onChange` on `row_events` would otherwise fire for every local write too (`source = 'user'` or `'local-ephemeral'`), causing double invalidation (once via TxEngine fast path, once via tail) and risking the tail clearing a marker that the fast path just populated correctly. Filtering to `source = 'sync'` makes the tail handle exactly the cases the fast path can't see, with no overlap. This is correct for both single-tab today and multi-tab in the future (a write from another tab arrives via PowerSync's CRUD-apply on this tab → leaves `tx_context.source = NULL` → COALESCE'd to `'sync'`).

Both paths converge on `HandleStore.invalidate({ rowId, parentEdge, … })`; handles see one invalidation regardless of source. **Sync-applied changes propagate to the UI without any additional plumbing in mutators or queries** — the row_events tail is the only thing required to make remote changes visible.

For multi-process invalidation (cross-tab) — out of scope; see §16.7. The single-tab design generalizes naturally because the `source = 'sync'` filter already handles both same-device sync and (future) cross-tab as the same case.

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
│   2. construct Tx; init empty snapshots map (id → before/after)│
│   3. user fn(tx) runs. Each primitive is write-through to SQL│
│      (cache update is deferred to step 6, post-COMMIT):       │
│        - on first touch of an id, engine SELECTs the current  │
│          row (the tx's `before` for that id)                  │
│        - apply metadata bumps (unless skipMetadata)            │
│        - run INSERT / UPDATE inline (triggers fire NOW —      │
│          row_events written, upload routing decided)          │
│        - record (before, after) in snapshots map              │
│          (or update existing entry's `after`).                 │
│          Cache is NOT mutated here — the shared cache stays   │
│          at its pre-tx state until commit walk.                │
│        - tx.createOrGet: INSERT…ON CONFLICT DO UPDATE         │
│          (restore-if-soft-deleted) WHERE blocks.deleted = 1;  │
│          empty RETURNING → live-row hit, follow-up SELECT,    │
│          no snapshot; non-empty RETURNING → fresh insert OR   │
│          soft-deleted row restored, snapshot recorded          │
│          (see §10.4 for the discriminator + branching SQL).    │
│        Reads:                                                 │
│          - tx.get / tx.childrenOf / tx.parentOf → SQL via     │
│            txDb; sees own writes natively (read-your-own-     │
│            writes inside the writeTransaction).               │
│          - tx.peek → snapshots map (own writes) → cache       │
│            (pre-tx state); never reads SQL, stays sync.       │
│   4. INSERT command_event row (txDb)                          │
│   5. UPDATE tx_context SET tx_id=NULL, user_id=NULL,          │
│        scope=NULL, source=NULL  (clear ALL fields together)    │
│ })   // PowerSync COMMIT or ROLLBACK                          │
│                                                               │
│ on success (post-COMMIT, synchronous before promise resolves):│
│   6. walk snapshots map: for each (id, before, after),         │
│      update cache to `after` (or evict if after=null), then    │
│      structural-diff handles and fire subscribers              │
│   7. record undo entry from snapshots map                      │
│   8. resolve repo.tx promise with user fn's return value       │
│                                                                │
│ post-resolve (fire-and-after):                                 │
│   9. dispatch tx.afterCommit jobs (own writeTransactions)      │
│       and field-watch follow-up processors                     │
└──────────────────────────────────────────────────────────────┘
```

**Atomicity boundary**: steps 1–5 all run inside `db.writeTransaction`, so they commit or roll back together. If anything throws, PowerSync rolls back the whole writeTransaction — including any `tx.createOrGet` follow-up SELECTs and the `tx_context` clear (step 5), so SQL state reverts atomically. The snapshots map (a tx-private in-memory structure that never touched the shared cache) is discarded — there is nothing to revert. Steps 6–8 happen after COMMIT but before `repo.tx`'s promise resolves; the cache and undo stack reflect the committed state by the time the caller sees the resolved promise. Step 9 is async after the promise resolves.

**Cache visibility**: outside-tx readers (other React components, imperative `block.peek` from unrelated code paths, the row_events tail's invalidation walk) see only committed state — the cache is mutated in step 6, after COMMIT. Within-tx, `tx.peek` reads the snapshots map first (own writes), then falls back to the pre-tx cache; `tx.get` reads SQL via the writeTransaction (read-your-own-writes natural). Handles fire on commit walk, never mid-tx, so subscribers see one consistent state transition per tx (matching the SQL transition).

Failure modes:
- User fn throws in step 3 → SQLite rolls back the writeTransaction (no row_events committed, no command_event, no upload-routing forwarded, `tx_context` reverts). Snapshots map is discarded. **Cache was never mutated**, so there's nothing to revert; outside-tx readers saw the pre-tx state throughout and continue to.
- DB error during step 3, step 4, or step 5 → same rollback path.
- Cache update / handle-diffing error in step 6 → tx is already committed; the engine logs the error and re-reads affected ids from SQLite to recover. (Should be impossible in practice — these are pure in-memory operations on already-validated rows.)

**Why write-through to SQL but not to cache** (v4.24): write-through to SQL gives the engine `read-your-own-writes` inside the writeTransaction for free (no staged-write overlay arithmetic), which is what v4.21 was after. Write-through to cache, in contrast, exposes uncommitted state to outside-tx readers and creates a window where (a) the cache shows a write that may still roll back and (b) handle subscribers' last-fired value disagrees with what `cache.get()` would return synchronously. Deferring the cache update to commit walk costs nothing — the snapshots map is already kept for handle diffing and undo — and restores the property that the shared cache is always consistent with committed state. The pre-v4.24 model wrote cache inline; the reviewer-flagged window is closed by this change. v4.21's "no staged write-set" intent stands: there is no overlay, no flush; primitives still hit SQL immediately, and the cache update is just batched into the same commit walk that fires handles.

### 10.1 `repo.mutate.X` is a 1-mutator tx

`Mutator.scope` may be a function of args (`scope: ChangeScope | ((args) => ChangeScope)`). The wrapper resolves it to a concrete scope **before** opening the tx — the engine needs a concrete scope to set `tx_context.source` (pipeline step 1) and to enforce read-only gating, both of which happen pre-user-fn.

```ts
await repo.mutate.indent({ id })
// ≡
{
  // 1. Resolve scope from args (mutator may declare scope as a function).
  const scope = typeof indentMutator.scope === 'function'
    ? indentMutator.scope({ id })
    : indentMutator.scope

  // 2. Open tx with concrete scope.
  await repo.tx(async tx => tx.run(indentMutator, { id }), {
    scope,
    description: indentMutator.describe?.({ id }),
  })
}
```

Mutators with arg-dependent scopes are rare in v1 (none in the kernel list), but the API permits them and the wrapper handles them correctly. Most mutators have a static scope and the resolution is a no-op.

### 10.2 Scope unification within a tx

A tx has one `scope`. Mixing scopes inside `tx.run` is rejected at the engine level (sub-mutator's scope must equal the tx scope). This keeps undo / upload semantics coherent.

For UI-state mutations interleaved with document mutations, callers issue separate `repo.tx` calls.

### 10.3 Read-only mode

`repo.tx` rejects with `ReadOnlyError` for `BlockDefault` and `References` scopes when `repo.isReadOnly`. `UiState` is always allowed (local-only chrome state).

### 10.4 `tx.createOrGet` semantics

`tx.create` throws `DuplicateIdError` on PK conflict — the safe default for accidental id collisions.

`tx.createOrGet({ id, ... })` is the deterministic-id path (daily notes, alias targets). Three outcomes — fresh insert, live-row hit, soft-deleted-row restore — all resolved inside the active writeTransaction:

```sql
-- Step 1 (write-through): try the insert; on conflict, restore-if-deleted in place.
INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json, ...)
VALUES (?, ?, ?, ?, ?, ?, ...)
ON CONFLICT(id) DO UPDATE SET
  deleted         = 0,
  workspace_id    = excluded.workspace_id,
  parent_id       = excluded.parent_id,
  order_key       = excluded.order_key,
  content         = excluded.content,
  properties_json = excluded.properties_json,
  references_json = excluded.references_json,
  updated_at      = excluded.updated_at,
  updated_by      = excluded.updated_by
WHERE blocks.deleted = 1                 -- ONLY restore soft-deleted; live rows stay untouched
RETURNING *,
  -- discriminator: was this row mutated by THIS statement?
  (blocks.created_at = excluded.created_at) AS was_fresh_insert,
  (blocks.deleted    = 0 AND blocks.created_at != excluded.created_at) AS was_restore;
```

The engine then branches on the discriminator and the empty/non-empty RETURNING:

- **Empty RETURNING** → `ON CONFLICT DO UPDATE WHERE blocks.deleted = 1` matched a live row, which the WHERE clause excluded; no row mutated. Engine runs a follow-up `SELECT * FROM blocks WHERE id = ?` inside the same writeTransaction to read the live row. **No snapshot recorded** (nothing changed). Returns `{ id, inserted: false }`. Cache is untouched (stays at pre-tx state); on commit walk the live-row contents may be reconciled into the cache if the cached entry was stale.
- **Non-empty RETURNING + `was_fresh_insert`** → fresh insert. Engine captures `(null, after)` in the tx-private snapshots map. Cache is updated on commit walk (step 6 of §10 pipeline). Returns `{ id, inserted: true }`.
- **Non-empty RETURNING + `was_restore`** → soft-deleted row restored in place. Engine captures `(before-row-with-deleted=1, after-row-with-deleted=0-and-fresh-fields)` in the snapshots map. On commit walk the cache entry transitions from "deleted/missing" to the new live shape, and handles diff accordingly. Returns `{ id, inserted: true }` — see §5.3 for why "restore = inserted:true" is the honest semantic for the cleanup-eligibility filter.

Within-tx reads: `tx.get(id)` after `tx.createOrGet` reads SQL via the writeTransaction — sees the live row whether this tx inserted, restored, or hit an existing live row. The `inserted` boolean is in the return value, available immediately.

**Why the restore path is needed**: §7's cleanup processor uses `tx.delete` (soft-delete) for orphaned alias targets. Without the restore path, typing `[[foo]]` after `[[foo]]` was previously created-and-cleaned-up would resolve to a soft-deleted tombstone — invisible to tree views and backlinks queries — leaving the second `[[foo]]` semantically broken. Restore-on-soft-delete-conflict is the simplest correct behavior; the alternative (cleanup uses hard-delete) would require a separate sync policy decision (see §4.5 — DELETE upload trigger is intentionally absent in v1).

---

## 11. Tree operations — push to SQL

### 11.1 Subtree

```sql
WITH RECURSIVE subtree AS (
  SELECT *, '~' || hex(id) || '/' AS path, 0 AS depth
  FROM blocks
  WHERE id = :rootId AND deleted = 0
  UNION ALL
  SELECT child.*,
         subtree.path || child.order_key || '~' || hex(child.id) || '/',
         subtree.depth + 1
  FROM subtree
  JOIN blocks AS child ON child.parent_id = subtree.id
  WHERE child.deleted = 0
    AND subtree.depth < 100                                   -- depth guard
    AND INSTR(subtree.path, '~' || hex(child.id) || '/') = 0  -- visited-id guard
)
SELECT * FROM subtree ORDER BY path;
```

**Path encoding**: each path segment is `<order_key>~hex(<id>)/`, concatenated. `hex()` is SQLite's built-in hex-encoder (each byte → two hex digits). Hex-encoding the id makes the path lexically safe regardless of id format — block ids may contain `/` (e.g., `daily/<workspaceId>/<date>` deterministic ids) without breaking the sort. The `~` separator between order_key and hex(id) is chosen because `~` (0x7E) is lexicographically greater than every alphanumeric character used in `order_key` strings, so order_key alone determines order until tied (then id-hex tiebreaks). The trailing `/` per segment is what makes the visited-id guard's INSTR match unambiguous (`~hex/` is found only as a complete segment, never as a prefix of a longer hex). The root segment (`~hex(rootId)/`) has no order_key — fine, root has no siblings.

**Visited-id guard**: `INSTR(subtree.path, '~' || hex(child.id) || '/') = 0` skips any child whose id already appears in the path-so-far. This is the cycle truncation: in a cyclic subtree like `A.parent_id = B, B.parent_id = A` reached from some root, the recursion stops the moment it tries to add a node already on the path, so each block appears at most once in the result. **Without this guard, UNION ALL with the depth-100 fallback would return the same blocks dozens of times** (every loop iteration re-emits the cycle members), bloating tree-handle results with duplicates. With the guard, the result is a cleanly-truncated tree the UI can render and surface a "cycle here" marker against. See §4.7 for the v4.23 detection-only telemetry that logs when this guard fires.

Path is internal to the CTE; consumers ignore it. The hex-encoded id is decoded back via `parseBlockRow` into the regular text `id` field of `BlockData`.

### 11.2 Ancestors

```sql
WITH RECURSIVE chain AS (
  SELECT *, '~' || hex(id) || '/' AS path, 0 AS depth
  FROM blocks WHERE id = :id AND deleted = 0
  UNION ALL
  SELECT parent.*,
         chain.path || hex(parent.id) || '/',
         chain.depth + 1
  FROM chain
  JOIN blocks AS parent ON parent.id = chain.parent_id
  WHERE parent.deleted = 0
    AND chain.depth < 100                                       -- depth guard
    AND INSTR(chain.path, '~' || hex(parent.id) || '/') = 0     -- visited-id guard
)
SELECT * FROM chain WHERE id != :id ORDER BY depth ASC;
```

`depth` is computed in the CTE for explicit `ORDER BY` (SQL doesn't guarantee CTE recursion order without it) and as the depth guard. The visited-id guard via `path INSTR` mirrors §11.1's pattern (parent-chain segments use `hex(id)/` since ancestors have no order_key context, but the `~hex/` shape is preserved for the same reason — unambiguous segment match). Result is leaf-to-root.

### 11.3 isDescendantOf

```sql
WITH RECURSIVE chain AS (
  SELECT id, parent_id, '~' || hex(id) || '/' AS path, 0 AS depth
  FROM blocks WHERE id = :id AND deleted = 0
  UNION ALL
  SELECT b.id, b.parent_id, chain.path || hex(b.id) || '/', chain.depth + 1
  FROM blocks AS b
  JOIN chain ON chain.parent_id = b.id
  WHERE b.deleted = 0
    AND chain.depth < 100                                       -- depth guard
    AND INSTR(chain.path, '~' || hex(b.id) || '/') = 0          -- visited-id guard
)
SELECT 1 FROM chain WHERE id = :potentialAncestor LIMIT 1;
```

Order is irrelevant here (we only need existence), so no `ORDER BY` needed. The visited-id guard makes a cycle terminate as soon as the recursion tries to re-enter a node — the result is the same boolean either way, but bounded by the path length, not by the depth-100 cap.

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

// codecs.optional wraps Codec<Date> → Codec<Date | undefined>, so defaultValue: undefined
// types correctly. Inferred type: PropertySchema<Date | undefined>.
export const dueDateProp = defineProperty('tasks:due-date', {
  codec: codecs.optional(codecs.date),
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
  argsSchema: z.object({ id: z.string(), date: z.date().nullable() }),  // zod is for arg validation
  scope: ChangeScope.BlockDefault,
  apply: async (tx, { id, date }) => {
    // dueDateProp is PropertySchema<Date | undefined>; null arg → undefined value clears the prop.
    // tx.setProperty applies codec.encode (Date | undefined → ISO string | null).
    tx.setProperty(id, dueDateProp, date ?? undefined)
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
- **Server schema (Supabase / Postgres) — new project, clean slate.** The current Supabase project keeps its data and config as a historical snapshot. Phase 1 spins up a **new** Supabase project via the supabase CLI (`supabase projects create …` followed by `supabase link` and a fresh `supabase db push`). The seven existing migrations under `supabase/migrations/` are deleted in this branch; the new project starts from a single `<timestamp>_initial_schema.sql` that creates only what's server-side: the `blocks` table with the new shape (`parent_id + order_key`), its indexes, RLS policies, and any RPCs still in use after the redesign. **No `tx_context` / `row_events` / `command_events` / upload triggers in the Supabase migration** — those are client-only. Treat this migration as the canonical ground-truth state, not a migration from anything. The old project URL is documented in the PR description in case anyone needs to inspect historical state, but it's no longer wired to the running app.

- **Secret handling — strict split.** The new Supabase project produces three credentials; they are NOT all the same kind of secret:
  - `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` — **public**, RLS-gated, intentionally exposed to the browser. These go into `.env` (gitignored) and `.env.example` (committed, with placeholder values).
  - `SUPABASE_SERVICE_ROLE_KEY` — **server-side secret**, bypasses RLS, must never reach the browser. Does NOT go into `.env`, does NOT go into `.env.example`, does NOT appear in any committed file. Lives only in the developer's local supabase CLI auth (`~/.supabase`) or a gitignored secrets path used by ad-hoc admin scripts. If a script needs it, the script reads it from the CLI's auth state, not from the app's env.
  - **Tracked-file guard**: the Phase 1 PR runs `git grep -niE 'service[_-]?role|SUPABASE_SERVICE_ROLE_KEY' -- '.env*' 'src/' 'public/' 'index.html'` and verifies it returns nothing. Case-insensitive + alternation catches `service_role` (lowercase, e.g. JWT claim), `SERVICE_ROLE` (uppercase env var fragment), `service-role` (URL form), and the fully-qualified `SUPABASE_SERVICE_ROLE_KEY`. Catches accidental commits of service-role references in browser-bundled source or in any tracked env-shaped file. (This spec is excluded from the check; it discusses the term but doesn't bundle into the app.)
  - **Local `.env` is gitignored and out of `git grep`'s reach** — developers confirm their checkout's `.env` doesn't carry the service-role key via a filename-only check (`grep -lE '^SUPABASE_SERVICE_ROLE_KEY' .env || echo OK`) that doesn't print secret-bearing contents. Documented in the PR for reviewers to run locally. `.env.example` contains only the two `VITE_*` placeholders.
- **Client schema (local SQLite via PowerSync).** New file (`src/data/internals/clientSchema.ts` or similar) exporting the DDL run at app startup, after PowerSync's own schema initialization: `tx_context` (one-row), `row_events`, `command_events`, plus **seven triggers**: 5 audit/upload (3 row_events writers for INSERT/UPDATE/DELETE + 2 upload-routing for INSERT/UPDATE only — DELETE upload routing is intentionally omitted in v1; see §4.5) and 2 workspace-invariant (BEFORE INSERT and BEFORE UPDATE OF parent_id, workspace_id; defined in §4.1.1; gate on local writes via `source IS NOT NULL`). The audit/upload trigger source-gate is `(SELECT source FROM tx_context WHERE id = 1) = 'user'` for upload routing; row_events triggers `COALESCE((SELECT source FROM tx_context WHERE id = 1), 'sync')` to tag sync-applied writes correctly without needing a sync-apply wrapper.
- PowerSync sync-config matches the new `blocks` shape. `tx_context`, `row_events`, `command_events` are not declared in sync-config (they don't sync; they're local-only).
- **No PowerSync sync-apply wrapper.** Sync-applied writes leave `tx_context.source = NULL` because they bypass `repo.tx`; the COALESCE handles tagging and the equality test on `'user'` correctly excludes sync writes from the upload trigger. Don't try to hook PowerSync's CRUD-apply path.
- New `repo.tx(fn, opts)` on `db.writeTransaction`. Async `tx.get`. `tx.peek`, `tx.create`, `tx.createOrGet` (with v4.24 restore-on-soft-delete semantics, §10.4), `tx.update`, `tx.delete`, `tx.run`, `tx.childrenOf`, `tx.parentOf`, `tx.afterCommit`. No `tx.query`.
- Engine enforces v4.24 invariants at the primitive level: cycle validation on every parent_id-changing write (§4.7 Layer 1, throws `CycleError`); single-workspace per tx (§5.3, throws `WorkspaceMismatchError`).
- `BlockData` type updated: no `childIds` field.
- `Block` facade: `block.childIds` is a sync getter computed from cache (sibling lookup); `block.children` returns sync `Block` array; `block.parent` sync.
- Properties stored flat: domain `BlockData.properties` is `Record<string, unknown>` (codec-encoded values), corresponding to the `properties_json` column. Property descriptors live as plain `xxxProp` exports for now (facet wrapping in Phase 3).
- **Tree CTEs land in Phase 1** (moved from former Phase 5): `SUBTREE_SQL`, `ANCESTORS_SQL`, `IS_DESCENDANT_OF_SQL`, `CHILDREN_SQL` per §11. The depth-100 + visited-id guards are baked in from day one; the cycle-validation `isDescendantOf` query relies on these. Kernel tree access (`block.children`, `block.parent`, `repo.move`'s validation, `repo.subtree(...)` data loader, `visitBlocks`'s loader, `getRootBlock`) all use these CTEs from Phase 1.
- Tree mutations rewritten as kernel functions on `repo` (not on `Block`): `repo.indent(id)`, `repo.outdent(id, opts)`, `repo.move(id, opts)`, `repo.delete(id)`, `repo.createChild(parentId, opts)`, `repo.split(id, at)`, `repo.merge(a, b)`, `repo.insertChildren(parentId, items)`. Each runs inside `repo.tx` and uses `{ parentId, orderKey }` patches (camelCase domain shape per §4.1.1).
- `visitBlocks` rewritten: load subtree once via `SUBTREE_SQL`, walk in memory.
- `getRootBlock` rewritten: load ancestors via `ANCESTORS_SQL`, return last element.
- `block.change(callback)` is **deleted**, not wrapped. Call sites that mutated content/properties via callbacks migrate to `block.setContent(content)` / `block.set(prop, v)` (single-block sugar; each is a 1-mutator tx) or to the dedicated kernel functions for multi-block tree ops (`repo.indent(id)` etc.).
- `applyBlockChange`, `_change`, `_transaction`, `getProperty`/`setProperty` (record-shape), `dataSync`, `requireSnapshot`-style throws — all deleted.
- `getProperty`/`setProperty` replaced by `block.get(schema)`/`block.set(schema, v)` operating on the new flat shape.
- Reference parsing keeps its current shape during Phase 1: a fire-and-forget helper invoked by the new content-changing kernel functions (`repo.setContent`, etc.). It does **not** run inside `repo.tx`. The helper is moved into a proper facet-contributed follow-up processor in Phase 3 — but that's a clean lift, not a behavioral change.
- All call sites updated. (This is mechanical and broad: every shortcut handler, every renderer, every selector touching `block.data.childIds`, `block.data.properties[name].value`, or `block.change(...)`.) Notable additional surface area landed since the spec was first drafted: **`src/utils/roamImport/`** (orchestrator + planner that constructs `BlockData` and writes blocks via the existing API). The planner builds `childIds` arrays and the orchestrator uses `block.change`-style writes — both need to migrate to the new `parentId + orderKey` shape and to `repo.tx` / `repo.mutate.X`. No special architectural treatment needed; treat it as one more caller in the migration sweep, with its existing import-end-to-end test (`sampleExport.test.ts`) as the regression gate.
- `repoInstance.ts` deleted; access via `RepoContext` only.

**Why this phase is large**: with no back-compat, the schema reset and the tree-API rewrite cannot land separately. Either the storage shape changes and we keep the old API (impossible without `child_ids_json`), or we change both at once. Property storage flatness is in the same situation. The phase is large but mechanical.

**Acceptance**:
- App boots from empty DB.
- All tests pass after fixture migration to new shapes.
- Multi-block ops wrap one `writeTransaction`. Crash mid-tx leaves no partial state.
- Sibling concurrent inserts both persist; ordering is deterministic post-sync (via `(order_key, id)` tiebreak).
- UI-state writes set `source='local-ephemeral'` and don't enter the upload queue.
- Sync-applied writes leave `source=NULL`; row_events COALESCE-tags them as `'sync'`; upload trigger doesn't loop them back.
- `block.change`, `dataSync`, `applyBlockChange`, callback-mutation API: all gone.
- New Supabase project provisioned via `supabase` CLI; `.env` (gitignored) contains the new `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`; `.env.example` (committed) contains placeholder values for those two only.
- **Tracked-files / browser-bundle guard against service-role leakage**: `git grep -niE 'service[_-]?role|SUPABASE_SERVICE_ROLE_KEY' -- '.env*' 'src/' 'public/' 'index.html'` returns nothing. Case-insensitive + alternation catches every common spelling (`service_role`, `SERVICE_ROLE`, `service-role`, `SUPABASE_SERVICE_ROLE_KEY`). Mechanical, runs in CI / pre-commit. Only sees tracked files.
- **Local `.env` validation is a separate manual check**: developers verify their gitignored `.env` does not define `SUPABASE_SERVICE_ROLE_KEY` via something like `grep -lE '^SUPABASE_SERVICE_ROLE_KEY' .env || echo OK` (filename-only output; the value never gets printed). The Phase 1 PR description includes a one-liner reminding reviewers to run this on their own checkout. `git grep` cannot validate gitignored files and must not be claimed to.
- Old project URL noted in the PR description as the historical snapshot. `supabase/migrations/` contains exactly one file (the new `<timestamp>_initial_schema.sql`, server-side only); the seven legacy migrations are deleted; `supabase db reset` against the new project produces the target Postgres schema directly.
- Client-side DDL lives in `src/data/internals/clientSchema.ts` (or equivalent) and runs at app startup after PowerSync's schema initialization; a fresh local DB has `tx_context` (one row), `row_events`, `command_events`, and exactly seven triggers populated: 5 audit/upload (3 row_events writers for INSERT/UPDATE/DELETE + 2 upload-routing for INSERT/UPDATE only) and 2 workspace-invariant (BEFORE INSERT and BEFORE UPDATE OF parent_id, workspace_id).

### Phase 2 — Sync `Block` + Handles + React migration

**Scope**:
- `HandleStore` with identity-stable lookup and ref-count GC.
- Handle factories: `repo.block(id)`, `repo.children(id)`, `repo.subtree(id)`, `repo.ancestors(id)`, `repo.backlinks(id)` return handles. Each calls `ctx.depend(...)` per §5.5 so invalidation works correctly.
- `repo.load(id, opts?)` with `{ children?, ancestors?, descendants?: number }` populates the cache neighborhood and (for `children: true`) sets the `allChildrenLoaded` marker.
- `useHandle(handle)` uses `useSyncExternalStore` + Suspense.
- `useBlockData`, `useChildren`, `useSubtree`, `useBacklinks`, `useParents` rewrite as 1-line sugar over `useHandle`.
- `useDataWithSelector` deleted; `useHandle(handle, { selector })`.
- All `await block.data()`-style sites become `await repo.load(id)` + sync access (with appropriate `opts` for the neighborhoods the caller will read).
- Cache loaded-range markers (`allChildrenLoaded` per parent) — set by `repo.load(id, { children: true })` and `repo.subtree(...)`'s loader; cleared by row_events tail when a sync-applied row's parent_id matches a tracked parent.
- React component migration: Suspense boundaries placed where loading-states live.

**Acceptance**:
- No `await block.data()` calls remain.
- `useBacklinks`, `useParents` etc. no longer use ad-hoc `useEffect` reload.
- `Handle<BlockData | null>` distinguishes loading vs. not-found via `status()`.
- `repo.children(id)` returns a handle whose value updates when sync brings in a new child of `id` (verified via test: write a row to local SQLite mimicking sync apply, expect the children handle to fire and re-resolve).
- `repo.load(id, { children: true })` sets `allChildrenLoaded`; subsequent `block.childIds` is sync without throwing; absent the load, `block.childIds` throws `ChildrenNotLoadedError`.
- row_events tail filters to `source = 'sync'` only — local writes invalidate via TxEngine fast path, no double-invalidation observable.

### Phase 3 — Named mutators + post-commit processors as facets

**Scope**:
- `mutatorsFacet`, `postCommitProcessorsFacet` defined per §6.
- Repo lifecycle (`setFacetRuntime`) implemented per §8.
- Kernel mutators registered (names finalize during phase): `setContent`, `setProperty`, `indent`, `outdent`, `move`, `split`, `merge`, `delete`, `insertChildren`, `createChild`, `createSiblingAbove`, `createSiblingBelow`, `setOrderKey`. The `repo.indent(id)` etc. kernel functions from Phase 1 become `repo.mutate.indent({ id })` (sugar over a 1-mutator tx). **Note:** `createAliasTargetInline` is NOT a registered Mutator — it's a plain helper called from `core.parseReferences`'s `apply` (see §7 mapping table). Registering it would expose it as `repo.mutate.createAliasTarget(...)` from any caller, bypassing the parseReferences flow that the cleanup processor's `inserted`-driven schedule-time filter (§7.5) relies on.
- Reference parsing migrated to `core.parseReferences` as a follow-up processor per §7 (post-commit; only mode that exists since v4.20). Lifts today's helper into a facet contribution; uses `tx.afterCommit('core.cleanupOrphanAliases', …)` to schedule the orphan-cleanup follow-up. **Until queriesFacet ships in Phase 4**, the processor uses raw SQL via `ctx.db` for: (a) alias-by-name lookup, (b) "any block references this id" scan inside the cleanup processor. Phase 4 wraps the same SQL into the kernel queries `aliasLookup` and `backlinks` (Phase 4 query list, §13.4) — same SQL, queriesFacet wrapper. Call sites switch from `ctx.db.getAll(SQL, ...)` to `repo.query.aliasLookup({...}).load()` and `repo.query.backlinks({...}).load()` with no behavior change. (Insertion-vs-conflict identity comes from `tx.createOrGet`'s `inserted` boolean per v4.20 — no row_events scan needed at any phase.)
- `repo.mutate.X` accessor surface (typed via module augmentation) and `repo.run('name', args)` (runtime-validated, dynamic).
- `propertySchemasFacet` for descriptors (still flat in storage; facet just wraps the existing descriptor exports).

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

### Phase 5 — Tree-query benchmarks + last call-site sweep

**Note (v4.24)**: the bulk of what was Phase 5 — `SUBTREE_SQL` / `ANCESTORS_SQL` / `IS_DESCENDANT_OF_SQL` / `CHILDREN_SQL`, the `visitBlocks` rewrite, the `getRootBlock` rewrite — moved into Phase 1, because once `child_ids_json` is gone there's no way to do tree mutations, deletes, cycle validation, imports, or subtree loads without these helpers anyway. The CTEs are also load-bearing for §4.7 Layer 1 cycle validation, which is engine-side from Phase 1. Trying to land them later would require a temporary JS-side fallback, which is exactly the kind of half-finished implementation we're trying not to ship.

**What's left here**: kernel queries `subtree`, `ancestors`, `isDescendantOf` get the queriesFacet wrapper Phase 4 ships (this is the packaging migration only — the SQL underneath is what Phase 1 already wrote). Plus a benchmarking pass to verify the design's "tree walks push to SQL" goal (#7 in §2):

**Scope**:
- queriesFacet contributions for `subtree`, `ancestors`, `isDescendantOf` (Phase 4 packaging applied to the Phase 1 SQL — same CTEs, just wrapped).
- Final sweep for any remaining `await block.parent()`-style chained walks; replace with `repo.query.ancestors({id}).load()` or in-memory subtree iteration.

**Acceptance**:
- No `await block.parent()` in a loop.
- Subtree benchmark: 1000 blocks 5 levels deep = 1 SQL query (verifies the §2 goal #7 "tree walks push to SQL"; the CTE was already in place from Phase 1, this is the measurement).
- Cycle stress test: subtree(rootId) where the rooted tree contains a sync-induced 2-cycle returns each member once, with the cycle entry point truncated by the §11.1 visited-id guard. UI can mark the truncation point.

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

1. **Read-only mode**: `repo.tx` rejects `BlockDefault` and `References` scopes when `repo.isReadOnly`. `UiState` always allowed (local chrome state).
2. **Scope is per-tx, not per-call**: every mutator call within a tx must share the tx's scope. Mixing throws.
3. **UI-state isolation**: UI-state txs set `tx_context.source='local-ephemeral'`; upload trigger excludes; not in undo stack.
4. **Sync-applied writes**: bypass `repo.tx` entirely. `tx_context.source` stays `NULL` (no `repo.tx` is open to set it). row_events triggers `COALESCE(tx_context.source, 'sync')` to tag them; upload-routing triggers gate on `= 'user'` so sync writes don't loop back into `powersync_crud`. row_events have `tx_id = NULL` (no tx). **No PowerSync sync-apply wrapper exists or should be added** — the COALESCE + equality-test pair handles this without one.
5. **Order_key determinism**: `ORDER BY order_key, id` everywhere children are listed. Order_key collisions are possible (concurrent inserts at same position) and resolve via `id` tiebreak.
6. **Codecs at boundaries only**: descriptor `codec.encode`/`codec.decode` runs only at `block.set` / `block.get` / `tx.setProperty` / `tx.getProperty`. Storage and cache always hold encoded shape. `tx.update(..., { properties: ... })` bypasses codecs and is opt-in.
7. **Metadata auto-bump**: engine sets `updated_at` / `updated_by` on writes at the write site (just before issuing the INSERT/UPDATE), unless the call passes `{ skipMetadata: true }`. Used by bookkeeping writes (e.g. parseReferences updating `references`) that aren't user intent.
8. **Tx snapshot**: `repo.tx` runs against the registry snapshot taken at tx start. Mid-tx facet-runtime changes don't affect the running tx.
9. **Tx queries are limited**: only `tx.get`, `tx.peek`, `tx.childrenOf`, `tx.parentOf`. Arbitrary cross-row reads happen out-of-tx (caller awaits a query handle, then passes results via args). Reads inside a tx see own writes natively — `tx.get` / `tx.childrenOf` / `tx.parentOf` go to SQL via the writeTransaction (read-your-own-writes); `tx.peek` reads a tx-private snapshots map first, then falls back to the (pre-tx) shared cache. The shared cache is updated only on commit walk (v4.24), so outside-tx readers never observe in-flight tx state.
10. **All processors are follow-up**: post-commit processors run in their own writeTransaction after the originating user tx commits. (v4.20 dropped same-tx mode.)
11. **Single-workspace per tx** (v4.24): every write inside a single `repo.tx` targets the same `workspace_id`. The engine pins `meta.workspaceId` from the first write and throws `WorkspaceMismatchError` on any subsequent write whose target row's workspace_id differs. `command_events.workspace_id` and `CommittedEvent.workspaceId` are unambiguously this single value.
12. **`tx.afterCommit` doesn't run on rollback**: scheduled jobs only fire if the parent tx commits.
13. **`block.data` is sync after load**: after `repo.tx` resolves, any `block.data` read sees the post-tx state — the cache update happens before the promise resolves.
14. **No `block.data.childIds`**: `BlockData` matches the row shape; `childIds` is computed on `Block` from the cache. Storage source-of-truth is `parent_id + order_key`.
15. **Reference parsing is eventually consistent**: `references_json` lags content by the parseReferences debounce window (~100ms typical). Code that reads backlinks accepts this.

---

## 16. Open questions / decide during implementation

### 16.1 zod vs Effect Schema (vs Valibot) — RESOLVED: zod

**What this is used for.** The `argsSchema` field on `Mutator`, `Query`, and `PostCommitProcessor` definitions (and `resultSchema` where it appears). Runtime validation of args at the boundary — most importantly for **dynamic plugins** (compiled-at-runtime extension blocks that bypass TypeScript's compile-time checks). Static plugins get the same validation but it rarely fires there because TS already catches type mismatches.

**What it is NOT used for.** Property storage codecs. Those are a separate `Codec<T>` interface (§5.6) because we need bidirectional encode/decode and these schema validators are typically unidirectional.

**Tradeoffs:**

| | zod | Effect Schema | Valibot |
|---|---|---|---|
| Bundle size | ~10–14 KB gz | ~30–50 KB gz (Effect runtime included) | ~3–5 KB gz |
| Bidirectional | no (validation only) | yes | no (transform-based, limited) |
| React-ecosystem familiarity | very high | growing | moderate |
| API ergonomics | excellent | excellent | very close to zod |
| Downstream risk | mature, stable | younger; tied to Effect | younger but zod-compatible API |

**Decision: zod.**
- We don't need bidirectional schemas here (codecs handle that role separately).
- zod's bundle is modest; nothing in the spec benefits from Effect's heavier runtime.
- Plugin authors are likely to know zod already from React work.
- If bundle size becomes a measured concern later, swapping to Valibot is near-mechanical (compatible API).

### 16.2 Processor mode — RESOLVED: follow-up only (v4.20)

All processors are follow-up. v4.20 dropped the `same-tx` mode entirely. v1 shipped zero same-tx processors and the only hypothetical use case (atomic backlinks via parseReferences) was already rejected in v4.4 — going same-tx for parseReferences would have added typing latency to a hot path. Same-tx processor wiring (discriminator, `SameTxCtx`, dedicated pipeline step, atomicity prose) was complexity for a feature with no callers. Re-add the mode if a real same-tx use case ever appears; until then, dead weight removed.

The mutator-name watch channel (`watches.kind: 'mutator'`) was also dropped in v4.20 — also zero v1 callers, also actively discouraged by the design itself ("use `field` when correctness depends on the field changing"). Field watches catch bypassing mutators; mutator-name watches don't, and we couldn't find a use case where that distinction was useful.

### 16.3 Plugin-owned entity tables

Out of scope for v1. Plugins use properties.

### 16.4 Checkpoints for undo coalescing

**What this is.** v1's undo granularity is one entry per `repo.tx`. That's correct for explicit operations (indent, move, delete, paste — each is one tx, one undo entry). It's **wrong for typing**: every coalesced setContent commit becomes its own undo entry, so cmd-Z reverts a few characters at a time instead of a sentence/word.

**Pattern (TinyBase / VS Code / most editors).** Wrap a sequence of txs in a "checkpoint group":

```ts
const cp = repo.openCheckpoint({ description: 'Edit content' })
// ...txs run inside this group; engine tags each tx with cp.id
cp.close()                                  // groups them into one undo entry
```

Triggering rules belong to the UI: on focus → open; on blur / idle / explicit-save → close. Until close, all txs land in the same group. Undo reverts the whole group.

**Why deferred.** Tx-level undo is enough until typing is wired up to `repo.tx`. Today's BlockEditor uses CodeMirror's internal undo for content during edit-mode and only commits to the document on explicit save / blur — meaning today's content writes are already coarse-grained. The fine-typing-undo pain only surfaces if/when we route per-keystroke writes through `repo.tx`. When that happens, add the checkpoint API; until then, YAGNI.

**Implementation cost when needed.** Small: add a `checkpointId` field to undo entries; `undo` pops entries until checkpoint boundary. The TxEngine already records one undo entry per tx, so the only new code is the grouping/popping logic.

### 16.5 Signals vs `useSyncExternalStore`

`useHandle` uses `useSyncExternalStore`. Signals deferred.

### 16.6 Events-derived undo

Defer; `row_events.before_json` enables it later.

### 16.7 Cross-tab invalidation

Out of scope. Today's `enableMultiTabs=false, useWebWorker=false` is preserved. Multi-tab is a separate work item.

### 16.8 Server-side audit log

`row_events` and `command_events` are local-only in v1. If we eventually want a server-side audit, the answer differs per table:

**`command_events`** — push as-is, with one filter:
- Filter to `source = 'user'` only (skip `local-ephemeral` — they're UI-state, not document changes; skip `sync` — those originated on other clients and have already been logged from there).
- Each row maps cleanly to a Postgres row of the same shape: `tx_id`, `description`, `scope`, `user_id`, `workspace_id`, `mutator_calls` (JSON), `created_at`, `source`.
- Volume is low (~one row per `repo.tx`, on the order of dozens-to-hundreds per active user per day) so streaming as-is is fine.
- This gives you "who ran what mutator with what args, when" — the high-value audit signal.

**`row_events`** — probably *don't* push, unless we later need a row-level audit:
- Volume is much higher (one row per row-write; multi-block ops produce many).
- `before_json` / `after_json` are full row snapshots, so storage cost is meaningful.
- Most "what's the current state" questions are answerable from `blocks` directly.
- Most "what changed and when" questions are answerable from `command_events` + the snapshot at any point reconstructable by replaying from initial state — though we don't keep that today.
- If we ever need full row-level history server-side, push with the same `source = 'user'` filter and timestamp normalization (ISO strings instead of integer ms).

**Translation needed?** Minimal:
- Timestamps: client uses `INTEGER NOT NULL` (epoch ms); Postgres usually wants `timestamptz`. Either store as bigint and do app-side conversion, or push as `to_timestamp(ms / 1000)`. Either works; the upload step does the conversion.
- JSON columns: client `TEXT` is already JSON-shaped; Postgres `jsonb` accepts it. Trivial cast.
- No structural shape change.

**Do later.** If/when we want this, add a separate per-table sync rule in `sync-config.yaml` for `command_events` (server-bound only, filtered by source); the existing PowerSync upload trigger pattern can be extended.

### 16.9 Order-key rebalancing

Defer until keys actually grow.

### 16.10 Aliases storage

Today's properties include an `aliases` list; the alias-lookup query reads it. The new model keeps this. Defer separate `block_aliases` table unless JSON-extract is too slow.

### 16.11 `tx.get` fallthrough cost

Every cache miss inside a mutator does a SQL read inside the writeTransaction. For deep mutators reading dozens of blocks, this can be slow. Mitigations: `mutator.reads(args)` preload hints; engine batches preload reads into a single SQL query before `apply` runs. Implement preload in Phase 1; profile when complex mutators land.

### 16.13 row_events tail throttle window

The tail subscription throttles invalidation runs by ~100ms (§9.3) to coalesce sync-burst events. Validate the window during Phase 2 with realistic sync bursts (e.g., a peer doing `repo.subtree(...)` move ops). Too short = redundant re-resolves; too long = laggy UI. 100ms is a reasonable starting point but treat as tunable. Defer until profiling.

### 16.12 Order-key generation choice — RESOLVED: jittered

Decision: use **`fractional-indexing-jittered`** (Rocicorp). Jittering reduces the probability of distinct clients computing the same key when inserting between the same neighbors; the `(order_key, id)` secondary sort still handles the residual collision case for full determinism. This is strictly better than plain `fractional-indexing` at no measurable cost.

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
- [ ] Reviewer's round-4 findings addressed: stale Phase 1 sync-apply-wrapper bullet removed (§13.1); Phase 1 parseReferences description aligned with v4 follow-up decision (§13.1); Phase 3 parseReferences description aligned with follow-up (not same-tx with prefetch) (§13.3); `Block` facade gains `block.set` / `block.setContent` / `block.delete` sugar with explicit "thin wrapper over kernel mutator" framing (§5.2); built-in primitive codecs validate on decode, `codecs.optional` added, `codecs.unsafeIdentity` reserved for kernel-internal use (§5.6); plugin example uses `codecs.optional(codecs.date)` for the `Date | undefined` property (§12.1).
- [ ] Reviewer's round-4 finding "PropertySchema lacks render metadata" — already addressed in v4.1; not a real finding against v4.2.
- [ ] Reviewer's round-5 findings addressed: server/client schema split (§4 intro, §13.1 Phase 1); two-source handle invalidation (TxEngine + row_events tail) (§9.3); children-completeness markers + `ChildrenNotLoadedError` (§5.2); parent-edge dependencies for tree handles (§9.2); field-write processor watches with `core.parseReferences` watching `blocks.content` (§5.7, §7); ancestors CTE has explicit `depth` ORDER BY (§11.2); stale `tx_context.source='sync'` invariant fixed to `NULL` + COALESCE (§15.4).
- [ ] Round-6 through Round-9 review-thread bookkeeping is collapsed (v4.24): the still-valid items from those rounds — `ctx.depend` (§5.5), `hex(id)` path encoding (§11.1), soft-delete row_events `kind` (§4.3), tx_context all-fields clear (§4.3, §10), CTE depth + visited-id guards (§4.7, §11), `BlockData` camelCase + storage mapping (§4.1.1), Stage-2 dynamic-discovery transitional path (§8), §6/§8 facet-runtime unification — are described in their relevant sections. The items those rounds spec'd that have since been deleted — `ChangeScope.Repair`, `repo.repairTreeInvariants`, `repo.canWrite`, `tx.create({onConflict:'ignore'})`, the row_events insertion gate, `repairCycle` mutator, conditional-source-from-isReadOnly — are documented as deletions in the v4.18 / v4.21 / v4.23 / v4.24 trajectory entries (top of doc) and below. **Do not reintroduce the deleted items.** For the round-by-round review history, see git log on this file.
- [ ] v4.18 → v4.23 trajectory: cycle-repair was workspace-aware (v4.17), then engine-unaware with `repairTreeInvariants` worker (v4.18), then deleted entirely (v4.23). The current spec has no Repair scope, no repair worker, no per-workspace canWrite gating; sync-induced cycles are detected via the row_events tail (§4.7) and logged as `repo.events.cycleDetected`, not repaired. **Don't re-add any of this without telemetry showing it's needed.**
- [ ] v4.21 write-through reflected throughout: Tx primitives execute their INSERT/UPDATE inline within `db.writeTransaction`; the engine captures `(before, after)` per id in the snapshots map for handle diffing / undo (§5.3, §10 pipeline, §15 #7). Reads inside a tx see own writes natively (`tx.get` via writeTransaction; `tx.peek` via snapshots-then-cache fallback). `tx.createOrGet` is just one more write-through primitive (§10.4). The shared cache is updated on commit walk only — see v4.24 below; do NOT re-add inline cache writes during the tx.
- [ ] v4.23 cycle-repair drop reflected throughout: Layer 1 = engine-side validation on every parent_id-changing write (§4.7), Layer 2 = CTE depth + visited-id guards (§4.7, §11), plus a detection-only row_events-tail scan that logs cycles for telemetry. **No automatic repair.** `ChangeScope.Repair`, `repo.repairTreeInvariants`, `repo.canWrite`, the `repairCycle` kernel mutator, and §5.8.1 are all removed. Read-only mode (§10.3, §15 #1) collapses to "BlockDefault / References reject; UiState always allowed."
- [ ] **v4.24 reviewer-found correctness fixes reflected throughout** (this round):
  - **createOrGet restores soft-deleted rows** (§5.3, §10.4): `tx.createOrGet` no longer returns `inserted: false` against a soft-deleted tombstone — it un-soft-deletes in-place via `ON CONFLICT DO UPDATE … WHERE blocks.deleted = 1` and returns `inserted: true`. The cleanup-eligibility filter in §7 stays correct because "restore = inserted:true" is the honest semantic ("this tx made a live row exist where none did before"). Test coverage for the soft-delete-then-recreate path is in §7.4. Closes the P0 finding that `[[foo]]` after a previous create-and-cleanup would silently resolve to a hidden row.
  - **Cache update deferred to commit walk** (§5.3, §10 pipeline, §10 atomicity-boundary prose, §15 #9): SQL is still write-through inside `db.writeTransaction`; the shared cache is no longer mutated mid-tx. The snapshots map (already kept for handle diffing / undo) is the tx-private overlay; `tx.peek` reads snapshots-then-cache; outside-tx readers see only committed state. Closes the dirty-read window where a render or imperative `block.peek` could observe uncommitted state. v4.21's "no staged write-set" intent stands: write-through to SQL, no overlay arithmetic, no flush step — the cache update is simply batched into the commit walk that fires handles.
  - **Engine-side cycle validation** (§4.7 Layer 1): every primitive that sets `parent_id` on an existing row (`tx.update`, the restore branch of `tx.createOrGet`) runs `isDescendantOf` and throws `CycleError` on cycle creation. Replaces the per-mutator validation that `tx.update` could bypass.
  - **CTE visited-id guards** (§11.1, §11.2, §11.3, §4.7): subtree / ancestors / isDescendantOf get visited-id INSTR checks via the path encoding. Cycles produce cleanly-truncated, dedup'd results instead of UNION-ALL-driven duplicates.
  - **Trigger count corrected to 7** (§4.5, §13.1, top design-notes): 5 audit/upload + 2 workspace-invariant. Phase 1 acceptance check updated.
  - **Local trigger no longer rejects soft-deleted parents** (§4.1.1): aligns with server-side composite FK behavior. Mutator-level validation throws `ParentDeletedError` for new local children under soft-deleted parents (UX layer); the storage layer accepts whatever sync brings in.
  - **Single-workspace per tx** (§5.3, §15 #11): engine pins `meta.workspaceId` from the first write and throws `WorkspaceMismatchError` on cross-workspace writes within the same tx. `command_events.workspace_id` and `CommittedEvent.workspaceId` are unambiguous.
  - **Phase 5 collapsed** (§13): tree CTEs (`SUBTREE_SQL`, `ANCESTORS_SQL`, `IS_DESCENDANT_OF_SQL`, `CHILDREN_SQL`) move into Phase 1 — they're load-bearing for engine-side cycle validation, tree mutations, deletes, imports, and subtree loads from day one. Phase 5 shrinks to the queriesFacet wrapper packaging plus a benchmarking pass.
  - **Stale prose cleaned**: "before staging the write" replaced with "before issuing the write" (§4.1.1); `mode: 'follow-up'` example dropped (§7 mapping table, Phase 3 prose) — only one mode exists since v4.20; round-6/-7/-8/-9 acceptance bullets collapsed (above) — they had a mix of still-valid and v4.18/v4.23-deleted bookkeeping that risked accidentally resurrecting deleted design.
- [ ] Each phase ships with a green build and meets acceptance criteria.
- [ ] §16.1 (zod) and §16.12 (jittered fractional indexing) resolved in v4.10. No remaining gating decisions before Phase 1 — everything else in §16 is intentionally deferred.
- [ ] Dynamic-plugin lifecycle is constructible at runtime via staged `setFacetRuntime` waves (§8 Bootstrap stages, §12.2). Pre-Stage-1, `repo.tx` runs with empty registries; dispatch sites (`tx.run`, `repo.mutate.X`, `repo.run`) reject with `MutatorNotRegisteredError` for unknown names.
