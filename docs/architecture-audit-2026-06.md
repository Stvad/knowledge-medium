# Architecture audit — June 2026

Multi-agent audit of the full codebase (~150k lines of TS): 10 parallel subsystem
mappers, a 14-document design-docs digest (so already-decided/rejected ideas were
excluded), 6 cross-cutting analysis lenses (layering, god objects, duplication,
redundant mechanisms, state coherence, write-path), dedup/ranking to the top 12
findings, then one adversarial verifier per finding with instructions to refute.
**10 findings survived verification; 2 were killed.** Every file/line/count below
was checked against the working tree by the verifier pass (2026-06-11/12).

Overall: the codebase is unusually deliberate — heavily commented with design-spec
references, well tested, and most "weirdness" traces to a documented decision. The
real architectural debt concentrates in five clusters: **(A)** every keystroke pays
for machinery nothing reads, **(B)** the extension runtime compensates for its own
replace-the-world semantics in four places, **(C)** three boundaries exist on paper
but not in imports, **(D)** two god modules bundle separable engines, and **(E)** an
untyped event bus grew beside the typed mechanisms.

---

## A. Write-path: every keystroke pays for machinery nothing reads

### A1. `row_events` doubles every local write and has zero runtime readers
*(write-path lens · confirms/extends the known issue in docs/row-events-retention.md)*

- **Files:** `src/data/internals/clientSchema.ts:384-442`, `src/sync/observer/invalidate.ts`
- The three `row_events` triggers write full before+after row JSON (re-embedding
  `properties_json`/`references_json`) on every `blocks` write. Its original consumer
  (`rowEventsTail.ts`, the sync invalidation tail) was deleted 2026-05-29 (commit
  588937cd) — `sync/observer/invalidate.ts` now feeds materialized snapshots straight
  into `BlockCache.applyFromSync` + `handleStore`. Grep confirms zero runtime readers;
  every other mention is a comment. Each keystroke commit currently pays: `blocks`
  UPDATE + `row_events` full-row INSERT + `ps_crud` envelope + FTS delete/insert +
  `command_events` INSERT.
- **Proposal:** ship the startup high-watermark DELETE; consider dropping
  `before_json` from the hot trigger **except** for local-only workspaces, where
  `row_events` IS the history (synced workspaces have server-side `blocks_history`).
  Compact, never silently drop — name the recovery path in the migration.
- **Payoff:** roughly halves local write volume/storage growth per edit (the known
  262MB/304k-row pathology) and shrinks write-lock hold time per commit.
