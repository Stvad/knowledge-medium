# Follow-ups

## Security

### Explicit user enablement for synced extension blocks

Dynamic extension blocks are intentionally powerful: a `type = extension` block is application code, not inert content. Before this ships to shared workspaces, make extension execution opt-in per user. A synced extension block should load as "available but disabled" on a client until that user explicitly enables it.

Fix shape: keep the trust decision outside synced block properties so a collaborator cannot force-enable code for other members. Store an allowlist keyed by `(workspaceId, blockId, contentHash)` in device-local or user-owned settings, and require re-approval when the extension block's source changes. The existing `system:disabled` property can remain an authoring/convenience switch, but it is not a security control because it is synced and editable by workspace writers.

### React identity contract for extensions

Extensions that render into the app's React tree need to share the host app's React module identity. Today that is partly enforced by externalizing `react` / `react-dom` through the page import map, and partly accidental: Babel's current extension JSX transform emits `React.createElement(...)`, so extension blocks rely on `window.React` unless they import React explicitly.

Fix shape: document React and ReactDOM as host-provided peer dependencies for extension authors and bundled extensions. Bundled extensions must externalize `react`, `react-dom`, `react/jsx-runtime`, and `react/jsx-dev-runtime`, then resolve those from the host environment. Tighten the in-browser compiler so JSX uses an explicit host import (`react/jsx-runtime` or an injected `import React from 'react'`) instead of the global. Keep import-map entries exact where possible, and integrity-pin any CDN-hosted host React modules.

## Tx-bound read guards for reference processors

`core.parseReferences` and `core.cleanupOrphanAliases` now do their expensive reads before opening a write transaction to avoid the PowerSync queue deadlock shape documented in `tasks/processor-tx-deadlock.md`. That leaves two narrow TOCTOU windows: alias ownership can change between "alias missing" and deterministic target creation, and a newly inserted alias target can gain a reference between the orphan precheck and cleanup delete.

Fix shape: add narrow tx-bound read helpers for the final guards, e.g. alias lookup by `(workspaceId, alias)` and "does any block reference this id?", implemented on the `Tx`/`TxImpl` path using the active write-transaction lock context. Keep the broad prefilter reads outside the tx, but re-check inside the tx immediately before creating the fallback alias target or deleting a cleanup candidate. Do not call the bare `ctx.db` from inside `repo.tx`; that reintroduces the queue deadlock.

## CI guard on Postgres ↔ TS schema drift

`scripts/gen-sync-config.ts` keeps the local-SQLite raw-table mapping and the PowerSync sync-stream SELECT in lockstep (both projected from the same `BLOCK_STORAGE_COLUMNS` / `WORKSPACE_*` arrays), but **Postgres is still drift-prone** — someone can edit `BLOCK_STORAGE_COLUMNS` without writing the matching `supabase/migrations/<…>.sql`, and nothing fails until `db push` (or worse, a runtime PATCH that references a missing column). Fix shape: a CI step that calls `npx supabase db query --linked "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('blocks','workspaces','workspace_members')"` and asserts the returned set is a superset of every name in the TS column lists. Costs: needs a Supabase-reachable env in CI (or a checked-in `supabase/schema-snapshot.json` you regenerate via a `yarn snapshot:schema` script and diff against). Lower-effort variant: parse the migration files as text and grep for `add column.*<name>` per TS column — no DB connection needed but misses migrations that drop a column.

## Id-only collection handles for `subtree` / `ancestors` / `backlinks`

`repo.childIds(id)` was added alongside `repo.children(id)` to give callers that only need the structural list a handle whose only dep is `parent-edge` — child property updates don't invalidate it, and the loader is a lighter `SELECT id` query. `useChildIds` and `useHasChildren` were rewritten on top of it; the symptom that motivated the split was an UI-state child mutation cascading a `useChildren`-driven re-render through `LayoutRenderer`.

