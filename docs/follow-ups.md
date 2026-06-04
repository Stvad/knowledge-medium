# Follow-ups

Sorted by priority. **P0** = security/data-loss risk active. **P1** = clear user impact or near-term blocker. **P2** = improvement with a mild trigger present. **P3** = deferred until a measured trigger fires. The "Architectural ideas" section at the bottom holds shapes with no current trigger — they exist so future-us doesn't re-derive the analysis from scratch.

## P0 — Security

### Explicit user enablement for synced extension blocks

Dynamic extension blocks are intentionally powerful: a `type = extension` block is application code, not inert content. Before this ships to shared workspaces, make extension execution opt-in per user. A synced extension block should load as "available but disabled" on a client until that user explicitly enables it.

Fix shape: keep the trust decision outside synced block properties so a collaborator cannot force-enable code for other members. Store an allowlist keyed by `(workspaceId, blockId, contentHash)` in device-local or user-owned settings, and require re-approval when the extension block's source changes. The existing `system:disabled` property can remain an authoring/convenience switch, but it is not a security control because it is synced and editable by workspace writers.

## P1

### React identity contract for extensions

Extensions that render into the app's React tree need to share the host app's React module identity. Today that is partly enforced by externalizing `react` / `react-dom` through the page import map, and partly accidental: Babel's current extension JSX transform emits `React.createElement(...)`, so extension blocks rely on `window.React` unless they import React explicitly.

Fix shape: document React and ReactDOM as host-provided peer dependencies for extension authors and bundled extensions. Bundled extensions must externalize `react`, `react-dom`, `react/jsx-runtime`, and `react/jsx-dev-runtime`, then resolve those from the host environment. Tighten the in-browser compiler so JSX uses an explicit host import (`react/jsx-runtime` or an injected `import React from 'react'`) instead of the global. Keep import-map entries exact where possible, and integrity-pin any CDN-hosted host React modules.

### Tx-bound read guards for reference processors

`core.parseReferences` and `core.cleanupOrphanAliases` now do their expensive reads before opening a write transaction to avoid the PowerSync queue deadlock shape documented in `tasks/processor-tx-deadlock.md`. That leaves two narrow TOCTOU windows: alias ownership can change between "alias missing" and deterministic target creation, and a newly inserted alias target can gain a reference between the orphan precheck and cleanup delete.

Fix shape: add narrow tx-bound read helpers for the final guards, e.g. alias lookup by `(workspaceId, alias)` and "does any block reference this id?", implemented on the `Tx`/`TxImpl` path using the active write-transaction lock context. Keep the broad prefilter reads outside the tx, but re-check inside the tx immediately before creating the fallback alias target or deleting a cleanup candidate. Do not call the bare `ctx.db` from inside `repo.tx`; that reintroduces the queue deadlock.

### CI guard on Postgres ↔ TS schema drift

`scripts/gen-sync-config.ts` keeps the local-SQLite raw-table mapping and the PowerSync sync-stream SELECT in lockstep (both projected from the same `BLOCK_STORAGE_COLUMNS` / `WORKSPACE_*` arrays), but **Postgres is still drift-prone** — someone can edit `BLOCK_STORAGE_COLUMNS` without writing the matching `supabase/migrations/<…>.sql`, and nothing fails until `db push` (or worse, a runtime PATCH that references a missing column). Fix shape: a CI step that calls `npx supabase db query --linked "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('blocks','workspaces','workspace_members')"` and asserts the returned set is a superset of every name in the TS column lists. Costs: needs a Supabase-reachable env in CI (or a checked-in `supabase/schema-snapshot.json` you regenerate via a `yarn snapshot:schema` script and diff against). Lower-effort variant: parse the migration files as text and grep for `add column.*<name>` per TS column — no DB connection needed but misses migrations that drop a column.

### Move agent-runtime tokens from localStorage to user-page blocks

Today (commit `90a9047`) agent tokens live in localStorage keyed by `(userId, workspaceId)`, managed by `AgentTokenStore` in [src/agentRuntime/agentTokens.ts](src/agentRuntime/agentTokens.ts). localStorage isn't actually more secure than a block on the user page — same-origin is the boundary either way — and a block fits the "everything is a block" model better (undoable, exportable, manageable inline on the user page).

Blockers to land first:

1. **A persistent device-local block scope.** Existing `local-ui` is per-session-ephemeral; tokens need persisted-but-non-syncing. New scope must (a) write to OPFS, (b) never enqueue into `ps_crud`, (c) avoid `row_events` if that audit is also gated to local. Add an engine guard so blocks marked `kind=agent-token` can't have their scope upgraded by an `update_block` tx — defends against accidental edits flipping a token into a synced row.
2. **Renderer for `kind: agent-token`.** Read-only display of label + createdAt + a Revoke button. Hide from QuickFind / autocomplete / outline rendering so the user doesn't stumble into them.
3. **Multi-device sanity check.** Confirm that a synced user page on Device B doesn't crash when its child set is partially device-local on A.

Once #1 lands, the migration is small: swap `AgentTokenStore` for a thin wrapper around `repo.tx({scope: DeviceLocal})` + `repo.query.children({parentId: userPage.id, kind: 'agent-token'})`. Bridge handshake and CLI stay identical.

### Reschedule (and similar actions) emit multiple `BlockDefault` txs — one undo entry doesn't cover the whole action