- **Owner correction (2026-06-12):** `row_events` is the deliberate client-side
  history for *all* workspaces — it stays. The facts above stand, but the proposal is
  rescoped to eventual storage optimization + retention that preserves full
  reconstructability (e.g. derive `before_json` from the prior event's `after_json`).
  Tracked in issue #132 (with #75).

### A2. Per-keystroke interaction state is synced, uploaded, and server-history-logged — three docs claim it isn't
*(state lens · novel)*

- **Files:** `src/data/api/changeScope.ts:46-50`, `src/data/properties.ts:346-374`,
  `src/data/internals/clientSchema.ts:444-450`, `src/components/renderer/PanelRenderer.tsx:87-88`,
  `src/components/BlockEditor.tsx:104-118`, `supabase/migrations/20260522062437_add_blocks_history.sql`
- `ChangeScope.UiState` has `source:'user'`, and the upload trigger enqueues every
  non-NULL-source write. So every focus move (a full `repo.tx`), selection change
  (150ms debounce while typing), and scroll settle becomes: SQLite tx + `row_events`
  row + `ps_crud` envelope + Supabase upload + a `blocks_history` row + replication
  to **every workspace member's device**. Meanwhile `globalState.ts:152-155` says the
  plugin ui-state block "never enters the upload queue" and
  `docs/navigation-redesign.md` describes UiState panel rows as "(not synced)" — both
  wrong. In a shared workspace this is also a privacy leak: peers receive your
  focus/selection/scroll trail.
- **Proposal:** keep the block-row substrate (the in-memory-store alternative was
  explicitly rejected — this preserves that decision), but split UiState's upload
  policy: per-interaction properties (focus, selection, isEditing, scrollTop,
  layout-session rows) route through the already-planned **DeviceLocal** scope
  (named in follow-ups as the prerequisite for agent-token blocks); plugin ui-state
  that genuinely wants cross-device sync opts in explicitly per PropertySchema.
- **Payoff:** removes the highest-frequency write class from upload/history/
  replication; fixes the privacy leak; reconciles three contradictory docs.
- **Risk:** blocked on DeviceLocal existing; each property needs an explicit
  sync/no-sync decision (cross-device visit-state restore changes behavior).
- **Owner correction (2026-06-12):** syncing UI state through ordinary block rows is
  a deliberate, affirmed decision — device-local ephemeral state was removed on
  purpose; the contradicting docs are stale, not evidence of drift. Rescoped to:
  fix the stale docs now; icebox the upload/history policy until workspaces are
  actually shared. Tracked in issue #133.

---

## B. Extension runtime: four compensations for replace-the-world semantics

### B1. `setFacetRuntime`'s wholesale-REPLACE spawns four parallel compensation mechanisms
*(mechanisms lens · novel)*

- **Files:** `src/data/repo.ts:836-850, 1486-1547`, `src/data/kernelDataExtension.ts`,
  `src/extensions/staticDataExtensions.ts`, `src/plugins/daily-notes/index.ts:176`,
  `src/extensions/AppRuntimeProvider.tsx`
- Because each runtime swap REPLACES every registry, four manual compensations
  exist: (a) kernel mutators/queries/processors registered twice (constructor flags
  AND `kernelDataExtension` facets — the file header documents the silent breakage
  if either path is forgotten); (b) `Repo` mirrors the runtime's contribution
  buckets purely to replay them onto each fresh runtime; (c) data extensions are
  listed in `staticDataExtensions.ts` AND must be re-bundled per plugin (the
  daily-notes comment exists because it already bit someone; srs-review re-bundles
  four sibling plugins' dataExtensions); (d) every swap tears down and restarts ALL
  app effects.
- **Proposal:** keep the decided atomic-rebuild, remove the compensations:
  construct `Repo` empty + immediately install a kernel-only runtime (deletes the
  dual path and five flags); make replay the runtime's job
  (`FacetRuntime.withContributionsFrom(prev)`); derive both the data runtime and
  app manifest from one per-plugin record `{appExtension, dataExtension}`; diff
  `appEffectsFacet` contributions by effect id and restart only changed ones.
- **Payoff:** deletes the three comment-enforced contracts most likely to bite a
  plugin author, ~150 LOC of mirror/flag machinery, and toggle-one-extension
  restarting every plugin's subscriptions.

### B2. Four parallel AppExtension tree-walkers; the bare ones are toggle-blind — and that's a live bug
*(mechanisms lens · novel · **includes a real bug**)*

- **Files:** `src/extensions/facet.ts`, `resolveAppRuntime.ts`, `discoverToggleTree.ts`,
  `dynamicExtensions.ts`, `src/App.tsx:201`, `src/context/repo.tsx:40`, `src/data/localSchema.ts:12`
- Seven recursive walkers over the same grammar with three divergent semantics;
  `isFacetContribution` copy-pasted verbatim ×3; `pushValidatedContribution`
  duplicated with a stale "mirrors" comment. The bare collectors (no toggle
  boundaries, no `enables` recursion) are used in production at three sites.
  **Bug (verifier-confirmed, worse than the lens stated):** `App.tsx`'s landing
  resolution uses the bare walker, and `system:daily-notes` — a *non-essential,
  user-disableable* plugin — is the sole `workspaceLandingFacet` contributor, so a
  user who disables daily-notes still gets it steering first paint.
- **Proposal:** one parameterized walker in `facet.ts`
  (`{boundaries, functions, dedup, visitor}` options encoding today's deliberate
  differences explicitly); the other walkers become thin configurations; switch
  App.tsx's landing resolution to `resolveAppRuntimeSync` with the current
  overrides map.
- **Payoff:** grammar changes become single-point edits (the `enables` recursion
  was already missed once, per `dynamicExtensions.ts:194-201`); fixes the
  disabled-plugin-steers-first-paint bug; ~150 LOC deleted.

### B3. Untyped `window.CustomEvent` bus runs parallel to three typed mechanisms — and the authoring lint canonizes it
*(mechanisms lens · novel)*

- **Files:** 8 plugin `events.ts` files; `src/utils/dialogs.ts`,
  `src/extensions/dialogAppMount.tsx`, `src/plugins/video-player/events.ts`,
  `src/plugins/agent-runtime/extensionLint.ts`
- 29 `window.dispatchEvent` sites across 18 plugin files vs exactly 2 plugin
  consumers of the typed `openDialog` channel. Three antipatterns verified:
  action handlers that only dispatch an event; cross-plugin coupling over stringly
  event names (`app-intents` imports and fires quick-find's event); and synchronous
  request/response RPC over the broadcast bus (`video-player` passes `respond()`
  callbacks in event detail). Worse, `agent-runtime/extensionLint.ts` flags
  `useSyncExternalStore` as an anti-pattern while the typed `DialogHost` itself
  uses it — the lint actively penalizes the better mechanism.
- **Proposal:** bless one typed channel per shape — dialogs/pickers onto the
  existing promise-returning `openDialog` queue; toggle/open intents onto actions
  via `runActionById`; keep CustomEvents only for genuine broadcast. Update
  `extensionLint` + authoring catalog in the same change; keep old listeners as a
  deprecation shim for user extensions in the wild.
- **Resolved (2026-06-16, no deprecation shims):** all nine plugin `events.ts`
  files deleted; channels are now —
  - **Dialogs/pickers → `openDialog`:** extract-type (×2), merge-blocks,
    daily-notes (`DailyNotePicker` + `ReschedulePicker`), agent-runtime tokens.
  - **Toggle/open surfaces → `createToggleStore` (`useSyncExternalStore`) flipped
    by the action/header; cross-plugin via `runActionById`:** command-palette,
    find-replace, quick-find, left-sidebar. `app-intents`/PWA intents now call
    `runActionById(...)` instead of importing another plugin's event name.
  - **video-player RPC → typed per-`(renderScopeId, blockId)` handle registry.**
  - **Genuine broadcasts kept as CustomEvents:** swipe-quick-actions DOM events,
    `runtimeEvents.appRuntimeUpdate`, agent-runtime `agentTokensChanged` /
    `agentRuntimeBridgeRestart`, `propertyNavigation` create-request.
  - `extensionLint` inverted (`dialog-via-window-event` flags the bus, no longer
    penalizes `useSyncExternalStore`); authoring catalog updated to match.
  - **Regression guard:** an ESLint `no-restricted-syntax` *error* now blocks
    `window.dispatchEvent(new CustomEvent(...))` in non-test `src/`; the genuine
    broadcasts above carry an inline `eslint-disable` + justification.

---

## C. Boundaries that exist on paper but not in imports

### C1. `@/data/internals` is a paper boundary: 23 production files outside `src/data` import it, zero lint enforcement
*(layering lens · novel)*

- `aliasesProp` alone has 9 external importers (its own file header says facet
  registration was deferred); geo embeds raw kernel SQL constants; plugins import
  kernel invalidation channel ids, `runAnalyzeIfStale/Now`, `blockMerge`,
  `revealChildren`. `eslint.config.js` has no `no-restricted-imports` rule at all.
- **Proposal (order matters):** first promote the proven contract surface to
  `@/data/api` (`aliasesProp`, `revealChildren`, invalidation channel ids, a
  maintenance entrypoint; give geo a registered query), **then** add the lint rule
  with an allowlist. Lint-first would just force 23 files into worse workarounds.

### C2. `src/extensions` is two layers fused: a zero-import facet kernel buried in a directory that imports plugins, components, shortcuts, and data internals
*(layering lens · novel · also flagged by mechanisms + god-objects lenses)*

- `facet.ts` has literally zero imports — the purest module in the codebase — yet
  sits beside `staticAppExtensions.ts` (39 plugin imports) and
  `AppRuntimeProvider.tsx` (imports shortcuts). Meanwhile `src/data` imports
  `@/extensions` from 6 files, making data↔extensions bidirectional.
- **Proposal:** split the leaf kernel into its own bottom layer (e.g. `src/facets/`):
  `facet.ts`, `variantFacet.ts`, the walkers (natural home for the B2 unification),
  `runtimeEvents.ts`, and `togglable.ts` with its `aliasesProp` label-decode
  inverted (caller passes the label). `src/data` then imports only the kernel;
  the rest of `src/extensions` is declared app-layer. (Update: the
  `@/extensions/api.js` barrel has since been retired — extensions import each
  symbol directly from its real module via the importmap, discovered through
  `src/extensions/apiCatalog.ts`. Module identity still matters: those real
  modules must stay importable at stable paths.)

### C3. `data` and `sync` are one subsystem wearing two directories
*(layering lens · novel)*

- Runtime imports are mutual: `repo.ts:90-93` imports the blocks-synced observer;
  `observer/*` imports `BlockCache`, `handleStore`, `treeQueries`, block schema.
  Tarjan over production imports puts repo + 14 internals + all three observer
  files + `src/types.ts` in one 35-file SCC. All 11 sync→data import statements are
  in `observer/*`; `sync/keys`, `sync/crypto`, `transform` are data-free.
- **Proposal:** move `src/sync/observer/*` into the data engine
  (`src/data/internals/syncObserver/`) — it is the download half of the engine
  `repo.ts` already owns via `startSyncObserver`. `src/sync` then becomes a
  genuinely lower layer (keys/crypto/transform). Build the sync resolver once in
  `repoProvider` and pass it through the existing `syncObserverDeps` parameter
  instead of re-deriving it in `context/repo.tsx`.

---

## D. God modules bundling separable engines

### D1. `Repo` bundles four separable engines (2,446 lines, 118 referencing files)
*(god-objects lens · novel)*

- Four coherent modules trapped in one class, each already communicating with the
  rest through a narrow surface: **(1)** the facet-registry bridge (~400 lines:
  rebuild steps, bucket mirror, 5 listener channels); **(2)** idle maintenance jobs —
  reprojection, workspace backfills, reconcile rescans — with the identical
  requestIdleCallback-with-2s-timeout scheduler hand-rolled three times
  (byte-identical `globalThis` casts at lines 1811/1877/1969) plus three pending
  sets, three drain loops, and 21 marker-SQL references; **(3)** the 4-variant
  type-tagging API (lines ~2000-2185); **(4)** SQLite RAISE-protocol parsing
  (hex codec, lines 428-494) whose format contract spans two files with no shared
  constant. The verifier notes the duplication is *undersold*: `src/utils/scheduleIdle.ts`
  already exists with a near-verbatim docstring and 5 users — repo.ts just doesn't
  use it.
- **Proposal (dependency order):** (a) `internals/idleMarkerJobs.ts` — a
  `OneShotWorkspaceJob` owning scheduler + pending-set drain + marker persistence;
  the next one-time migration becomes a job registration (they keep arriving — the
  reconcile rescan is from commit bbc7bffa). (b) `data/typeTagger.ts` with Repo
  keeping spec-pinned delegating methods. (c) Extract the facet bridge alongside
  the B1 work. (d) Give the RAISE protocol one owner module shared with
  `clientSchema.ts`.
- **Payoff:** repo.ts roughly halves; each engine becomes unit-testable without a
  full Repo (idle jobs currently need `__reset*ForTesting` hooks).

### D2. `App.tsx`: 430 of 594 lines are a module-level bootstrap pipeline spanning five layers, executed from the render path
*(god-objects lens · novel)*

- Module scope holds: six-way workspace resolution (incl. Supabase RLS probe),
  E2EE entry-gate orchestration (the *read-inputs* half lives here while the
  *decide* half lives in `sync/keys/workspaceAccess.ts` — one concern split across
  layers), bootstrap writes, the landing-runtime cache (with the B2 toggle bug),
  URL→layout application, and an LRU promise cache + `navigationVersion` bust
  protocol that exists only because all of the above is one promise consumed via
  React `use()`.
- **Proposal:** split at the three comment-fenced phase boundaries:
  `bootstrap/resolveWorkspace.ts` (pure async, already has the right signature),
  `resolveWorkspaceEntry()` moved next to `decideWorkspaceEntry` in `sync/keys`,
  and `bootstrap/workspaceBootstrap.ts` for the write phase (testable without
  rendering). Keep the phase *ordering* in one composing function — the
  gate-before-writes and seedTutorial-before-parseReferences constraints are
  currently encoded only in comments.

---

## Refuted findings (for the record)

Two top-12 findings were killed by adversarial verification — worth recording so
they don't get re-proposed:

1. **"Five watch-source→mirror-into-runtime projectors should share scaffolding"** —
   the mechanical duplication is real (verbatim `OverridesReadable`, twin try/catch
   prose), but the verifier found the consolidation already tracked (follow-ups +
   issue #90) and the projectors' lifecycles diverge enough that a shared
   abstraction would relocate rather than reduce complexity.
2. **"The staleness invariant is re-implemented at four layers because the version
   vocabulary is missing"** — site inventory was accurate but two load-bearing
   claims were wrong (the four sites do not all guard the same invariant), so the
   proposed unification would have merged genuinely different predicates.

## Smaller verified observations (from the subsystem maps, below top-12 cutoff)

- `facets.ts`: nine copy-pasted ~15-line keyed-map combine implementations →
  a `keyedMapFacet(id, keyOf)` helper (~140 LOC → ~9 declarations).
- Three coexisting load-dedup mechanisms for row reads (`BlockCache.dedupLoad`
  bypassed by `repo.load`, `Block.load` rolls its own) — pick one.
- `stateBlocks.ts`/`globalState.ts`: seven module-level `lodash.memoize` promise
  caches keyed by hand-built strings embedding `repo.instanceId`.
- A ~1,700-line navigation subsystem lives in `utils/`; `utils` → `plugins`
  dependency inversion in the alias-collision toast.
- Infra: client and server schema have two rival sources of truth with asymmetric
  coverage; `scripts/*.ts` are never typechecked by the compile gate;
  `check-rpc-projections` rests on a hand-rolled regex SQL parser.
- `defaultShortcuts.ts` (1,125 lines) carries feature logic and cross-layer
  reaches; dispatch bodies duplicated between `runAction.ts` and `HotkeyReconciler`.

## Suggested sequencing

1. **Quick wins:** A1 retention DELETE; B2 walker unification + landing-bug fix;
   `keyedMapFacet`; point repo.ts at the existing `utils/scheduleIdle`.
2. **Boundary moves (mechanical, high leverage):** C2 facet-kernel extraction →
   C3 observer move → C1 promote-then-lint. These three make the declared
   architecture true in imports and give later refactors stable ground.
3. **God-object splits:** D1 (idle jobs first — pairs with the scheduleIdle reuse),
   then D2.
4. **Policy/design work:** A2 DeviceLocal scope split (blocked on DeviceLocal);
   B1 runtime-swap compensations; B3 event-bus migration (touches user-extension
   conventions — keep shims).