The same id-only shape would work for the other three list-handle factories in `Repo` (`subtree`, `ancestors`, `backlinks`) for the same reason: their React consumers all use `Block` facades for per-row reactivity, so the per-id `row` deps the handles currently declare are redundant — the row-grain subscriptions on each Block already cover content updates. But the leverage drops sharply:
- `subtreeIds` — same shape of win in principle (row dep × many descendants), but no current hot consumer. Probably worth waiting for an actual callsite.
- `ancestorIds` — Breadcrumbs is the only consumer; chains are typically O(depth) shallow and the breadcrumb labels need block content anyway.
- `backlinkIds` — Backlinks UI also renders each backlink's content; row deps are bounded by the backlinks list size.

Add when a measured hot path appears, not preemptively. Phase 4's `queriesFacet` (per `tasks/data-layer-redesign.md` §13.4) is the canonical place for these — `repo.childIds` will migrate alongside `repo.children` to `repo.query.childIds` with no callsite changes downstream of the hooks.

## Reduce per-block flicker on lazy hierarchical loads

`useChildIds` is backed by `repo.childIds` which hydrates the whole children list per parent on first read. That keeps the per-parent expand path fast, but as the user scrolls into deeper levels their grandchildren still load on `LazyBlockComponent` mount and visibly pop in. Standard fixes worth considering when this becomes noticeable:

- **Skeleton with structural shape**: render a bullet at the right indent depth (data the parent already has) inside the LazyBlockComponent placeholder instead of the bare 32px `<div>`. Real content slots into the same shape rather than appearing from nothing — most of the perceived "pop" is the bullet + indent appearing, not the text.
- **`useTransition` around expand toggles**: `startTransition`-wrap the `setIsCollapsed` write so React keeps showing the previous tree until the new descendant Suspense boundaries resolve, instead of flashing fallbacks during the load window.
- **Tighter overscan / prefetch**: bump `OVERSCAN_PX` in `LazyBlockComponent` or have `BlockChildren` warm a few levels of `repo.childIds` ahead of intersection, so by the time a row mounts its data is already in cache.

Cheap wins first (skeleton + maybe overscan); reach for `useTransition` if it still feels jumpy.

## Periodic `row_events` trim

`row_events` is the per-row audit + invalidation log. Trigger-written, never trimmed — it grew to 262 MB / 304k rows on the import-heavy DB. The fast path doesn't need history; the row_events tail consumes by ascending `id` and only needs rows newer than its high-watermark. Long-tail entries are dead weight on disk and on backup/export.

Fix shape: at startup (or on a low-priority idle hook), `DELETE FROM row_events WHERE id < (MAX(id) - K)` for some K (e.g. 50 000), or `WHERE created_at < ?` with a 7-day window. Either runs in one statement and the index on `id` is the auto PK. Optional: bound `command_events` with the same shape (4 403 rows, ~negligible today, but the same unbounded shape).

Note: PowerSync's CRUD-apply path still writes a row_event per sync write, so even a fully-synced read-only client will accumulate. Worth doing.

## Drop unflushed `ps_crud` for local-only mode (and reduce import bloat)

`ps_crud` is PowerSync's outgoing upload queue. The Roam import (run with `source='user'`) enqueued 304k rows ≈ 204 MB. If the user runs in `localOnly` mode (no remote sync) those entries can never drain; if remote sync is on but the import was massive, the queue still bloats local storage until it drains.

Two angles:

