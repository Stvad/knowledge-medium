# Performance Audit — 2026-06-18

## Summary

This audit covered 11 areas of the client: the data kernel (query/loader/subscription layer, projection
runtime & processors, transaction/storage layer), React rendering, editor & markdown, plugins, shortcuts &
command palette, the sync layer, startup/cold-start/TTI, and bundle size & code-splitting. Twelve findings
were run through adversarial verification; all were **confirmed** (none refuted), and after merging cross-area
duplicates ten distinct verified findings are detailed below — though six were
downgraded from "high" to "medium/low" once the real per-operation cost or the limiting factor (e.g. viewport
virtualization, React Compiler auto-memoization, in-process worker latency) was measured rather than assumed.
The headline wins are on the **startup/bundle path** — two large eager dependencies (`@babel/standalone`
~0.8 MB gz and the `lodash` barrel ~91 KB gz) are preloaded on every cold start for features most users never
touch, and both have safe, local fixes. The headline **steady-state hazard** is `HandleStore.invalidate`,
which linear-walks every live query handle on every commit and every sync write (the project's own #1 open
recommendation). Additional verified items span the SQLite write path (wide `UPDATE` SET clauses firing
needless triggers, an unread 2×-full-JSON history log), markdown re-parse on render, and cold-start worker
round-trips. 27 further lower-ranked candidates were recorded but not individually verified.

Counts: **12 verifications run / 0 refuted**; after merging cross-area duplicates, **10 distinct verified
findings** are detailed below, plus **27 unverified candidates**. (Per-area `cleanNotes` weren't threaded into
the consolidated input; the *Areas checked & clean* section is distilled from the area scratch notes.)

## Quick wins

High impact relative to effort. All verified.

| Finding | file:line | Impact | Fix | Effort |
|---|---|---|---|---|
| `@babel/standalone` eagerly preloaded | `src/extensions/compileExtensionModule.ts:1` | ~4.8 MB raw / ~0.8 MB gz (~39% of startup JS) fetched+parsed on every cold start for a feature most users never use | Remove top-level `import * as Babel`; do `const Babel = await import('@babel/standalone')` inside the already-async `defaultCompileViaBabelBlob` | Small |
| `lodash` monolithic barrel for 4 functions | `src/utils` (7 files import from `'lodash'`) | 489,957 bytes raw / ~91 KB gz preloaded+parsed every cold start to provide debounce/groupBy/isEqual/memoize | Switch to `lodash-es` (drop-in, same named-import syntax) or per-method `lodash/debounce` imports; saves ~390 KB raw / ~71 KB gz | Small |
| `tx.update` always rewrites `properties_json` + `references_json` | `src/data/internals/txEngine.ts:375` (also `:345` restore) | Every content-only edit needlessly fires `blocks_alias_update` + `blocks_type_update` triggers (DELETE + `json_each` scan) and re-serializes 2 JSON blobs; amplified across bulk sync/import | Build the SET clause dynamically from which patch fields changed (`updatePatchChangesBlock` already knows); content-only edits then skip the alias/type rebuild | Small |
| `encryptUploadOps` awaits `getMode()` (sync `localStorage` read) per op | `src/services/powersync.ts:104` | Bulk upload (import, reprojection, long-offline drain) does up to ~10k synchronous main-thread `localStorage` reads + ~10k awaits, even though mode is constant per workspace | Memoize `getMode` per `workspaceId` in a `Map` inside `encryptUploadOps` (mirror `materializabilityByWs` in `materialize.ts:284-291`) | Small |
| Heavy renderer libs (`react-player`, `@vis.gl/react-google-maps`) in eager boot graph | `src/extensions/staticAppExtensions.ts:28-51` | ~27 KB gz of renderer libs fetched on every cold start even when no video/map block exists and the plugin is toggled off | Wrap `VideoPlayerRenderer` / `MapView` in `React.lazy` behind a `Suspense` boundary; the facet contribution carries only the lazy wrapper | Small |

## High-priority (verified)

### 1. `@babel/standalone` (~0.8 MB gz) eagerly preloaded into the startup critical path for every user
- **file:line:** `src/extensions/compileExtensionModule.ts:1`
- **Status:** verified — severity confirmed **high** (not downgraded).
- **Problem:** Line 1 is a static `import * as Babel from '@babel/standalone'`. It is reachable from the boot
  graph via `main.tsx:6` → `App.tsx:11` (`AppRuntimeProvider`) → `AppRuntimeProvider.tsx:3` (dynamicExtensions)
  → `dynamicExtensions.ts:2` (`compileExtensionModule`). `Babel.transform` is only ever called inside the async
  `defaultCompileViaBabelBlob` (`:76`), which runs solely when a user compiles a code/JS extension.
- **Why it matters:** Verified against the real prod build: `dist/index.html` contains
  `<link rel="modulepreload" crossorigin href="/node_modules/@babel/standalone/babel.js">`; `babel.js` is
  4,795,957 bytes raw / 846,710 bytes gz — ~39% of the ~11.7 MB raw startup JS payload — fetched, parsed, and
  evaluated on every cold load for every user, the vast majority of whom never author a code extension. The
  build uses `preserveModules:true` + `minify:false` (`vite.config.ts`) so there is no tree-shaking escape hatch;
  the static edge directly puts `babel.js` in the eager preload set.
- **Fix:** Replace the top-level import with `const Babel = await import('@babel/standalone')` inside
  `defaultCompileViaBabelBlob`. The `Babel` identifier is referenced only at the `.transform(...)` call, so the
  diff is one import removed + one line added; CJS→ESM interop is sound (`transform` is a named export).
  Extension authors pay on first compile; everyone else saves ~4.8 MB raw / ~0.8 MB gz.