`rescheduleBlock` calls `getOrCreateDailyNote` twice (today + next-review date) before its own `tx.update`, and each of those can open its own `BlockDefault` tx — including a third for `getOrCreateJournalBlock` if the workspace's journal block doesn't exist yet. On a fresh workspace day a single user-perceived "Good" tap is therefore 2–4 entries on the undo stack, and cmd-Z (or the toast's Undo button — same `repo.undo()` target) only reverts the property write, leaving the newly created daily notes / journal page behind. The same shape applies to any action that opens N tx-emitting helpers before its own write — flagged on PR #31, but the daily-note coupling means it surfaces in most SRS first-touches.

Fix shape: thread an optional `Tx` parameter through `getOrCreateDailyNote` / `getOrCreateJournalBlock` so callers that are already inside a tx can co-opt it. `rescheduleBlock` opens one outer `repo.tx`, calls a `getOrCreateDailyNoteInTx(tx, …)` helper for both daily notes, then performs its own update — collapses to a single undo entry. The standalone `repo`-only signature stays as a thin wrapper for the existing call sites (`actions.ts:98,109,141`) so this isn't a forced migration. Slight wrinkle: `getOrCreateDailyNote` reads outside the tx, then opens a new one to write; the in-tx variant has to do its existence check via `tx.get`, which matches the pattern already in `srsBlockDateAdapter.setIso`. Worth doing before any future surface that needs single-entry undo (e.g. "duplicate card with new schedule", calendar drag-to-reschedule).

## P2

### JSONB across the data layer (Postgres column + local SQLite)

`properties_json` and `references_json` are stored as `text` everywhere — Postgres column, PowerSync sync stream, local SQLite. We have ~29 `json_extract` / `json_each` callsites over these columns (including per-write triggers in `src/data/internals/clientSchema.ts` on `$.alias` and `$.types`) that re-parse the whole text blob on every call. Moving to JSONB would walk the binary structure directly — bigger blobs and hotter paths get the bigger win.

Out of scope for the per-key `properties_json` merge work (`docs/field-level-sync-merge.md`) because (a) the correctness fix doesn't need it — server-side `text::jsonb || $set::jsonb - $unset` cast costs microseconds per write and is fine — and (b) the migration has a real rollout-compat problem worth handling in isolation: old in-the-wild clients call `JSON.stringify(properties)` in `blockToRowParams` (`blockSchema.ts:222-228`) and the uploader forwards that string to PostgREST; a string body landing in a `jsonb` column is stored as a JSONB *string scalar*, not as the object, and subsequent jsonb operations either fail or return the wrong shape.

Fix shape, when triggered: bundle Postgres column migration with the client uploader change that sends objects/arrays instead of strings, and a defensive server-side normalization for inflight stringified writes during the rollout window (`CASE WHEN jsonb_typeof(properties_json) = 'string' THEN properties_json #>> '{}' ELSE properties_json END`). Re-create `idx_blocks_workspace_with_references` with the jsonb predicate (`references_json <> '[]'::jsonb`). On the local side: confirm wa-sqlite (PowerSync's bundled SQLite) supports SQLite 3.45+ JSONB; wrap each `SELECT properties_json` in `json(properties_json)` so the JS driver still gets text (cheap unwrap, no re-parse); change pull-down `put` SQL in `BLOCKS_RAW_TABLE` to `jsonb(?)` for the JSON columns; verify the shape of `CrudEntry.previousValues.properties_json` when the column is JSONB (likely needs a `json()` decode somewhere). Benchmark on a representative block count (the import-heavy DB is a good baseline) before committing — the win has to be measured, not assumed.

### Reduce per-block flicker on lazy hierarchical loads

`useChildIds` is backed by `repo.childIds` which hydrates the whole children list per parent on first read. That keeps the per-parent expand path fast, but as the user scrolls into deeper levels their grandchildren still load on `LazyBlockComponent` mount and visibly pop in. Standard fixes worth considering when this becomes noticeable:

- **Skeleton with structural shape**: render a bullet at the right indent depth (data the parent already has) inside the LazyBlockComponent placeholder instead of the bare 32px `<div>`. Real content slots into the same shape rather than appearing from nothing — most of the perceived "pop" is the bullet + indent appearing, not the text.
- **`useTransition` around expand toggles**: `startTransition`-wrap the `setIsCollapsed` write so React keeps showing the previous tree until the new descendant Suspense boundaries resolve, instead of flashing fallbacks during the load window.
- **Tighter overscan / prefetch**: bump `OVERSCAN_PX` in `LazyBlockComponent` or have `BlockChildren` warm a few levels of `repo.childIds` ahead of intersection, so by the time a row mounts its data is already in cache.

Cheap wins first (skeleton + maybe overscan); reach for `useTransition` if it still feels jumpy.

### Periodic `row_events` trim

`row_events` is the per-row audit + invalidation log. Trigger-written, never trimmed — it grew to 262 MB / 304k rows on the import-heavy DB. The fast path doesn't need history; the row_events tail consumes by ascending `id` and only needs rows newer than its high-watermark. Long-tail entries are dead weight on disk and on backup/export.

Fix shape: at startup (or on a low-priority idle hook), `DELETE FROM row_events WHERE id < (MAX(id) - K)` for some K (e.g. 50 000), or `WHERE created_at < ?` with a 7-day window. Either runs in one statement and the index on `id` is the auto PK. Optional: bound `command_events` with the same shape (4 403 rows, ~negligible today, but the same unbounded shape).

Note: PowerSync's CRUD-apply path still writes a row_event per sync write, so even a fully-synced read-only client will accumulate. Worth doing.

### Drop unflushed `ps_crud` for local-only mode (and reduce import bloat)

`ps_crud` is PowerSync's outgoing upload queue. The Roam import (run with `source='user'`) enqueued 304k rows ≈ 204 MB. If the user runs in `localOnly` mode (no remote sync) those entries can never drain; if remote sync is on but the import was massive, the queue still bloats local storage until it drains.

Two angles:

- **Cleanup option** — when `localOnly` is active, expose a `discardPendingUploads()` action that truncates `ps_crud` (PowerSync's API may have a helper for this; otherwise raw `DELETE FROM ps_crud` is fine since nothing reads it locally). Frees ~200 MB on this DB.
- **Don't enqueue during import in the first place** — the upload trigger gates on `tx_context.source = 'user'`. Adding a fourth source value `'import'` (or letting the import set source to `'local-ephemeral'` with a temporary scope override) keeps the row_events audit happy while skipping `ps_crud`. Cleanest variant: add `'import'` source, both `row_events` and upload triggers learn to ignore it. The Roam import wraps its txs with `source: 'import'`. Then both `row_events` AND `ps_crud` stay small even on bulk import. Less-clean variant: drop the upload trigger before import, recreate after.

The "don't enqueue" path also helps the `row_events` problem above — an `'import'` source that skips row_events trims an additional ~250 MB of audit-log bloat from the import.

### Strict-mode-with-checked-overrides for name-keyed facets

Every name-keyed facet in the codebase (`propertySchemasFacet`, `propertyUiFacet`, `postCommitProcessorsFacet`, `queriesFacet`, `mutatorsFacet`, `typesFacet`, `blockLayoutFacet`, etc.) follows the same convention: warn on duplicate name, last-wins. That's the existing override mechanism — plugins replace kernel registrations by registering after them. It works, but the warn is easy to miss in practice and accidental name collisions silently overwrite intended behavior.

A stricter scheme: registrations may opt into a checked override target — `propertySchemasFacet.of(statusPropV2, {source: 'my-plugin', overrides: 'status'})`. Combine asserts that an entry under `overrides` exists; if absent, throw (catches typos). If present, replace silently (intent declared, no warn). Without `overrides`, any duplicate-name collision throws (catches accidents). That gives strict mode + intentional override + typo catch in one shape.

Apply uniformly across every name-keyed facet — the convention should be consistent. ~10 lines per facet's combine.

**Trigger to build:** plugin authors stepping on each other's schema / mutator / processor names in the wild and the warn-and-last-wins not catching it in code review. Until then, the existing convention works for the alpha-stage plugin surface and the [docs/type-system.md §1a](docs/type-system.md) schema-lift handles the most acute case (object-identity dedup for multi-type-shared schemas means the warn fires only on real conflicts).

### Route swipe-quick-action invocation through the dispatcher

`SwipeActionMenu.handleRun` calls `action.handler({block, uiStateBlock}, trigger)` directly — bypassing `useRunAction` / `runActionById`. The rationale is mobile-pragmatic: the swipe gesture targets blocks regardless of which one (if any) is currently focused, so requiring the action's declared context to be active upfront would mean the menu couldn't expose NORMAL_MODE actions on a non-focused block. Manufacturing `{block, uiStateBlock}` deps and invoking the handler lets the same primary-row items (copy, delete, etc.) work without first promoting the swiped block into focus.

The cost surfaces when a handler doesn't just operate on its deps — when it opens UI that itself reads `useActiveContextsState`. The command palette is the canary: its action list is filtered by the currently-active context map, not by whatever deps got handed to a handler. So a "open palette for this block" quick action can't just dispatch the toggle event; it has to first make the swiped block the focused-and-not-editing block so NORMAL_MODE for it activates and the palette lists block-context actions for it. That dance lives inline in `commandPaletteForBlockAction.handler` (`await focusBlock(uiStateBlock, block.id)` before dispatching the toggle). It works, but every future "quick action that opens a context-aware UI" will need an analogous dance, and forgetting it produces a degraded-but-not-broken palette ("why does my action not show up?") that's easy to miss in review.

Fix shape: have `handleRun` route through the dispatcher for actions whose `context` is not `GLOBAL`. The contract becomes "before invoking the handler, make this block the active one for `action.context`" — for NORMAL_MODE that means `focusBlock(uiStateBlock, block.id)` (or the broader `activateBlockNormalMode` if we add it; see the selection-clearing note in #4 above), then `runActionById(actionId, trigger)`. GLOBAL actions still pass through unchanged. The trade-off: every NORMAL_MODE action invoked from the swipe menu now flips the global focus to its target block as a side effect — desirable for the palette case, possibly surprising for "Copy" (a swipe on an unfocused block would now leave focus on that block after copying). Likely acceptable since the swipe-menu UX already implies "operate on this block," but worth confirming with a UX pass.

Lower-effort variant: leave the direct-call pattern, but lift the focus dance into a helper that the action author opts into (e.g. `runWithBlockContext(deps, action)`) so the pattern is named and discoverable rather than retyped at each site. Doesn't centralize the invariant but at least flags the requirement.

Originally surfaced while debugging codex-flagged P2s on PR #21 (palette quick-action race + edit-mode latch). The handler-level workaround landed; this is the architectural cleanup.

### Semantic action groups for decorator targets

SRS and Readwise both want to intercept the same user intent — "mark this block as complete/reviewed" — across three concrete actions: `todo.cycle`, `edit.cm.todo.cycle`, and `block.swipe-right`. Today each plugin contributes three decorators. That is locally simple and matches the current `actionDecoratorsFacet` contract, but it leaks the physical action list into every plugin that wants to specialize the semantic behavior.

Important distinction: the todo actions already delegate to one implementation function (`cycleTodoState`), but decorators do not wrap implementation calls. They wrap registered `ActionConfig` records by exact `action.id` plus optional context. So "decorate only todo cycle" would miss edit-mode and swipe-right unless those actions stopped being distinct action records.

Explore adding semantic grouping metadata to actions, e.g. `groups: ['block.primary-complete']`, and letting decorators target a group as well as an id. Todo would mark all three concrete actions with the group; SRS/Readwise would contribute one group decorator that checks the block type and either consumes the action or falls through. Keep group membership as metadata during `getEffectiveActions` expansion — not a dispatch alias — so `block.swipe-right` remains a gesture-owned action and the swipe menu does not have to route through keyboard active-context dispatch.

Questions to answer before building:

- Does `ActionDecorator` grow `groupId?: string`, or do actions expose `aliases?: readonly string[]` and decorators keep the single `actionId` field?
- What is the ordering rule when both id-targeted and group-targeted decorators match the same action? Preserve contribution order if possible.
- Should group decorators optionally constrain context, same as id decorators do today?
- How should command palette / shortcut settings display grouped semantics without hiding the concrete action id that the user binds?
- Is this worth a runtime semantic change, or is a helper like `decorateActions([ids...], factory)` enough until a third plugin needs the same pattern?

Acceptance for the exploration: produce a small design note or spike with tests around `getEffectiveActions`, compare it against the helper-only option, and only then migrate SRS/Readwise. Avoid making `block.swipe-right` delegate to `todo.cycle`; that would blur gesture deps with active keyboard contexts and make swipe behavior harder to reason about.

### Schema-rename does not cascade — instance values orphan on rename

When a user renames a `property-schema` block (editing `property-schema:name` via `PropertySchemaBlockRenderer`), the schema republishes under the new name but every instance block's `properties_json` is still keyed by the OLD name. The old name has values but no schema; the new name has a schema but no values. The renamed property silently disappears from the UI.

Surfaced inline during the user-defined-types Phase 1 design review while pushing back on the rename-safety argument for block-id refs in `block-type:properties`: that argument keeps the type→schema pointer stable, but the instance values are already broken at a lower level.

Two viable fixes:

- **Cascade-rename**: on schema name change, walk every block where `properties_json` has the old key and rewrite the key to the new name in one tx. Surgical; no data-model change. Costs: high-fanout schemas (e.g. renaming `status` when 50K blocks have it) rewrite a lot of rows under PowerSync's serialized writer; conflict resolution mid-rename has to handle blocks that transiently carry both keys.
- **Block-id keying**: `properties_json` keys become schema block-ids instead of names. Renames become free at the value layer (label decoupled from identity). Requires solving "what's the block-id for a kernel/plugin schema?" (see the block-id keying entry below) and a one-time migration of every existing `properties_json` blob. Reads stay 1× Map.get — no per-read indirection vs today.

The user is currently leaning toward **block-id keying as the destination** (per the user-defined-types design review session) because it composes with the same "id-stable handle" decision already made for types and resolves the rename problem cleanly for every consumer at once. Cascade-rename remains a viable interim step that doesn't paint into a corner.

## P3 — Deferred until trigger fires

### Consider DB/query revisioning if dirty-load handle semantics become hard to reason about

`LoaderHandle` now treats in-flight loads that observe a matching invalidation as dirty for subscriber publication: the dirty result may still satisfy the original `load()` promise and update the internal cache, but subscribers rebuild only from the clean follow-up reload. This is intentionally conservative and cheap.

Longer-term correctness shape, if this area keeps producing edge cases: add a monotonic DB/query revision model. Every local commit and row-events-tail apply advances a revision; query loads carry the revision they read; handles publish only results whose read revision is at least the latest matching invalidation revision. That would make freshness explicit and could avoid redundant dirty reloads when a load is provably already fresh. Costs: thread revision accounting through repo txs, sync-applied invalidations, query loaders, and tests; dynamic deps still need the existing "changes during load" queue unless queries can declare every relevant dep before SQL. Do this only if the dirty-load generation model becomes ambiguous in practice.

### Inverted dep-index in `HandleStore.invalidate` — re-evaluate with live metrics

[handleStore.ts:306](src/data/internals/handleStore.ts:306) still walks every registered handle linearly on each invalidate, then walks every dep of each candidate inside `matches()`. perf-baseline's #1 open recommendation. Two follow-ups landed already to soften the symptom without changing the shape:
- Per-handle dedup at `ctx.depend` registration (commit `62e913cf`) — drops within-resolve duplicates; manyAncestors saw 26% fewer deps live (99 instead of 133).
- `repo.metrics().handleStoreInventory` (commit `1b4e8937`) — exposes `handleCount`, `totalDeps`, `maxDeps`, `p50/p95Deps`, `topHeavy[]` so the next investigation doesn't start from a devtools eval.

**Why this might be worth doing sooner than the headline numbers suggest:** many minor UI interactions are db writes — selection changes, expand/collapse, property-panel toggle, focus moves. The perf-baseline framed write latency as a per-keystroke concern, but the cumulative cost across high-frequency UI interactions is what users actually feel. Sub-ms per walk × 100 writes/sec during scroll/drag is real. The 10-20ms band of savings the user flagged is meaningful at that frequency.

Index shape, when it's time:
- `Map<bucketKey, Set<RegisteredHandle>>` keyed per dep kind:
  - `row:<id>`, `pe:<parentId>`, `ws:<workspaceId>`, `tbl:<table>`
  - `p:<channel>\x00<key>` for plugin deps (today's hottest family in our workload — 55% of all live deps)
- Maintained inline in `onDep` (add to bucket) and `dispose` (remove from all buckets). Live workload shows row + plugin are the only families that matter; workspace + table are empty.
- **Bucket-membership-is-sufficient**: a handle is in `buckets[k]` iff one of its deps would match a change targeting `k`. At invalidate time, union the buckets the change touches and invalidate every handle in the union — *no* `matches()` confirmation pass needed. This is the real win: skips the per-dep walk inside `matches()` that currently dominates for fat handles (property-schema watcher at 385 deps, grouped-backlinks at 200+).

Triggers to re-check (now measurable in `repo.metrics()`):
- `handlesWalked / invalidations` ratio exceeds ~200 in real sessions
- `handleStoreInventory.handleCount` materially above ~500 during normal use
- `handleStoreInventory.maxDeps` over ~1000, or `p95Deps` growing toward the max
- `mutate.setContent` p95 / per-tx-flush time visibly degrading in `repo.metrics().db.writeTransaction` p95
- a flame graph of a scroll / drag / multi-select interaction shows `invalidate()` or `matches()` on the critical path

Correctness surface to be careful about:
- `runLoader` dep-replacement on settle ([handleStore.ts:520](src/data/internals/handleStore.ts:520)) needs to diff old vs new and patch buckets atomically — dropped entries are how "things stop refreshing sometimes" bugs land.
- Mid-load live-publish ([handleStore.ts:506](src/data/internals/handleStore.ts:506)) must update buckets in the same step as `this.deps.push`.
- `dispose` must remove from every bucket the handle was in.
- `observeDuringLoad` ([handleStore.ts:341](src/data/internals/handleStore.ts:341)) currently walks all handles regardless of matching — add a sibling `Set<RegisteredHandle> inflightHandles` so it becomes `O(inflight)` instead of `O(N)`. Independent change but same theme.

Verify-via-bench: [scripts/bench/bench-handles.ts:43](scripts/bench/bench-handles.ts:43) already has the `(N=…, 1 match)` and `mutate.setContent with M bystanders` rows — drive both to constant time as the acceptance criterion.

### Id-only collection handles for `subtree` / `ancestors` / `backlinks`

`repo.childIds(id)` was added alongside `repo.children(id)` to give callers that only need the structural list a handle whose only dep is `parent-edge` — child property updates don't invalidate it, and the loader is a lighter `SELECT id` query. `useChildIds` and `useHasChildren` were rewritten on top of it; the symptom that motivated the split was an UI-state child mutation cascading a `useChildren`-driven re-render through `LayoutRenderer`.

The same id-only shape would work for the other three list-handle factories in `Repo` (`subtree`, `ancestors`, `backlinks`) for the same reason: their React consumers all use `Block` facades for per-row reactivity, so the per-id `row` deps the handles currently declare are redundant — the row-grain subscriptions on each Block already cover content updates. But the leverage drops sharply:
- `subtreeIds` — same shape of win in principle (row dep × many descendants), but no current hot consumer. Probably worth waiting for an actual callsite.
- `ancestorIds` — Breadcrumbs is the only consumer; chains are typically O(depth) shallow and the breadcrumb labels need block content anyway.
- `backlinkIds` — Backlinks UI also renders each backlink's content; row deps are bounded by the backlinks list size.

Add when a measured hot path appears, not preemptively. Phase 4's `queriesFacet` (per `tasks/data-layer-redesign.md` §13.4) is the canonical place for these — `repo.childIds` will migrate alongside `repo.children` to `repo.query.childIds` with no callsite changes downstream of the hooks.

### Single-key binding shadowing a co-active sequence chord — surface as a keybinding conflict

The single-winner coordinator (`HotkeyReconciler`) feeds each candidate its own tinykeys matcher, then orders the set that completed *this* event through `resolve(...)` by context tier → priority → recency. Chord *length* is not a factor. So if a single-key binding is a prefix of a sequence in a co-active context — say a plugin binds `g` while vim normal mode keeps `g g` — both matchers complete on the second `g`, and the prefix can out-rank the sequence by context, so `g g` never fires. (Raised as a P2 by Codex on PR #103.)

Not a resolver fix, for two reasons: (1) a "prefer the longer chord" tiebreak would have to rank *below* the modal/global tiers — a modal that binds `g` must still beat a background `g g` ("modal owns all chords"), so length can't be a top-level rule in the one comparator everything routes through; (2) the single-key prefix fires on the *first* press regardless (its matcher completes immediately), so even a perfect press-2 tiebreak can't undo the press-1 dispatch. The situation is fundamentally a misconfiguration — a single key racing a sequence it prefixes — which the conflict detector is the right place to catch.

Fix shape: extend `keybindingConflicts.ts` (which already buckets chords via the Phase-0 canonical key and warns on collisions) to also flag "binding X is a strict prefix of sequence Y in an overlapping context" as an intentional-shadow-style warning, so the author sees it in shortcut settings rather than discovering a dead sequence at runtime. Needs the sequence-aware `parseChord` (already landed in Phase 0) to compare press lists, not just the atomic key.

Not reachable today: the repo has exactly one sequence binding (`g g`, vim normal mode) and no single-key `g` binding in any context, so no prefix/sequence collision exists. Build it when a real one appears (or when the conflict-UI work in the plan's "Opportunistic" section gets picked up).

### `rendererProp` silently no-ops on a misspelled renderer id

[useRenderer](src/hooks/useRendererRegistry.tsx:26) reads `rendererProp` and only honors it via `if (rendererKey && registry[rendererKey])` — when the prop names a renderer id that isn't registered (typo, plugin not loaded, renderer renamed), the lookup silently fails and resolution falls through to the `canRender` predicate sort. The user's explicit override is lost with no signal.

Fix shape: when `rendererKey` is set but absent from the registry, `console.warn` with the offending id + the available ids, and either (a) render `MissingDataRenderer`-style "renderer not found" placeholder so the lost override is visible, or (b) fall through with the warning. Pick (b) for now — less disruptive — but at least surface it. Independent of any larger renderer-resolution redesign; cheap fix.

### Tighten render-surface model — enum + ideas from `renderer-resolution.md`

The current render-surface model on `BlockContextType` ([src/types.ts:79](src/types.ts:79)) is an open flag bag: `isNestedSurface` (umbrella) + specific descriptors `isEmbedded` / `isBacklink` / `isBreadcrumb`, set by each non-document mount and consulted via `useIsFocalRender(block)` / `isFocalRender(ctx)` ([src/hooks/useIsFocalRender.ts](src/hooks/useIsFocalRender.ts)). This shape was picked as the smaller initial fix for the embed-of-focal-block bug ([docs/render-surface-vs-flags.html](render-surface-vs-flags.html) Option D + C) — it composes in nested cases, doesn't require a closed union, and adding a new surface only means setting the umbrella.

Tighter shape worth considering when a third surface lands or when the open flag bag bites: replace the umbrella+descriptor flags with a single `renderSurface: 'document' | 'embed' | 'backlink' | 'breadcrumb'` enum (Option B in the design doc). Pros: real type-system enforcement on the surface set, mutually-exclusive states modeled as mutually exclusive, surfaces discoverable by reading a union rather than greping setters. Cons: closed set requires amending the union when a new surface lands, and nested cases (a backlink containing an embed) collapse to innermost-wins rather than composing. The composition concern is theoretical today — none of the five focal-affordance sites discriminates outer surface.

[docs/renderer-resolution.md](renderer-resolution.md) is currently *not* on the roadmap, but it has adjacent ideas worth pulling in if/when this gets revisited:
- The **mount site already knows** insight — `BlockEmbed` deciding "I'm an embed" at the mount site is the same shape as the doc's `frame` prop on `BlockComponent`. If the enum migration happens, passing `renderSurface` (or a frame slot) as an explicit `BlockComponent` prop is more honest than the current context-override sandwich.
- **Separating dispatch metadata from React component identity** — the static-field `canRender` / `priority` shape on renderer components ([TopLevelRenderer.canRender](src/components/renderer/TopLevelRenderer.tsx), etc.) is the same legibility problem this redesign solves at the context-flag layer. Worth doing together if either gets touched.
- **Explainability / reason chains** — orthogonal to surfaces but cheap to bolt on once dispatch metadata is structured.

Trigger to revisit: a fourth render surface shows up (preview pane, sidebar peek), OR the flag-bag's open-set ergonomics produces a real bug (someone forgets to set `isNestedSurface` on a new mount).

### Block-id keying for `properties_json` + kernel-schemas-as-blocks

Companion to the schema-rename follow-up above. The longer-term direction is to key `properties_json` by the schema block's id rather than its name. That removes rename fragility everywhere properties are stored or referenced, and lines up with the user-defined-types "type id = block id" decision.

Open sub-questions to resolve before committing:

- **Kernel/plugin schemas without backing blocks.** Today `defineProperty` calls in code don't materialize a block. For block-id keying to work uniformly, kernel/plugin schemas need either:
  - **Synthetic deterministic ids** — `uuid-v5(kernel:status)` etc. The runtime resolves them through a registry without persisting a row. Lowest cost, keeps source-of-truth in code.
  - **Full materialization** — bootstrap a property-schema block per kernel/plugin schema per workspace. Composes with all block-based machinery (sync, history, future overrides), but moves source-of-truth from code to data and raises plugin-unload lifecycle questions ("does the orphan block stay?"). Per-workspace storage cost scales with kernel-schema growth × workspace count.
  - The middle path that doesn't lock either choice: ship synthetic ids now; the same id space can later back real materialized blocks if a use case emerges.
- **Migration cost.** Every existing `properties_json` blob needs rekeying. Doable as a one-shot pass at workspace open; safety-net by versioning the workspace so old clients don't write back with name keys.
- **DB readability.** Raw `properties_json` becomes opaque to humans (`{"a3f9-…": "open"}` instead of `{"status": "open"}`). Debug-only friction; mitigate with a tooling pretty-printer that resolves ids via the schemas table.
- **Properties-as-blocks (Tana-style) is a different question, not this one.** Tana-style means each VALUE is a block — different shape, real per-read indirection. Block-id keying just renames the JSON keys; reads stay 1× Map.get. Worth keeping these separate when discussing.

Acceptance for landing this:
1. Kernel/plugin schemas resolve through the same `getSchemaForBlockId` path as user schemas (synthetic or materialized — pick one).
2. `block-type:properties` refs work uniformly across all schema kinds, replacing the current Phase-1 "hide kernel schemas in the picker" workaround in `BlockTypeBlockRenderer`.
3. `properties_json` migration runs once at workspace open; idempotent.
4. The schema-rename follow-up above is satisfied as a side effect (renames touch labels, never keys).

### Investigate `referencesProcessor.test.ts` schema-swap flake

`src/plugins/references/test/referencesProcessor.test.ts > parseReferences — schema-swap reprojection > removes stale field refs when a property stops being ref-typed` fails intermittently in the full suite but passes in isolation (`yarn test --run src/plugins/references/test/referencesProcessor.test.ts` is green). Observed once during the navigation refactor on master @ cf397f0; my edits don't import any backlinks code, and the failing assertion checks `references_json` for a stale `target-a` ref that should have been removed when the `reviewer` property was retyped away from `block-ref`.

The shape suggests an ordering race: when run alongside the rest of the suite, the property-type cleanup fires before/after the assertion's `vi.waitFor` window in a way that the in-isolation run doesn't trigger. Likely candidates: a shared trigger-flush queue across tests in the same vitest worker, or a `repo.tx` that races with the schema-swap delete. Worth instrumenting next time it fails: dump `references_json` history for `src` plus the `row_events` trail across the swap window. If the pattern matches `cycle-detection-test-flake.md`, the fix may be the same shape (await processor quiescence before asserting).

### Legacy alias-seat cleanup tombstones — leave in place

Audited 2026-05-26 on `ff-vlad-dev` (workspace `4bb3ac62-0487-4586-bee4-6a5f28003899`): 424 tombstoned alias seats match the exact restorability predicate the probe now uses (pristine seed shape, `content === alias[0]`, no live children, no inbound `block_references`). Worst-offender prefix: `browser em` at 20 tombstones — accumulated en route to typing `[[browser emacs]]`. The full table:

| prefix | tombstones |
|---|---:|
| `browser em` | 20 |
| `browse` | 9 |
| `brow` | 9 |
| `toda` | 8 |
| `tod` | 8 |
| `wcs/` | 7 |
| `browser ` | 6 |
| `bro` | 5 |
| (… long tail …) | |

The probe change in [targets.ts](src/data/targets.ts) restores pristine tombstones in place on retype, so future buildups self-limit at the active-slot level. But the probe only ever lands on the *first* matching slot — the rest of each alias chain (e.g. slots 1-19 of `browser em`) stays tombstoned forever, since the probe never reaches them. Storage cost is ~85 KB local + same on server; cleanup would mean destructive SQL on Supabase (hard-deletes don't sync; [clientSchema.ts:319-323](src/data/internals/clientSchema.ts:319)).

Triggers to revisit:
- New-device initial sync feels slow because of inert tombstones in the bucket.
- Tombstone count climbs orders of magnitude beyond today's ~425.
- Doing a generic "compact this workspace" pass for unrelated reasons (e.g. the `row_events` trim above) and it's cheap to fold in.

The lift if you do it: lift the predicate from `isRestorableTransientTombstone` into a Postgres-shaped `DELETE FROM public.blocks WHERE …` (per-workspace scope advisable on a multi-tenant project). Predicate is *exactly* the restorability check, so the same correctness argument applies — only rows the probe would otherwise resurrect get purged. Related: [[Mark transient alias-seat cleanup tombstones explicitly]] below — if Option B ever lands, the audit becomes "purge where marker present" instead of shape-matching.

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

## Explicit typed events for state changes (event-sourcing discipline)

Today every state change goes through `repo.tx` → kernel mutators → row writes on `blocks`. `command_events.mutator_calls` records the mutator-name + args per tx, which is morally close to an event log but not enforced: a mutator body is free to read state and call `tx.update(...)` based on what it sees, so the recorded `mutator_calls` row is not guaranteed to be a *replayable* description of the change. The row write is the truth; the call record is a hint.

**Discipline shift:** treat every state change as a named, typed event. The mutator becomes a pure function `(event-args, current-state) → row writes` — i.e. a materializer. The recorded `mutator_calls` row is then a complete, replayable description of the change.

**Why this is worth flagging now:**

- **PITR / time-travel feature** ([discussed in this thread, see also the local-only PITR work on `row_events`]): row-state history reconstructs *what* a block looked like at time T but not *what operation* produced that state. Typed events give the operation back. "I see a deletion at 3pm — what command issued it?" becomes a direct lookup instead of inferred from diffs.
- **Cross-device history (sidecar `block_events` table):** clients can push their `command_events` upstream to give every device a uniform global event stream, without going to a full LiveStore-style event-sourced sync. The richness of what's worth pushing is bounded by how disciplined the mutator surface is — diffuse "do-whatever" mutators don't compress to useful events.
- **Future architectural optionality:** if event-sourced sync ever becomes the right answer (per-edit cross-device history, deterministic conflict resolution), the migration cost scales with how close mutators already are to materializers. Tightening them now lowers that cost for free; doing it under pressure later is expensive.
- **Testability / clarity** as standalone wins: an event whose effect is `(args, state) → writes` is dramatically easier to test, audit, and reason about than an opaque mutator body.

**Why deferred:** no current feature *requires* this; the existing mutator surface works. The shift is mostly invisible from outside the data layer. It's a refactoring direction, not a feature.

**Trigger to build:** (a) PITR UI lands and people start asking "what command did this?" not just "what state was this?", (b) a serious sidecar event-stream feature is on the table, (c) the next time the mutator surface is being reworked for another reason and the cost of doing this alongside is marginal, or (d) we're seriously evaluating an event-sourced sync engine and want to know how close we already are.

**Adjacent direction:** if pursued, the natural next refactor is making `mutator_calls` the audit primary key instead of `row_events`. `row_events` becomes a derived index for fast row-state reconstruction; `command_events` carries the user-meaningful operation log. Pruning policies on each can then be independent.

## Generic "move type" / "move property" primitive

SRS now has a dedicated cut/paste swipe action ([src/plugins/srs-rescheduling/moveSrsState.ts](src/plugins/srs-rescheduling/moveSrsState.ts) + [srsClipboard.ts](src/plugins/srs-rescheduling/srsClipboard.ts), wired through `srs.cut` / `srs.paste` in [index.ts](src/plugins/srs-rescheduling/index.ts)). The shape generalises: every `TypeContribution` declares its own field list via `properties` ([src/data/api/blockType.ts](src/data/api/blockType.ts)), so a kernel-or-shared-util "move type with fields" operation could subsume the SRS case once a second caller appears.

Sketch:

```ts
// Plugin- or kernel-land; the only piece that needs the type registry
// is enumerating `TypeContribution.properties`.
moveTypeInTx(tx, { typeId, sourceId, targetId, mode: 'move' | 'copy' })
```

Semantics, drawn from the SRS implementation:

- Enumerate the type's declared property schemas; copy each encoded value present on source into target.
- Add the type to target if absent. Clear any target field that the type declares but source did not set, so target ends with exactly source's state (move-not-merge).
- On `mode: 'move'`, remove the type from source and delete each declared property — *but only if no other type still on source declares that property* (the collision rule SRS gets for free because it owns its field namespace; the generic version doesn't).
- Don't run `TypeContribution.setup` on the target — values are transplanted verbatim, not freshly initialised.
- Skip if `sourceId === targetId` or source lacks the type.

Likely callers after SRS: `todo` (move a task's done/snoozed state between blocks), any future structured-data type. A generic primitive only earns its keep once one of those actually wants it — the SRS-only path was deliberately picked to validate the cut/paste UX before paying the generic-API tax. The bigger open question is whether "move type" is even the right framing for the second caller, or whether they want "swap state between these two blocks" instead.

A "move property" primitive (one field, no type) is intentionally **not** part of this — a property usually exists because some type put it there, and moving it without the type leaves the target with an orphan field that nothing renders or interprets. Hold off until a real free-floating-annotation case shows up.

Where the work lives is also a decision deferred to that point. The `mutatorsFacet` path ([src/data/facets.ts](src/data/facets.ts)) is preferred over a `Repo` method if it can read the type registry from extension context — that keeps it plugin-contributable rather than baking another type-aware operation into the kernel. The current `repo.addTypeInTx` / `repo.removeTypeInTx` are kernel methods only because they need privileged registry access, but a `moveType` mutator could just compose them.

UX: the SRS cut/paste swipe pattern (per-type actions filtered by `QuickActionItem.canRun`) is the working model. For multiple types coexisting on a block, do not build a generic "which type to cut?" submenu — register `<type>.cut` / `<type>.paste` action pairs per contributing plugin and let the canRun filter sort visibility. This is what the SRS implementation already does for itself.

## Mark transient alias-seat cleanup tombstones explicitly

Today the probe in [src/data/targets.ts](src/data/targets.ts) decides whether to restore a tombstoned alias seat by comparing its `(content, properties)` against `aliasSeatSeed(alias)` and rejecting any row with live children. Shared `aliasSeatSeed` + a drift-detection test (`ensureAliasTarget writes the seed shape`) keeps writer and matcher in lockstep, but the predicate is still inferring intent from the row shape after the fact.

The alternative is to have `cleanupOrphanAliasesProcessor` stamp an explicit synced marker (e.g. a `system:transient-seat: true` property) on the seat *before* soft-deleting. The probe predicate then collapses to "tombstoned + marker present"; `ensureAliasTarget`'s restore path strips the marker so a touched-then-tombstoned seat never carries it. Drift between writer shape and the restorability predicate becomes irrelevant — cleanup's positive intent is the contract.

Tradeoffs: adds one synced property + a codec entry; one row_events / ps_crud write per cleanup tombstone (cheap, but non-zero); requires backfilling existing tombstones if we want them restored too (the seed-shape predicate covers them today — all 435 in the audited DB match it). Pick this up only if (a) the shape predicate starts producing false negatives in practice (e.g. PAGE_TYPE's default props grow and the seed gets harder to keep in sync), or (b) a second seat-with-cleanup domain shows up and we'd rather not generalise the seed pattern across both.