- **Cleanup option** — when `localOnly` is active, expose a `discardPendingUploads()` action that truncates `ps_crud` (PowerSync's API may have a helper for this; otherwise raw `DELETE FROM ps_crud` is fine since nothing reads it locally). Frees ~200 MB on this DB.
- **Don't enqueue during import in the first place** — the upload trigger gates on `tx_context.source = 'user'`. Adding a fourth source value `'import'` (or letting the import set source to `'local-ephemeral'` with a temporary scope override) keeps the row_events audit happy while skipping `ps_crud`. Cleanest variant: add `'import'` source, both `row_events` and upload triggers learn to ignore it. The Roam import wraps its txs with `source: 'import'`. Then both `row_events` AND `ps_crud` stay small even on bulk import. Less-clean variant: drop the upload trigger before import, recreate after.

The "don't enqueue" path also helps the `row_events` problem above — an `'import'` source that skips row_events trims an additional ~250 MB of audit-log bloat from the import.

## Move agent-runtime tokens from localStorage to user-page blocks

Today (commit `90a9047`) agent tokens live in localStorage keyed by `(userId, workspaceId)`, managed by `AgentTokenStore` in [src/agentRuntime/agentTokens.ts](src/agentRuntime/agentTokens.ts). localStorage isn't actually more secure than a block on the user page — same-origin is the boundary either way — and a block fits the "everything is a block" model better (undoable, exportable, manageable inline on the user page).

Blockers to land first:

1. **A persistent device-local block scope.** Existing `local-ui` is per-session-ephemeral; tokens need persisted-but-non-syncing. New scope must (a) write to OPFS, (b) never enqueue into `ps_crud`, (c) avoid `row_events` if that audit is also gated to local. Add an engine guard so blocks marked `kind=agent-token` can't have their scope upgraded by an `update_block` tx — defends against accidental edits flipping a token into a synced row.
2. **Renderer for `kind: agent-token`.** Read-only display of label + createdAt + a Revoke button. Hide from QuickFind / autocomplete / outline rendering so the user doesn't stumble into them.
3. **Multi-device sanity check.** Confirm that a synced user page on Device B doesn't crash when its child set is partially device-local on A.

Once #1 lands, the migration is small: swap `AgentTokenStore` for a thin wrapper around `repo.tx({scope: DeviceLocal})` + `repo.query.children({parentId: userPage.id, kind: 'agent-token'})`. Bridge handshake and CLI stay identical.

## Strict-mode-with-checked-overrides for name-keyed facets

Every name-keyed facet in the codebase (`propertySchemasFacet`, `propertyUiFacet`, `postCommitProcessorsFacet`, `queriesFacet`, `mutatorsFacet`, `typesFacet`, `blockLayoutFacet`, etc.) follows the same convention: warn on duplicate name, last-wins. That's the existing override mechanism — plugins replace kernel registrations by registering after them. It works, but the warn is easy to miss in practice and accidental name collisions silently overwrite intended behavior.

A stricter scheme: registrations may opt into a checked override target — `propertySchemasFacet.of(statusPropV2, {source: 'my-plugin', overrides: 'status'})`. Combine asserts that an entry under `overrides` exists; if absent, throw (catches typos). If present, replace silently (intent declared, no warn). Without `overrides`, any duplicate-name collision throws (catches accidents). That gives strict mode + intentional override + typo catch in one shape.

Apply uniformly across every name-keyed facet — the convention should be consistent. ~10 lines per facet's combine.

**Trigger to build:** plugin authors stepping on each other's schema / mutator / processor names in the wild and the warn-and-last-wins not catching it in code review. Until then, the existing convention works for the alpha-stage plugin surface and the [docs/type-system.md §1a](docs/type-system.md) schema-lift handles the most acute case (object-identity dedup for multi-type-shared schemas means the warn fires only on real conflicts).

## `rendererProp` silently no-ops on a misspelled renderer id

[useRenderer](src/hooks/useRendererRegistry.tsx:26) reads `rendererProp` and only honors it via `if (rendererKey && registry[rendererKey])` — when the prop names a renderer id that isn't registered (typo, plugin not loaded, renderer renamed), the lookup silently fails and resolution falls through to the `canRender` predicate sort. The user's explicit override is lost with no signal.

Fix shape: when `rendererKey` is set but absent from the registry, `console.warn` with the offending id + the available ids, and either (a) render `MissingDataRenderer`-style "renderer not found" placeholder so the lost override is visible, or (b) fall through with the warning. Pick (b) for now — less disruptive — but at least surface it. Independent of any larger renderer-resolution redesign; cheap fix.

## Block facade soft-delete contract drift between `peek` / `data` / `load`

`Block`'s three read surfaces disagree on what a soft-deleted (`deleted: true`) row means:

- `peek()` returns the tombstone snapshot.
- `data` (sync getter) returns the tombstone snapshot too — including `deleted: true` — and expects callers to self-filter.
- `load()` returns `null` for soft-deleted rows (its underlying `repo.load`'s SQL filters `WHERE deleted = 0` and side-effects `markMissing` to wipe the cache entry).

The cache fast-path in [block.ts:96](src/data/block.ts:96) had to special-case tombstones (fall through to SQL when `cached.deleted`) to preserve the `null`-for-soft-deleted contract that callers like [RefPropertyEditor.tsx:54](src/components/propertyEditors/RefPropertyEditor.tsx:54)'s `blockMatchesTargetTypes` rely on (`if (!data) return false` — would silently accept a soft-deleted block as a valid ref target without that branch).

Coherent shape: all three surfaces return the snapshot (incl. tombstones), callers self-filter on `.deleted` for live-only views — same as today's `data` getter. Removes the inconsistency, removes the `markMissing` side-effect that wipes a cached tombstone, and removes the cache-fast-path's tombstone special case.

**Trigger to build:** the next caller that gets bitten by the inconsistency, OR a refactor that makes `markMissing`'s "wipes cached snapshot" side-effect a problem (e.g. wanting to surface the tombstone to undo flows after a soft-delete-then-load sequence). Migration cost is real — every `await block.load()` site that uses `null` as "doesn't exist for me" needs to be revisited (`!data` → `!data || data.deleted`). Manageable but not zero.

---

# Architectural ideas (no current trigger)

Notes captured from design discussions where we landed on a clear deferred shape but no near-term reason to build. Each entry exists so future-us doesn't re-derive the analysis from scratch.

## Plugin payload side-table (`plugin_block_data`) — deferred bandwidth escape hatch

The current plugin-extensibility plan has plugins write into namespaced subtrees of `properties_json` (scalars) or namespaced entries in `edges_json` (relationships), with local-only derived tables maintained by Shape-A triggers — JSON is source of truth, local rep is derived from a `LocalSchemaContribution`. This works at typical sizes but pools all plugins' bandwidth into one of the two JSON columns: a plugin that frequently mutates a large opaque payload re-syncs the whole blob on every edit, sharing wire bytes with everything else attached to that block.

**Escape hatch:** one core-provided `plugin_block_data(block_id, plugin_id, payload TEXT)` table, one row per (block, plugin). Bandwidth-isolated per plugin; lifecycle (block insert/delete cascade, workspace_id propagation) handled by shared core triggers; sync via plugin-aware PowerSync rules. Plugins still derive their query/index tables via Shape-A triggers, sourced from `plugin_block_data` rows filtered by `plugin_id` instead of a JSON namespace. Plugin-skew passthrough (rows for plugins not installed locally ride round-trip intact) carries over from the JSON-namespace approach since the row exists in core regardless of whether the local plugin is registered.

**Why deferred:** no current plugin needs it. Backlinks fits `edges_json`, scalar-prop plugins fit `properties_json` namespaces, both fine at alpha scale. Pre-user, building it later is approximately the same cost as building it now — the only thing that makes "later" expensive is plugins building workarounds (shoving large payloads into `properties_json` and paying the bandwidth penalty) before the proper surface exists.

**Trigger to build:** a plugin shows up with non-relational, large-or-high-churn payload that doesn't fit `edges_json` (typed-edge model doesn't apply) and would meaningfully hurt other plugins' write bandwidth if it lived in `properties_json`. Examples: rich annotations, embedded media metadata, per-block AI summaries — anything where per-block payload routinely exceeds a few KB and updates independently of block content.

**Migration path** for an existing plugin to graduate into it: backfill rows from the plugin's `properties_json` namespace, switch the plugin's triggers to source from `plugin_block_data` filtered by its `plugin_id`, drop the namespace from `properties_json`. Same per-plugin state-marker pattern as `block_references_backfill_v1`. The plugin's local derived tables don't change shape; only their source-of-truth changes from "JSON subtree" to "row's `payload` column." Bounded, contained, reversible.

**Open decisions** to make at build time (not now):
- Bucket strategy: per-`(workspace_id, plugin_id)` (clean install/uninstall semantics, requires `powersync deploy` per new plugin id) vs. per-`workspace_id` only (simpler ops, clients pull payloads for uninstalled plugins).
- Whether core also provides a generic write API (`tx.setPluginData(blockId, pluginId, payload)`) or each plugin owns its write path.
- Whether `payload` should remain opaque TEXT or be `JSON` (typed) for in-SQL extraction; defaults toward TEXT since plugins already maintain their own indexed local tables and don't need server-side JSON queries.

**Considered and rejected:** generic `block_props(block_id, key, value)` normalization. Read regression on the hot path (every block load aggregates N rows instead of one blob parse) outweighs the bandwidth win at typical prop counts; doesn't unlock new query capabilities beyond what `block_aliases`-style derived tables already provide; and the 1:1 (block, plugin) shape is strictly better for the actual problem since most read paths don't need any plugin's payload at all — and when they do, it's one indexed lookup per plugin, not N rows aggregated per block.

## Data-defined `type-definition` blocks (deferred from type-system v1)

Type-system v1 ([docs/type-system.md](docs/type-system.md)) ships types as facet contributions only — end users who want a new type write a small `extension` block that calls `typesFacet.of({...})`. The dedicated declarative `type-definition` block + property-panel UI for non-coding authors is deferred until there's user demand to remove the "write a tiny extension" friction. Design sketch survives in §9 of the type-system doc: a kernel query `findTypeDefinitionBlocksQuery` mirroring `findExtensionBlocksQuery`, a resolver `userDefinedTypesExtension` symmetric to `dynamicExtensionsExtension`, and a small `appEffect` watching `block_types WHERE type='type-definition'` that calls `refreshAppRuntime()` on change. Explicitly **not** a mutable `FacetRuntime` contribution sink — the immutable-then-rebuild shape is load-bearing (atomic switchover for mutators+processors+schemas, upfront validation, deterministic `combine`, order-independent visibility). **Trigger to build:** real users hit the "to add a new type I have to author code" wall and ask for a UI. Until then, code-extension types are sufficient.

## Data-defined contributions over facets — projector-shim pattern

If the data-defined type-definition block above lands, it sits inside a broader pattern worth applying to other facets: a meta-typed block + a resolver that watches matching blocks and contributes into a facet, with `refreshAppRuntime()` triggering rebuilds. Strong follow-up candidates: **commands / actions** (`actionsFacet` + `actionContextsFacet` — declarative `command-definition` blocks for keybinding-bound macros, generalising what `agent-runtime` already does for AI-callable commands), **saved queries / live searches** (a `query-definition` block riding on the typed-query primitive in §8 of the type-system doc — substrate for agendas, todo inboxes, dashboards), **type templates** (a subtree to materialise on instance creation, declared *on* the type contribution rather than as its own kind), **view templates** (kanban / calendar / table configs that bind type fields to view axes), and **property-schema definitions** (users mint new typed properties via a `schema-definition` block, replacing v1's name-only references). Code-only stays code-only for things with real logic — mutators, kernel queries, post-commit processors, codecs, layout/decorator/click facets, markdown extensions, property *editors* (React components don't compress to declarative blocks), header items, app mounts. Once two or three projectors exist, look for the abstraction (`definitionBlockProjectorFacet` carrying `{metaType, project, targetFacet}` driven by one shared effect) — but **don't extract before the third instance lands**; cheaper to pull from real cases than to design upfront. Sequencing: commands and queries are the highest-leverage next two after the type-system phases, because together they unblock most "Tana-feeling" workflows on top of the type substrate.

## Parallel reads for cold-start contention (PowerSync read pool)

Today every SQL call (read or write) goes through `@powersync/web`'s single `DatabaseClient`, documented at [DatabaseClient.d.ts](node_modules/@powersync/web/lib/src/db/adapters/wa-sqlite/DatabaseClient.d.ts) as *"A single-connection ConnectionPool implementation based on a worker connection."* `readLock` / `writeLock` exist in the API but they all serialize through one Comlink remote. As of `@powersync/web@1.37.2` (the latest at time of writing) there's no read-pool flag in `WebSQLOpenFactoryOptions` — multi-reader support is on PowerSync's roadmap but not shipped.

Cold-start traces show this matters when the page mounts dozens of concurrent reads (one `core.childIds` per visible BlockComponent, one `core.ancestors` per backlink breadcrumb absent batching, etc.) plus a handful of bootstrap writes. With the single-connection serialization the per-read SQL is fast (~1.5 ms each) but the queue wall-clock at the tail of cold start is meaningful: ~140 ms across ~100 reads in the current trace, and writes block reads behind them. Most of that is now amortized by deferring writes to idle and batching reads, but the underlying constraint remains.

**Two paths to add parallelism:**

1. **Wait for upstream PowerSync multi-reader.** Their Rust core could ship a connection pool flag in a future minor; we'd opt in via `WASQLiteOpenFactoryOptions`. Zero engineering on our side, no parallel-adapter maintenance burden. Watch the changelog at major bumps.
2. **Open a parallel WA-SQLite read-only connection alongside PowerSync's worker.** `OPFSCoopSyncVFS` (the VFS we already use) supports multiple cooperative connections via Web Locks; WAL mode lets readers see committed state while a writer is mid-tx. PowerSync's writes commit through its worker; the parallel reader sees the same WAL frames. Trigger-maintained side tables (`block_aliases`, `block_types`, `block_references`, `row_events`) are populated by the writer's connection and visible to the reader.

**Why we don't need PowerSync for the read path specifically.** PowerSync's value is the Rust sync engine (binary-diff replication, conflict resolution, sync-state bookkeeping) plus its `db.watch` reactivity. We don't use the reactivity — we rolled our own via `row_events` triggers + the row-events tail processor. So the *worker that owns the connection* exists for sync, not for reads; bypassing it for reads doesn't lose any feature we depend on.

**Hard parts of path 2.**

- **Schema bootstrap timing.** PowerSync creates the schema lazily on first connect. The parallel reader has to wait for that to finish before opening, or coordinate creation explicitly. Probably "wait for `ensurePowerSyncReady` to resolve" is sufficient.
- **WAL checkpoint coordination.** OPFS coop-sync VFS handles checkpoints via Web Locks — readers get blocked briefly during checkpoint. Usually fine but worth knowing.
- **Worker isolation.** Today PowerSync's connection lives in a dedicated worker so SQL doesn't compete with React render work on the main thread. A parallel reader on the main thread would re-introduce that competition (each read is a wasm boundary cross). The parallel reader probably wants its own worker — now you're maintaining two worker setups.
- **Maintenance burden on PowerSync upgrades.** PowerSync's worker has bookkeeping the parallel reader doesn't share. Future upgrades could subtly break assumptions about WAL state or schema migration timing. Each PowerSync bump becomes a "verify the parallel adapter still matches" task.
- **Test surface.** `createTestDb()` would have to spin up the parallel reader too, or tests would diverge from production behavior in subtle ways.

**Trigger to build.** Estimated 1–2 weeks of careful work for path 2. Worth it only if a future regression makes single-connection serialization the dominant cold-start cost again, *and* path 1 hasn't materialized. Concrete signal: `db.getAll.maxMs` consistently above ~200 ms with `writeTransaction` activity correlated, *and* batching/deferral can't eliminate the contention at the call-site level. Until then: continue cutting reads at the call site (batched queries, prefetch) and writes off the critical path (`scheduleIdle`, fast-path before opening a tx). Re-check PowerSync's changelog at each major version bump.

## Investigate `referencesProcessor.test.ts` schema-swap flake

`src/plugins/references/test/referencesProcessor.test.ts > parseReferences — schema-swap reprojection > removes stale field refs when a property stops being ref-typed` fails intermittently in the full suite but passes in isolation (`yarn test --run src/plugins/references/test/referencesProcessor.test.ts` is green). Observed once during the navigation refactor on master @ cf397f0; my edits don't import any backlinks code, and the failing assertion checks `references_json` for a stale `target-a` ref that should have been removed when the `reviewer` property was retyped away from `block-ref`.

The shape suggests an ordering race: when run alongside the rest of the suite, the property-type cleanup fires before/after the assertion's `vi.waitFor` window in a way that the in-isolation run doesn't trigger. Likely candidates: a shared trigger-flush queue across tests in the same vitest worker, or a `repo.tx` that races with the schema-swap delete. Worth instrumenting next time it fails: dump `references_json` history for `src` plus the `row_events` trail across the swap window. If the pattern matches `cycle-detection-test-flake.md`, the fix may be the same shape (await processor quiescence before asserting).