- **Effort:** Small.

### 2. `lodash` monolithic barrel (~91 KB gz) preloaded for only 4 functions
- **file:line:** `src/utils` — 7 source files `import { ... } from 'lodash'`
  (`src/context/repo.tsx:9`, `src/plugins/left-sidebar/shortcuts.ts:1`, `src/data/stateBlocks.ts:14`,
  `src/plugins/command-palette/CommandPalette.tsx:15`, `src/components/BlockEditor.tsx:11`,
  `src/hooks/block.ts:28`, `src/data/internals/handleStore.ts:27`)
- **Status:** verified — severity confirmed **high**.
- **Problem:** Collectively only `debounce`, `groupBy`, `isEqual`, and `memoize` are used. The `lodash` main
  entry is a single monolithic CommonJS module that is **not** tree-shakable, so the unbundled build emits the
  whole `node_modules/lodash/lodash.js` (489,957 bytes raw / ~91 KB gz) and modulepreloads it
  (`dist/index.html:163`).
- **Why it matters:** `isEqual` is the default structural-diff equality in `handleStore` (`handleStore.ts:508`)
  and the block-hook deep equality (`hooks/block.ts:66`) — both core query-dedup paths — so it loads on every
  startup. (Correction to the original estimate: the fix does **not** drop to "a few KB"; the dependency
  closure of these 4 functions is ~99,597 bytes raw / ~20 KB gz. The realized saving is ~390 KB raw / ~71 KB
  gz — still large.)
- **Fix:** Switch the imports to `lodash-es` (drop-in; the named-import syntax is unchanged) or per-method
  default imports (`import debounce from 'lodash/debounce'`). `lodash-es` is the lowest-churn option.
- **Effort:** Small.

### 3. `HandleStore.invalidate` linear-walks every registered handle on every commit and every sync write
- **file:line:** `src/data/internals/handleStore.ts:321-376`
- **Status:** verified — severity adjusted **high → medium**.
- **Problem:** `invalidate(change)` snapshots `Array.from(this.handles.values())` (`:348`) and loops **every**
  live handle calling `observeDuringLoad(change)` + `matches(change)` on each (`:354-361`); `matches()` itself
  iterates that handle's full dependency list (`:770-780`). There is no inverted dep-index, despite the class
  header (`:11`) and the metrics comments (`:199-206`) explicitly advertising it as the intended design
  (`handlesWalked = invalidations × handles.size`, "should drop to handlesMatched"). Cost is genuinely
  O(live handles × avg deps).
- **Why it matters:** Fires synchronously on every `repo.tx` commit (`repo.ts:1077`) and every sync-applied
  write (`syncObserver/invalidate.ts:87`). Many routine UI interactions are DB writes: collapse/expand writes
  `isCollapsedProp` (`mutators.ts:131`), and selection state is itself a block property written via
  `uiStateBlock.set(...)` (`globalState.ts:199`, `stateBlocks.ts:419`). Live-handle count scales with on-screen
  blocks (`BlockComponent.tsx:53` mounts a `useChildIds` LoaderHandle per rendered block, plus
  subtree/backlinks/properties handles); a fat subtree handle can carry hundreds of `row` deps
  (`kernelQueries.ts:543`). The project's own bench (`docs/perf-baseline.md:97-113`,
  `scripts/bench/bench-handles.ts`) measures `invalidate` p50 = 258 µs at 10k handles (vs 1 µs at 1) and a ~2.2×
  `setContent` write-latency regression with 10k bystander handles.
- **Why medium (not high):** `LazyViewportMount`'s IntersectionObserver only mounts `BlockComponent` (and its
  `childIds` handle) near the viewport, so a 5k-block outline does not register 5k live handles — realistically
  hundreds, not thousands. The 2.2× multiplier sits on a sub-millisecond base (~0.49 → ~1.10 ms), below a
  perceptible single-keystroke threshold, and the bench notes high run-to-run variance. The two biggest prior
  fan-out costs were already addressed. It is a latency tax that grows monotonically with handle count and the
  cleanest cost/value item on the list (project recommendation #1), but not a present-day scalability cliff.
- **Fix:** Implement the documented inverted index: alongside `Map<key, RegisteredHandle>`, maintain
  `Map<dep-key, Set<RegisteredHandle>>` keyed by row-id / parent-id / workspace-id / table / plugin-channel,
  maintained inline in `onDep` (add) and `dispose` (remove), with dep-replacement-on-settle patching buckets
  atomically (deps are already re-published as a deduped set at each load settle, `:615-616`, with a canonical
  `depKey`, `:902-910`). `invalidate` then unions only the buckets the change touches; table/plugin wildcard
  deps fall into a small always-checked bucket. **Safety caveat:** the index must narrow the candidate set, but
  mid-load / inflight handles must still receive `observeDuringLoad` (an index refreshed only at settle could
  miss a mid-load late-declared row dep) — this is the part most likely to introduce a correctness bug if done
  naively. Full design + correctness checklist in `docs/follow-ups.md:155-183`; validate with the existing
  `bench-handles` "invalidate (N registered, 1 match)" and "setContent with N bystanders" rows.
- **Effort:** Medium–large.

### 4. `tx.update` always rewrites `properties_json` + `references_json`, firing alias/type rebuild triggers on every content-only edit
- **file:line:** `src/data/internals/txEngine.ts:375` (also `restore()` at `:345`)
- **Status:** verified — severity adjusted **high → medium**.
- **Problem:** `update()` builds a fixed wide SET clause
  `UPDATE blocks SET content=?, references_json=?, properties_json=?, updated_at=?, user_updated_at=?, updated_by=?`
  regardless of which patch fields actually changed. SQLite's `AFTER UPDATE OF properties_json` triggers fire
  whenever the column appears in the SET list, **even when the assigned value is byte-identical** (verified via
  a `node:sqlite` probe: wide UPDATE re-assigning the same value fires; narrow content-only UPDATE does not). So
  every content edit needlessly fires `blocks_alias_update` (`clientSchema.ts:762`:
  DELETE + `json_each(properties_json,'$.alias')`) and `blocks_type_update` (`clientSchema.ts:863`), plus
  re-serializes both JSON blobs.
- **Why it matters:** Runs on the hottest write path — `core.setContent` (`mutators.ts:138-146`) calls
  `tx.update(id, {content})` with no properties/references — i.e. every debounced keystroke commit, plus paste,
  find-replace, block-tagging, geo. The same wide-SET upsert on sync-apply (`syncObserver/materialize.ts:61`)
  amplifies it across initial-sync / bulk-import of tens of thousands of rows. The test claiming this is safe
  (`clientSchema.test.ts:840`) passes for the wrong reason: the harness `updateBlock` (`:192`) emits a narrow
  `UPDATE blocks SET content=?`, not the engine's wide SQL — false confidence.
- **Why medium (not high):** Per edit the wasted work is one PK-keyed DELETE + a single-row `json_each` scan +
  two JSON serializations — cheap per keystroke. It compounds on every keystroke commit and amplifies during
  bulk sync/import, but is not a user-visible latency cliff on typical workspaces.
- **Fix:** Build the SET clause dynamically — include `content=?` only when `patch.content!==undefined`,
  `properties_json=?` only when `patch.properties!==undefined`, `references_json=?` only when
  `patch.references!==undefined` (always include metadata stamps). `updatePatchChangesBlock` (`txEngine.ts:98-113`)
  already inspects each field. **Verified safe:** the upload trigger (`clientSchema.ts:578-595`) diffs values via
  `OLD.x IS NOT NEW.x`, not the SET list, so the upload envelope is byte-identical before/after; FTS gates on
  `content` (an inverse improvement for property-only edits); history/`recordWrite` takes JS before/after objects
  independent of the SET clause. Add a test that drives the change through the **real engine SQL** (not the
  narrow harness) and asserts `block_aliases` is untouched on a content-only edit.
- **Effort:** Small.

### 5. `row_events` trigger writes two full-block JSON snapshots (before+after) on every block write into a log nothing reads at runtime
- **file:line:** `src/data/internals/clientSchema.ts:436`
- **Status:** verified — severity adjusted **high → medium**; **fix is only half-safe** (see below).
- **Problem:** The `AFTER UPDATE` trigger inserts a `row_events` row with `before_json = json_object(OLD.*)` AND
  `after_json = json_object(NEW.*)` (`blockJsonObjectSql` at `:384`, which re-parses `properties_json` +
  `references_json` via `json(...)` and serializes the entire 13-column block twice). For a one-character edit
  the two blobs are full and near-identical. The trigger is ungated by source, so it fires for both local
  `repo.tx` writes and sync-applied `materialize` UPSERTs (`materialize.ts:62-64`,
  `INSERT ... ON CONFLICT DO UPDATE`). The table is never trimmed (`:66-68`).
- **Why it matters / "nothing reads it":** Verified strongly — `grep` for `SELECT ... FROM row_events` outside
  tests returns zero production hits. The former reader `rowEventsTail.ts` was deleted in commit `588937cd`
  when Layout B moved invalidation directly into `syncObserver/invalidate.ts`; the file does not exist in `src/`.
  The only consumers are a test and a deferred (unbuilt) undo design. So the 2×-full-JSON-per-write cost
  currently buys only an unread, monotonically growing history log. The team's own doc
  `docs/row-events-retention.md` measures ~1.17M rows at ~2 KB JSON/event on a real device, monotonic growth,
  and notes "write-tx tail latency tracks the JSON-build + insert cost."
- **Why medium (not high):** This is background-insert tail latency + local storage growth, not a correctness
  bug or user-facing breakage.
- **Fix (split into two, only one is a free perf fix):**
  - **Safe & recommended:** Adopt the changed-columns diff shape for UPDATEs — store `before_diff`/`after_diff`
    (changed columns only) plus a `changed_columns` array, and skip identical-row UPDATEs entirely; keep full
    snapshots only for INSERT (after) and DELETE (before). This preserves reconstructable history while cutting
    the dominant per-write cost.
  - **NOT a free perf fix — treat as a separate, explicitly-decided retention change:** the doc's idle-bootstrap
    pruning (7-day grace + keep-recent floor) drops older history. `row_events` is documented (`:60-68`,
    `invalidation.test.ts:467`) as "the ONLY durable record of an incoming sync change," and the standing
    instruction is that live history is never silently dropped. This is a deliberate retention-policy change,
    not a perf patch.
  - **Caveat:** `docs/row-events-retention.md` is **stale and untracked** — its "reads we must preserve" section
    cites the deleted `rowEventsTail.ts`. Delete or rewrite that doc before using it as an implementation spec.
- **Effort:** Large.

### 6. ~65–75 sequential single-statement DB worker round-trips block first paint on every cold start
- **file:line:** `src/data/repoProvider.ts:251-340`
- **Status:** verified — severity adjusted **high → medium** (impact magnitude rests on an unverified
  per-round-trip estimate).
- **Problem:** `initializePowerSyncDb` runs all client DDL as individually-awaited `execute()` calls: 2 PRAGMAs
  (`:280-281`), blocks/blocks_synced tables + indexes (`:284-292`), `ensureBlockUserUpdatedAtColumn` (`:297`,
  itself 2 PRAGMA round-trips every boot), workspaces/members + `ensureWorkspaceE2eeColumns` (`:300-306`), then
  `for (const stmt of CLIENT_SCHEMA_STATEMENTS) await powerSyncDb.execute(stmt)` (`:314-316`).
  `CLIENT_SCHEMA_STATEMENTS` has ~44 source entries; `withTriggerRecreate` (`clientSchema.ts:1156-1160`) expands
  each of ~21 triggers into DROP + CREATE, yielding ~65 statements in the loop alone, ~75 total round-trips. The
  PowerSync DB runs in a Web Worker accessed via a Comlink proxy and `execute()` runs exactly one statement per
  call; `RepoProvider` suspends on `initRepo` (`repo.tsx:61`) which awaits the entire init before first paint.
  Idempotent `CREATE ... IF NOT EXISTS` statements still execute and round-trip on warm starts.
- **Why it matters:** Runs on every cold start / hard reload for every user. With a small fleet reloading
  continuously across deploys, the serialized message latency is paid repeatedly before React can resolve the
  first suspended render.
- **Why medium (not high):** The cited ~65–200 ms rests on a 1–3 ms/round-trip estimate that is unverified for
  in-process Web Worker `postMessage` (often sub-ms, though structured-clone + OPFS I/O contention can push it
  higher). It is a fixed serialized tax worth removing, but the magnitude is unmeasured.
- **Fix:** Join the parameterless DDL/PRAGMA/trigger statements into one (or a few) `;`-separated SQL strings
  and run each in a single `execute()`. **Verified safe:** `WASQLiteDB.executeRaw` iterates
  `api.statements(db, sql)` and steps through ALL statements when no bindings are passed (`if (bindings) break`),
  so a multi-statement parameterless string runs fully in one round-trip; all `CLIENT_SCHEMA_STATEMENTS` are
  literal SQL with zero bind params. Collapses ~65 → ~3-4 round-trips. Keep the param'd/probe calls (`getOptional`
  backfill markers, deferred ANALYZE) separate and preserve the DROP-then-CREATE ordering `withTriggerRecreate`
  already produces.
- **Effort:** Medium.

### 7. Heavy renderer libraries (`react-player`, `@vis.gl/react-google-maps`) pulled into the eager boot module graph
- **file:line:** `src/extensions/staticAppExtensions.ts:28-51`
- **Status:** verified — severity adjusted **high → medium** (impact size overstated in the original finding).
- **Problem:** The build uses `preserveModules:true` (`vite.config.ts:138`), emitting standalone modules with no
  app-level bundling. The boot path eagerly evaluates the full plugin import graph (`AppRuntimeProvider.tsx:57`
  and `workspaceBootstrap.ts:59` both call `staticAppExtensions({repo})`). Two plugins pull large libs into the
  eager graph via direct static imports: `videoPlayerPlugin` → `VideoPlayerRenderer.tsx:1`
  `import ReactPlayer from 'react-player'`; `geoPlugin` → `geoContentDecorator.tsx:24` `import { MapView }` →
  `MapView.tsx:26` `@vis.gl/react-google-maps`. The `systemToggle` only gates **activation** of facet
  contributions, not whether the module code loads. The app uses zero `React.lazy` and only 2 real dynamic
  `import()` calls anywhere.
- **Why it matters:** `dist/index.html` modulepreloads both libs (react-player's chunks + react-google-maps),
  so they are fetched/parsed/evaluated on every cold start even with geo/video disabled and even when the graph
  has no Place/Map/video blocks (the common case).
- **Why medium (not high) — correction to the original size claims:** the emitted
  `@vis.gl/react-google-maps/dist/index.modern.js` is ~91 KB raw / ~22 KB gz (NOT "1.2 MB" — that was
  source-on-disk including all formats + sourcemaps; also NOT "292 KB"). react-player v3.4.0 is ~21.6 KB raw /
  ~5 KB gz across 8 modules, and its heavy media deps (hls.js/dashjs) are already lazily imported and are NOT in
  the startup preload graph. Combined on-the-wire cost is ~27 KB gz — real and worth removing, but an order of
  magnitude smaller than claimed. (Context: the dominant cold-start cost is the unbundled `minify:false` build
  shipping ~11.7 MB raw / ~2.4 MB gz across 1,152 preloaded modules, of which `@babel/standalone` alone is the
  biggest single offender — see findings 1 and the unverified bundle candidate below.)
- **Fix:** Wrap `VideoPlayerRenderer` and `MapView` in `React.lazy(() => import(...))` behind a `Suspense`
  boundary (none exists in these files today, so the fix must add one). The facet contribution
  (`blockRenderersFacet` / `blockContentDecoratorsFacet`) stores a component reference and only instantiates on
  matching render, so a lazy wrapper is a valid contribution; plugin entry + facet registration stay eager and
  cheap. This would establish the codebase's first lazy-boundary pattern.
- **Effort:** Small–medium.

### 8. Block markdown is re-parsed from scratch on every render of a read-mode block (no memoization)
- **file:line:** `src/components/renderer/MarkdownContentRenderer.tsx:35` / `:39`
- **Status:** verified — severity adjusted **high → medium**. **Note a cross-area tension below.**
- **Problem:** `MarkdownContentRenderer` calls `runtime.read(markdownExtensionsFacet)` then
  `resolveMarkdownConfig({block, blockContext})` on every render with no memoization (`:35-36`), then passes the
  result into react-markdown's synchronous `<Markdown>`. `resolveMarkdownRenderConfig`
  (`src/markdown/extensions.ts:29-53`) allocates a fresh `remarkPlugins` array + `components` object and invokes
  every extension factory each call (wikilink rebuilds a fresh `refMap` per call,
  `wikilinks/index.tsx:29`). react-markdown's `Markdown` export
  (`node_modules/react-markdown/lib/index.js:175-179`) does `createProcessor()` + `parse()` + `runSync()` +
  `post()` unconditionally with zero cross-render memoization — so each render rebuilds the unified pipeline,
  re-lexes/parses markdown, runs all remark transformers (wikilink 4 visit passes, blockref 2), and rebuilds the
  React tree.
- **Why it matters:** Runs for any visible block whose parent panel/shell re-renders for an unrelated reason; on
  a large page, and amplified by breadcrumb/backlink panels that render a full `BlockComponent` per segment
  (`BreadcrumbList.tsx:86`), this is a meaningful per-render CPU cost. There is no `React.memo` anywhere in the
  `BlockComponent → DefaultBlockRenderer → ContentSlot → MarkdownContentRenderer` chain (only `useMemo` on the
  slot's identity), so a parent re-render re-invokes the body.
- **Why medium (not high) + the key overstatement:** The "full re-parse per keystroke" claim is **wrong** — the
  plain-outliner editing dispatcher (`plain-outliner/interactions.tsx:26-29`) swaps to the CodeMirror renderer
  while `inEditMode`, so `MarkdownContentRenderer` is **not** mounted for the block being actively edited; the
  re-parse happens once on edit-mode exit/commit, not per character. `DefaultBlockRenderer`'s `useMemo` slots
  also limit cross-block fan-out for a block's own data change. The remaining real cost is per-block re-parse on
  **parent-triggered** re-renders.
- **Cross-area tension (record honestly):** The `react-rendering` area's investigation **retracted** this
  finding after running `babel-plugin-react-compiler` (enabled at `vite.config.ts:45`) on the compiled output and
  concluding the compiler auto-memoizes the `<Markdown>` element and `markdownConfig`. The two other areas
  (`plugins`, `editor-markdown`) verified the mechanism at the source level and did not reconcile against the
  compiled artifact. **Before investing in a manual fix, confirm against compiled output whether the React
  Compiler already memoizes this** — if it does, this is a no-op and the manual fix is unnecessary; if it does
  not (e.g. because the fresh config identity defeats the compiler's dependency tracking), the fix below applies.
- **Fix (if not already compiler-handled):** `useMemo` the `markdownConfig` keyed on the resolver identity (the
  facet `read` is cached per facet id, `facet.ts:188-189`, so it is a stable key) plus the reactive fields the
  extensions read — **content + references + workspaceId** (wikilink reads `data.workspaceId`; the original
  `[content, references, markdownConfig]` key is incomplete). Then wrap the `<Markdown>` subtree in a memo so a
  re-render that doesn't change those inputs skips the re-parse. The config-identity stabilization is a hard
  prerequisite — a memo keyed on the freshly-allocated `remarkPlugins`/`components` would never hit.
- **Effort:** Medium.

## Medium / Low

### `BlockCache` snapshots map has no eviction — unbounded memory growth across a long session
- **file:line:** `src/data/blockCache.ts:95`
- **Status:** verified — severity adjusted **medium → low** (magnitude estimated, not measured).
- The per-id `snapshots` Map only ever removes entries on hard-delete (`deleteSnapshot`, `:186`) or
  `markMissing` (`:240`); every block loaded via query hydrate or `repo.load` stays as a deep-frozen full
  `BlockData` forever. Hydration paths (`repo.ts:440-453, 519, 888, 896`) add on every paged document, so a
  long-lived session accumulates without bound. `docs/perf-baseline.md:390-395` estimates ~3 KB/block (~150 MB
  at 50k blocks), **but** the memory-growth bench came back GC-noisy and the doc flags it needs a steadier
  harness — so the magnitude is unverified, and 50k distinct blocks in one uninterrupted session is the upper
  tail of usage. **Fix:** add a bounded LRU keyed on entries with no active `BlockCache.subscribe` listeners
  (`trackedIds()` at `:211` already exposes the seam, with zero current callers); eviction is lossless because
  the snapshot is written **after** the SQLite commit (`commitPipeline.ts` STEP 6), so the next read re-hydrates
  the identical value via `applyIfNewer`. **One edge:** synchronous `block.data`/`peek()` readers
  (`hooks/block.ts:83-99`) that hold a `Block` without subscribing would throw `BlockNotLoadedError` if their
  snapshot is evicted mid-use — the "evict unsubscribed only" heuristic mitigates but doesn't fully eliminate
  this. **Effort:** medium.

## Additional candidates (unverified)

Lower-ranked items recorded during the sweep but not individually adversarially verified. One line each.

- **`BlockCache.setSnapshot` JSON.stringify-fingerprints both existing and incoming snapshot on every write** — `src/data/blockCache.ts:14-15,128-143` — two full `JSON.stringify` of the whole block per cache write; the cached side is recomputed though it can't have changed. Store the fingerprint alongside the snapshot. (Appears twice in the sweep; also recorded at `src/data/blockCache.ts:132` for the tx/storage area.)
- **`observeDuringLoad` fan-out is O(all handles) even when no load is in flight** — `src/data/internals/handleStore.ts:354` — the first invalidate pass calls `observeDuringLoad` on every handle (no-op unless `inflight`); maintain an `inflightHandles` Set and iterate only it. Companion to finding 3; called out in `docs/follow-ups.md:181`.
- **`parseReferences` resolves alias targets one-at-a-time with serial awaited DB lookups per content edit** — `src/plugins/references/referencesProcessor.ts:139` — N distinct wikilinks → N sequential awaited `aliasLookup` round-trips (plus a seat-probe on miss, `:152`) post-commit; batch with `WHERE alias IN (...)` or `Promise.all`. (Recorded twice, medium and low confidence.)
- **Whole-workspace ref reprojection runs in one unbounded `repo.tx`** — `src/data/repo.ts:1488` — `reprojectRefTypedProperties` funnels all matched rows through a single tx (builds the entire snapshots map in memory, holds the writer for the whole pass, emits one giant ps_crud tx), unlike the download observer which windows at `DEFAULT_DRAIN_CHUNK=1000`. Marker-gated/idle-deferred/add-only, so only bites the first cold start after a new ref-typed schema over a large graph. Window into chunks.
- **`LazyViewportMount` keeps a live `ResizeObserver` per mounted block for the block's entire lifetime** — `src/components/util/LazyViewportMount.tsx:60-71` — a mounted block never reverts to a placeholder, so continuous observation (a forced `offsetHeight` read on every reflow) is wasted after the first measurement; measure once or `disconnect()` after first non-zero measurement.
- **`LazyViewportMount` module-level caches grow unbounded and force eager mount of every previously-seen block** — `src/components/util/LazyViewportMount.tsx:7-8,38,43` — `mountedCacheKeys`/`measuredHeights` are never pruned (memory leak) and the always-eager-on-revisit policy (`:38`) re-incurs the O(N) initial-mount cost the lazy wrapper exists to avoid. Bound the caches; still gate mount on the IntersectionObserver.
- **Wikilink display decorator runs unmemoized for every wikilink on every render** — `src/plugins/references/markdown/wikilinks/Wikilink.tsx:28` — `resolveWikilinkDisplay` loops all decorators per wikilink per render; the daily-date decorator calls `parseLiteralDailyPageTitle` + `pickBlockDateAdapter` (each `canHandle` reads `block.peek()`). Memoize per `(alias, blockId)`. Only realizes its win once finding 8 stops the subtree re-parse.
- **Markdown render config is reallocated with fresh identities on every render** — `src/components/renderer/MarkdownContentRenderer.tsx:35` — fresh `remarkPlugins[]`/`components{}` + an O(references) wikilink Map rebuild per render; the structural blocker that keeps finding 8's memo from being effective. `useMemo` keyed on `[resolveMarkdownConfig, block, blockContext, references]`.
- **No `React.memo` anywhere on the block render path: a structural edit re-parses every visible sibling's markdown** — `src/components/BlockComponent.tsx:16` — a structural op invalidates the parent's `childIds` handle → `BlockChildren` re-renders → recreates every `<LazyBlockComponent>` → every mounted sibling re-renders down to a full reparse. Confidence medium on the exact re-render trigger set; `React.memo(BlockComponent)` is safe and strictly beneficial. (This is the "page-wide fan-out" claim that the medium downgrade of finding 8 was conditional on.)
- **Pointer/imperative dispatch re-runs the full action transform+override pipeline (and re-allocates the action list) on every click** — `src/shortcuts/HotkeyReconciler.tsx:242` — `dispatchPointerAction` / gesture dispatchers / `runActionById` (`runAction.ts:46`) each call `getEffectiveActions(runtime)` fresh (nested action×transform loop + a fresh ~100-element array), though `HotkeyReconciler` already holds the identical list memoized (`:158`). Read a memoized list via a ref, or memoize `getEffectiveActions` at module level keyed on facet identities.
- **`MobileBottomNav` rebuilds the effective-action list + a Map on every render, and re-renders on every block focus change** — `src/plugins/mobile-bottom-nav/MobileBottomNav.tsx:50` — `getEffectiveActions` + `new Map(...)` in the render body; subscribes to `useActiveContextsState()` which changes on every focus/edit transition — the full pipeline runs per focus change on mobile. `useMemo` keyed on `[runtime]`.
- **Independent get-or-create bootstrap page writes run strictly sequentially** — `src/bootstrap/workspaceBootstrap.ts:154-167` — Properties/Types/Recents pages have no mutual dependency yet are awaited serially on the TTI path; `Promise.all` them. Honest caveat: `repo.tx` serializes on the single wa-sqlite write lock, so the clear win is the warm path (overlapping 3 read round-trips) + collapsing stacked await latency.
- **Per-block window resize/orientationchange listener registered even when no gesture recognizer applies** — `src/extensions/continuousGestures.ts:680` — `useSyncExternalStore(subscribeViewport, ...)` adds 2 window listeners per mounted block even when `recognizers.length===0` (the desktop default), unlike the shared-listener pattern in `keyboardViewport.ts`. Gate the subscription on `recognizers.length>0` with a stable module-level no-op subscribe.
- **`BlockCache.setSnapshot` does two full `JSON.stringify` of the whole block per write for dedup, uncached** — `src/data/blockCache.ts:132` — (tx/storage-area framing of the same fingerprint issue) `applyIfNewer` already gates on `updatedAt <=` before delegating, so only the local commit path genuinely needs the dedup; cache the fingerprint or skip it where the snapshots map already proves the row changed.
- **grouped-backlinks query registers thousands of per-node plugin deps, inflating the global invalidation `matches()` walk** — `src/plugins/grouped-backlinks/query.ts:156` — `dependOnSourceContextNode` registers 2 plugin deps per source AND per ancestor; on a densely-linked target the handle accrues ~2×(sources+ancestors) deps that the linear `invalidate` walk scans on every workspace edit while the panel is open. Dedup to the unique ancestor set or coarsen to a page/workspace-level structural channel.
- **Unbundled, unminified build ships ~11.7 MB raw JS across 1,152 preloaded files with a 117 KB index.html** — `vite.config.ts:148` — `preserveModules:true` (load-bearing for extension `@/` imports) + `minify:false` (an independent choice) + `sourcemap:true`; the 117 KB HTML parses before boot and unminified JS is several-fold larger to transfer/parse. Flip `minify:false` (terser preserves export names, so module URLs/named exports are unaffected) as the cheap safe win; optionally bundle+minify the vendor subtree extensions never import by path. Confidence medium on the vendor-bundling half.
- **Reference-changing edits trigger a second full commit-pipeline pass** — `src/plugins/references/referencesProcessor.ts:266` — a ref-set-changing edit opens its own `repo.tx` writing `{references}`, re-running the whole pipeline (a second `handleStore.invalidate` walk, a second `command_events` row, an extra ps_crud entry). Largely inherent to the deliberate post-commit-separate-tx design; the realistic mitigation is the inverted index (finding 3) + alias-batching, not removing the second tx. Recorded as structural cost, not a bug.
- **`materializeWorkspace` loads every workspace id into one array before windowing** — `src/data/internals/syncObserver/observer.ts:227` — `SELECT id FROM blocks_synced WHERE workspace_id=?` with no LIMIT held as one array (320k strings for a large workspace) for the whole windowed drain, partially defeating the "keep memory flat" intent. Page with a keyset cursor. Runs only on unlock/reconcile/recovery — rare.
- **`parseReferences` post-commit processor does serial per-alias `aliasLookup`** — `src/plugins/references/referencesProcessor.ts:139` — (plugins-area framing) off the typing path and handle-cached, so bulk-paste of many distinct new wikilinks is the trigger; `Promise.all` or a single IN-list query.
- **`useRegisteredAction` runs the full effective-action pipeline in render with no memoization** — `src/plugins/left-sidebar/LeftSidebar.tsx:57` — `getEffectiveActions(runtime).find(...)` in render per `SidebarAction`; the sidebar renders only a handful and is a toggle surface, so impact is small. `useMemo` on `[runtime, actionId]` or rely on the module-level cache.
- **`serializeSelectedBlocks` issues one subtree SQL query per selected block (N+1) and can duplicate overlapping subtrees** — `src/utils/copy.ts:63` — multi-block Cmd+C runs N independent `subtree().load()` calls and emits overlapping descendant rows twice. Dedup by hierarchy (`validateSelectionHierarchy`) then fetch in one query.
- **`subtreeQuery` declares a row dep per subtree row, so any descendant content edit re-resolves the entire subtree** — `src/data/internals/kernelQueries.ts:493-498` — bounded today (the per-render hot path subtrees the layout-session block, not content), but a latent cost if a future consumer mounts a content subtree handle on a large edited page. Offer a structure-only `declareRowDeps:false` variant.
- **`tx.childrenOf` parses every child row into full `BlockData` even when only order keys are needed** — `src/data/internals/txEngine.ts:497-518` — mutators computing order keys against a wide parent pay full parse (perf-baseline #5: 22 ms for 10k children) inside the write lock. Add a lean order-keys-only read primitive.
- **`normalizeReferences` same-tx processor issues a second full-row UPDATE (and second row_events row) when references are not canonical** — `src/data/internals/normalizeReferencesProcessor.ts:48` — short-circuited by `referencesEqual` when already canonical; compounds with findings 4 and 5. Fix finding 4 first (narrow SET) so the second write only touches `references_json`.
- **`console.debug` string-building in the per-chunk upload path** — `src/services/powersync.ts:347` (also `:313`, `:326`) — argument expressions evaluated regardless of whether debug logging is surfaced; per-chunk (not per-row) so bounded. Gate behind a dev flag. Lowest priority.
- **`useRenderer` runs an unmemoized registry filter+sort (incl. ReactPlayer URL regex) on every block on every content edit** — `src/hooks/useRendererRegistry.tsx:14-42` — explicit `'use no memo'`; `Object.values(registry).filter(canRender).sort(priority)` per render, where `VideoPlayerRenderer.canRender` runs a media-provider URL regex. Bounded by registry size (~13), constant-factor not O(N). Cache the choice keyed by `(rendererKey, types, context flags)`.
- **Tutorial-only example-extension source strings (~15.5 KB) are eagerly bundled into the startup chunk** — `src/extensions/exampleExtensions.ts:1` — pulled in via a static import in `defaultShortcuts.ts:35` (core startup) + `tutorial/outline.ts:19`; used only by the tutorial / a rarely-invoked action. Lazy-load with `await import('@/extensions/exampleExtensions.js')` inside the handler.

## Areas checked & clean

Coverage notes so the reader can see what was inspected and found acceptable. (No per-area "cleanNotes" were
supplied in the consolidated input; the following is distilled from the area scratch notes.)

**Data kernel — query/loader/subscription (`src/data/internals`):**
- `idx_blocks_parent_order` (`blockSchema.ts:98`) covers `CHILDREN_SQL`/`SUBTREE_SQL`.
- `useHandle` (`hooks/block.ts:100-205`): memoized selector + `committedRef` ref-stability + `useSyncExternalStore` bail-out.
- `LoaderHandle` deferred-when-no-subscribers, mid-load coalescing, `ctx.depend` dedup — already optimized.
- `dispatchQuery` warm hit ~1 µs. Row-grain subscription fires only the one block's listener.
- `kernelQueries` narrow-channel deps and `kernelInvalidation` single-pass diffing are well-optimized.
- The backlinks inverted-edge table (`perf-baseline.md` #7) **already exists** (`references/localSchema.ts:12` `block_references` + `idx_block_references_target`) — that recommendation is partly stale.

**Data kernel — projection runtime & processors:**
- `ProjectorRuntime` subscribes only to `{workspaceId, types:[metaType]}` meta-blocks (small row count), not graph-wide; dedup hook + primed gate prevent feedback loops.
- `reprojectRefTypedProperties` is marker-gated, one-time-per-workspace, add-only.
- Sync-applied writes do **not** run post-commit processors (`materialize.ts` runs only `applySyncInvalidation`) — no double-processing on sync.

**Data kernel — transactions & storage:**
- `tx_context` set/clear (2 UPDATEs on a 1-row table) and the per-tx `command_events` INSERT are negligible.
- `treeQueries` recursive CTEs use the covering indexes; the path-string cycle guard is correctness-critical.
- `softDeleteSubtree` batches into one tx with narrow DELETE SQL.
- `block_aliases` lookup is indexed (`idx_block_aliases_ws_alias`).

**React rendering (`src/components`, `src/hooks`):**
- `DefaultBlockRenderer` is extensively `useMemo`'d (stable `resolveContext`, all slots memoized), limiting fan-out.
- `LazyBlockComponent`/`BlockChildren` virtualize via `LazyViewportMount` + id-only `useChildIds` deps.
- Global-state hooks (`useIsSelected`/`useInEditMode`/`useInFocus`/`useIsActivePanel`) are per-block boolean selectors with Object.is bail-out (deliberate O(N)-cheap-selector fan-out, documented).
- `babel-plugin-react-compiler` is enabled (`vite.config.ts:45`); compiled output of `MarkdownContentRenderer`/`BlockRef`/`BlockComponent` shows auto-memoization holds (the basis for the cross-area tension on finding 8).

**Editor & markdown (keystroke path):**
- `BlockEditor` keystroke commit is debounced 300 ms over uncontrolled CodeMirror (incremental dispatch, not full reparse); selection debounced 150 ms.
- While editing, `MarkdownContentRenderer` is unmounted (swapped to the CodeMirror renderer), so markdown is not reparsed per keystroke of the edited block.
- CodeMirror extensions are `useMemo`'d per edit-mount; autocomplete sources are async and context-gated.

**Plugins:**
- `backlinks`/`grouped-backlinks` hooks are content-keyed with memoized selectors and `useHandle` snapshot-identity dedup.
- `todo`/`geo` content decorators are gated on block type and cached per inner+kind.
- `references` rename/inline-deleted processors are field-scoped, pre-filtered, and serialized FIFO post-commit.

**Shortcuts & command palette:**
- `HotkeyReconciler.actions` is memoized on `[runtime, overridesGeneration]` — not recomputed per keystroke.
- Command palette filters internally (cmdk); typing does not re-render the parent or re-run `getEffectiveActions`.
- Per-keydown `dispatchPhase` is tiny (0-1 completed candidates); `applyKeybindingOverrides` has a 0-override fast path.

**Sync layer:**
- Upload batching is well-engineered: compaction, chunked upserts (`MAX_BLOCKS_PER_SUPABASE_UPSERT=500`), chunked PATCH RPC, batch caps.
- Download materialization windows at `DEFAULT_DRAIN_CHUNK=1000` with bulk chunked IN reads, `getMaterializability` memoized per workspace, two-phase gate, idempotent LWW.
- Workspace switch does not recreate the observer or trigger whole-graph reprojection (the prior sync-queue flood was already fixed).
- Upload triggers are column-narrow, diff-gated; `sync-status` query is throttled 1 s with a capped DISTINCT preview.

**Startup / cold-start / TTI:**
- `backfillBlockAliases/Types/Fts` are marker-gated single LIMIT-1 probes on warm start.
- `runAnalyzeIfStale` is `scheduleIdle`-deferred off the critical path.
- `registerServiceWorker` (30-min interval + visibility/online listeners) and `appUpdate` are trivial.

**Bundle & code-splitting:**
- `react-player`'s heavy media deps (hls.js/dashjs/media-chrome) are lazily imported and NOT in the startup graph.
- `lucide-react` tree-shakes to per-icon (no full barrel emitted).
- `react`/`react-dom` are externalized to esm.sh via importmap (verified non-dev URLs at build).
- `chrono-node` is 496 KB raw but only ~19 KB gz and genuinely needed early (references + daily-notes landing resolver) — not worth deferring.

**Hot utilities & extension runtime:**
- `fuzzyRank` candidate set is bounded (`ALIAS_CANDIDATE_CEILING=200`).
- `panelLayoutProjection` operates over a small panel subtree.
- `keyboardViewport` uses a single shared lazily-attached listener set (the good pattern `continuousGestures` should adopt).
- `FacetRuntime.read` caches per facet id; combine runs once per runtime swap.
