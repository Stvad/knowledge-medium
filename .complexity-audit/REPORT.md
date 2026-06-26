# Complexity Audit Report — knowledge-medium

## Executive summary

The codebase is in good shape: the deliberate-complexity zones (sync/CRDT, e2ee, reprojection, fractional ordering, data kernel, the new verb-facet seam) all held up under scrutiny — several plausible-looking simplifications there are genuinely load-bearing and were rejected. The actionable wins are concentrated in leaf utilities and plugin glue:

- **Drop one unused dependency.** `react-hotkeys-hook@^5.2.4` (package.json:65) has zero imports; the hotkey system runs entirely on `tinykeys`. One-line delete + reinstall.
- **Delete 4 dead modules/exports** with zero callers: `src/utils/async.ts`, `src/utils/object.ts`, `refPropertyEditorOverride.ts`, and `createAction` (shortcuts/utils.ts). ~50 LOC, no behavior change.
- **Finish the in-progress `CallbackSet` migration.** At least 3 modules still hand-roll the listener-Set fan-out that `src/utils/callbackSet.ts` exists to replace — and the swap fixes a real latent bug (no snapshot-on-iterate) for free.
- **Centralize the genuinely-duplicated helpers** (`uniqueStrings`, `hasOwn`/`Object.hasOwn`, the three identical Zod backlink schemas, `isReadOnlyBlock`). All byte-identical, none load-bearing, all low-risk.
- **A handful of trivial std-API swaps** pay rent only as consistency: `chunked`→lodash `chunk`, manual hex→`@scure/base` `hex.encode`, `Math.random` UUID→`uuid` `v4`. Adopt opportunistically, not as a dedicated PR.
- **One real readability win in correct code:** `markdownInlineFormatCommand` (codemirror.ts) collapses three near-duplicate marker branches into two, verified behavior-equivalent against the existing tests.

Net: a few clear deletes/dedups worth doing now; most std-API swaps are cosmetic and best folded in when the file is next touched.

---

## Dead code

**Remove the unused `react-hotkeys-hook` dependency** — `package.json:65`
Declared as a runtime dep with zero imports anywhere in `src/`/`packages/`; the entire shortcut system runs on `tinykeys` (`src/shortcuts/HotkeyReconciler.tsx`). Delete the line and re-run `yarn install` to drop it from the lockfile.
`[adopt · trivial · ~1 LOC · low]`

**Delete dead module `src/utils/async.ts`** — `src/utils/async.ts:6`
A whole file for `delay = (ms) => new Promise(r => setTimeout(r, ms))` with no module-path importers (it's only swept in by an `import.meta.glob`, never referenced). Delete it; the kernel-types stub regenerates on build. If a sleep is ever needed, inline it (and AGENTS.md prefers polling over sleeps anyway).
`[adopt · trivial · ~7 LOC · low]`

**Delete dead module `src/utils/object.ts`** — `src/utils/object.ts:6`
`removeUndefined<T>` has zero callers — an orphan from a completed migration (last touched in the property-infra migration). Delete it; if ever needed, `omitBy(obj, v => v === undefined)` from the already-installed lodash-es covers it.
`[adopt · trivial · ~9 LOC · low]`

**Delete dead module `refPropertyEditorOverride.ts`** — `src/components/propertyEditors/refPropertyEditorOverride.ts:13,23`
`defineRef[List]PropertyEditorOverride` are thin wrappers over the generic `definePropertyEditorOverride`, with zero callers and no exposure via the extensions API barrel (so unreachable even dynamically). Every real override site uses the generic factory directly. Delete the file.
`[adopt · trivial · ~31 LOC · low]`

**Delete unused `createAction`** — `src/shortcuts/utils.ts:98-100`
An identity wrapper (`config => ({...config})`) with zero call sites; scaffolding that was never wired up. The actively-used sibling helpers (`makeNormalMode`, `makeMultiSelect`, etc.) remain. Delete lines 98-100.
`[adopt · trivial · ~3 LOC · low]`

**Delete dead `ClientLocalSettings` methods `getString`/`setString`/`has`** — `src/utils/ClientLocalSettings.ts:30, 58, 83`
Only `get`/`set`/`remove` are ever called (both consumers + the test file document this). ~36 LOC of method + JSDoc for callers that don't exist; trivially re-addable if raw-string storage is ever needed.
`[adopt · trivial · ~36 LOC · low]`

**Share the duplicated `isErrnoException` guard** — `packages/agent-cli/src/cli.ts:58-59`, `config.ts:39-40`
Byte-identical Node `ErrnoException` type guard defined in both files. Move to one small shared module in the 6-file package and import. Real but marginal — worth doing only when touching these files (it adds a file + two imports for ~3 LOC).
`[consider · trivial · ~3 LOC · low]`

---

## Wheel-reinvention

**Use lodash-es `chunk` instead of hand-rolled `chunked`** — `src/services/powersync.ts:314-320`
A textbook fixed-size chunker duplicating `lodash-es.chunk` (already installed and used across `src/`). Edge-case parity confirmed (empty/oversize/partial-trailing); both call sites pass positive constants. The surrounding RPC batch-size/error-classification logic is the load-bearing part and is untouched. Import `chunk` from `lodash-es`, delete lines 314-320, replace the two call sites.
`[adopt · trivial · ~6 LOC · low]`

**Use `@scure/base` `hex.encode` for manual byte→hex** — `src/extensions/compileExtensionModule.ts:117-118`
`hexEncoder` hand-rolls `Array.from(bytes,...).join('')` to hex-encode a SHA-256 digest; `@scure/base` (already a dep, used in `src/sync/crypto/`) emits byte-identical lowercase hex via `hex.encode()`. Net-neutral on lines; value is consistency with the two sibling scure wrappers. Note: the API is `hex.encode()` (sync), not `bytesToHex`.
`[consider · trivial · ~0 LOC · low]`

**Use `uuid` `v4` instead of the hand-rolled random-id fallback** — `src/utils/exportSqliteDb.ts:287-292`
`randomId()` does a `crypto.randomUUID` check + `Math.random` fallback for a temp OPFS filename; `uuid` (v14, installed, used in sibling `src/utils` files) is the house idiom. Browser main-thread code, so `uuidv4()` runs fine. `import { v4 as uuidv4 } from 'uuid'`, drop the helper. (Entropy is irrelevant here — the win is consistency.)
`[adopt · trivial · ~6-8 LOC · low]`

**Use lodash-es `isEqual` for predicate comparison** — `src/plugins/backlinks/query.ts:65-66`
`samePredicate` uses `JSON.stringify(a) === JSON.stringify(b)`; `isEqual` is already the house idiom (`hooks/block.ts`, `handleStore.ts`) and avoids the theoretical key-order edge case. Correctness rationale is theoretical here (stable key order in practice), so it's idiom alignment, not a bug fix. Note: the second cited site (`BacklinkFilters.tsx:58`) produces a React `key` string and **cannot** use `isEqual` — convert only `samePredicate`.
`[consider · trivial · ~0 LOC · low]`

**Centralize the hand-rolled `clamp` (3 copies)** — `src/plugins/swipe-quick-actions/SwipeActionMenu.tsx:126-127`, `src/plugins/spatial-navigation/walker.ts:148-149`, `src/components/ui/floating-listbox.tsx:30-31`
Three identical `Math.max(lo, Math.min(hi, n))` clamps; lodash-es `clamp` (same arg order/semantics for finite inputs) or one shared helper replaces them. The domain-specific `clamp*` variants (radius, days, ratios) are NOT duplicates — leave them. Pure style; do it opportunistically.
`[consider · trivial · ~6 LOC · low]`

**Use lodash-es `countBy`** — `src/plugins/roam-import/report.ts:129-136`
Custom Map-based frequency counter in the roam-import diagnostics generator. lodash `countBy` returns a plain object, so it needs `new Map(Object.entries(...))` glue (or rewriting `countLines` to take an object) — net LOC is roughly neutral, and the `Map` return mildly sidesteps prototype-key risk from arbitrary Roam keys. Marginal; only worth it inside a broader lodash-consolidation pass.
`[consider · trivial · ~0 LOC · low]`

**Back `FloatingListbox` with the existing `@floating-ui/dom` wrapper** — `src/components/ui/floating-listbox.tsx:33-102` (duplicates `anchored-floating.ts:60-136`)
`placementStyle()` + a manual resize/scroll/`viewportVersion` effect hand-roll anchored-popover flip/clamp/size that the sibling `useAnchoredFloating` already does via `@floating-ui/dom` (`flip`/`shift`/`size` + `autoUpdate`). Two positioning engines for one primitive in one directory; the hand-rolled tracker is also strictly weaker (misses ancestor-scroll + ResizeObserver), so the swap is also a drift fix for scrollable panels. **Caveats:** the hook needs a thin live-`Element` overload (not just the frozen rect) to actually gain `autoUpdate`, the `size` middleware must be extended to also constrain width, and 5 live editors must move to the callback-ref pattern. Parity refactor with zero test coverage on either file — QA manually.
`[consider · small · ~60 LOC · medium]`

---

## Duplicate logic

**Dedup the three identical Zod backlink schemas** — `src/plugins/backlinks/query.ts:25-40`, `src/plugins/grouped-backlinks/query.ts:74-89`
`referenceFilterSchema`/`blockPredicateSchema`/`backlinksFilterSchema` are byte-for-byte identical in both plugins — and a **third** copy is inlined in the kernel at `src/data/internals/kernelQueries.ts:644-654`, the canonical validator for the `core.typedBlockIds` query both plugins delegate to. All three validate the same `BlockPredicate` type; divergence would be a latent bug. Home the schemas in `src/data/api/` (where the types already live and are re-exported) so the kernel can import them too — **not** a `plugins/backlinks/` path (the kernel must not depend on `plugins/`). Expose the bare object; let each site apply `.optional()`.
`[adopt · small · ~30 LOC · low]`

**Centralize `uniqueStrings` (4 copies)** — `src/plugins/block-tagging/config.ts:8-16`, `src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.tsx:35-36`, `src/plugins/grouped-backlinks/config.ts:68-75`, `src/plugins/roam-import/properties.ts:53-59`
Four trim-dedupe-drop-empty implementations with identical output (order-preserving). A single `uniqueStrings(value: unknown): string[]` is a strict superset of all four — home it in the existing `src/utils/array.ts`. **Not** a lodash swap (lodash `uniq` doesn't trim/drop-empties). **Do not** fold in roam-import's `uniqueExactStrings` — it deliberately skips trimming to preserve verbatim aliases.
`[adopt · small · ~12-20 LOC · low]`

**Share the duplicated roam-import dedupe helpers** — `src/plugins/roam-import/properties.ts:53-74`, `typeCandidates.ts:57-67`, `import.ts:722-732`
The four roam-import helpers collapse to exactly **two** semantics, each re-declared once: trim-and-dedupe (`uniqueStrings` == `uniqueNonEmpty`) and exact-dedupe (`uniqueExactStrings` == `uniqueExactAliases`). Export the two from one module and delete the re-declarations. Keep the two semantics distinct — the exact variant intentionally preserves verbatim alias/title strings. (No clean std-API fits: lodash `uniq` does neither trim nor empty-filter.)
`[consider · small · ~18 LOC · low]`

**Replace 4 copies of `hasOwn` with native `Object.hasOwn`** — `src/components/propertyPanel/model.ts:107-108`, `actions.ts:11-12`, `BlockProperties.tsx:45-46`, `propertyPanelSections.ts:26` (+2 in `roam-import/`)
Four byte-identical `Object.prototype.hasOwnProperty.call` wrappers (plus two more in roam-import). The codebase **already** uses native `Object.hasOwn` at `grouped-backlinks/config.ts:84` against the same runtime, so it's proven safe. Either one shared helper or `Object.hasOwn` directly; for TS types on the latter, add `ES2022.Object` to `lib` (target only controls syntax, not global typings).
`[adopt · trivial · ~8 LOC · low]`

**Finish the `CallbackSet` migration in listener fan-out modules** — `src/utils/startupTimeline.ts:80-90`, `src/utils/keyboardViewport.ts:36-52` (+ secondary: `appUpdate.ts`, `persistenceStatus.ts`, `expansionStore.ts`)
Hand-rolled `Set<() => void>` + notify loops that `src/utils/callbackSet.ts` exists to consolidate (already adopted at 12+ sites; its header names itself the migration target). The swap also fixes a real latent bug: these loops iterate the **live** set, so a listener that unsubscribes mid-callback can skip a neighbor — `CallbackSet.notify()` snapshots first and adds error isolation. `startupTimeline` and `keyboardViewport` (preserve its lazy attach/detach via `.size`) are the clean wins; the secondary sites have surrounding coupled logic, so only their fan-out core is replaceable. LOC reduction is ~30 realistic, not the headline 50.
`[adopt · small · ~30 LOC · low]`

**Replace `expansionStore`'s hand-rolled listener Set with `CallbackSet`** — `src/plugins/backlinks/inline-counts/expansionStore.ts:12-24`
Same pattern as above and a strict improvement (snapshot-on-iterate + exception isolation). Ephemeral session-scoped view state, explicitly not synced. Swap to `new CallbackSet('backlink-expansion')`; `subscribe = subscribers.add`, `emit` → `subscribers.notify()`. (Leave the separate `expanded` Set<string> alone.)
`[adopt · trivial · ~10 LOC · low]`

**Share `isReadOnlyBlock` (3 copies)** — `src/plugins/backlinks/BacklinksFilterPropertyEditor.tsx:11-15`, `grouped-backlinks/GroupedBacklinksConfigEditor.tsx:38-42`, `block-tagging/BlockTagsConfigEditor.tsx:8-12`
Three byte-identical narrowing helpers, each re-deriving the same defensive cast because `PropertyEditorProps.block` is deliberately typed `unknown`. Extract one shared util (the sibling `workspaceIdFromBlock` could co-locate). Marginal value, no new shared dir exists yet — low priority.
`[consider · trivial · ~8 LOC · low]`

**Dedup `truncate` (8 copies, not 2)** — `src/plugins/backlinks/BacklinkFilters.tsx:55-56`, `grouped-backlinks/GroupedBacklinksConfigEditor.tsx:32-33` (+6 more: alias toasts, geo, quick-find, system-status, merge-blocks)
Eight hand-rolled string truncators that diverge in ellipsis (`…` vs `...`), slice math (one is off-by-one), and boundary. The as-written 2-site change is too narrow to bother; real value is consolidating all 8 into one shared helper (or lodash-es `truncate`, noting its `length` counts the omission) and standardizing the ellipsis. Intentionally normalizes call sites that currently differ.
`[consider · small · ~12 LOC · low]`

**Extract the shared paste block-grouping pipeline** — `src/paste/operations.ts:285-305` and `354-374`
`pasteMultilineText` and `pasteEditModeMultilineText` share a character-identical ~28-line region (filter + `existingParentGroups` grouping + `orderKeysByParsedId` key-assignment) differing only in `absorbedRoot?.id` vs `plan.absorbedRoot.id`; only the final `tx.create` loop genuinely diverges (focus/suffix tracking). Extract a helper taking the absorbed-root id as a parameter (it can be undefined in the outline path). The fractional-ordering invariants live in the `keysBetween`/`insertionForSiblingRun` primitives this code merely calls — **not** in the duplicated glue — so extraction is safe, and `operations.test.ts` covers both paths (incl. the #198 tied-sibling case). Hot, invariant-adjacent path; do it guarded by the existing tests.
`[consider · small · ~40 LOC · low]`

**Share the `isMacPlatform` check** — `src/plugins/keybindings-settings/keyCapture.ts:16-17`, `KeyCaptureInput.tsx:51`
`KeyCaptureInput` imports from the same module yet inline-reimplements the identical `/Mac|iPod|iPhone|iPad/.test(navigator.platform)` regex. Export the (already-`navigator`-guarded) `isMacPlatform()` and reuse it. (Several other differently-spelled platform checks exist across the repo — a fuller consolidation is worthwhile but out of scope here.)
`[adopt · trivial · ~3 LOC · low]`

**Extract `buildChildrenByParent` in panel layout projection** — `src/utils/panelLayoutProjection.ts:51-111`
`panelRowsInLayoutOrder` and `layoutSlotsFromRows` rebuild a byte-identical `childrenByParent` map (lines 55-61 / 87-93, ~7 LOC). Extract `buildChildrenByParent(rows): Map<...>` (keep the explicit `if (!row.parentId) continue` skip — don't rely on a lodash `groupBy` `undefined` bucket). **Reject the proposed `traverseLayoutTree` generic:** the two visitors genuinely diverge in output shape (flat vs nested), stack handling (dissolve vs preserve), and filtering, so unifying them adds indirection without removing real duplication. Adopt the map-builder only.
`[consider · trivial · ~7 LOC · low]`

**Replace `localDayKey` with `formatIsoDate`** — `src/plugins/srs-review/reviewProgress.ts:5-6`
`localDayKey` re-implements `formatIsoDate` (`src/utils/dailyPage.ts`) without `padStart`. The "inconsistency risk" is **not** real — the value is only ever self-compared. But the swap is **not** a pure refactor: `progress.day` is persisted, so on deploy day every in-flight saved session's unpadded key (`2026-6-5`) would mismatch the new padded key and be silently discarded as a midnight rollover (a one-time resume-state loss). Per the data-preservation guidance, only do this with a deliberate tolerate-old-keys path. Marginal value, real-data hazard.
`[consider · trivial · ~2 LOC · low]`

---

## Over-complex

**Collapse the redundant marker branches in `markdownInlineFormatCommand`** — `src/utils/codemirror.ts:31-91`
Three near-identical unwrap branches; the empty-cursor case (1) is a strict special case of the surrounded-selection case (3). Consolidate to: surrounded-check first (handles empty + non-empty), then the non-empty-only markers-in-selection case, else wrap. Verified behavior-equivalent: all 5 existing tests plus 3 extra edge cases produced byte-identical change specs. Plain CodeMirror formatting (bold/italic/code) — no load-bearing zone. The one ordering subtlety (gate case 2 behind `if (!range.empty)` after the surrounded check) is handled.
`[adopt · small · ~12-18 LOC · low]`

**Swap `blockFingerprint`'s `JSON.stringify` for lodash `isEqual`** — `src/data/blockCache.ts:14-15, 132`
The dedup gate is load-bearing (it suppresses no-op `notify()` fan-out — tested), but the `JSON.stringify` **implementation** is not. `isEqual` (already this kernel's idiom at `handleStore.ts:508`) short-circuits on the first differing field instead of fully serializing large content/properties, and is order-insensitive for the `properties` map (so any change is in the safe direction — more dedup hits, never a false-equal). Note the finding overstates the cost: `applyIfNewer` does **not** double-fingerprint (it gates on the integer `updatedAt` first), so the win is early-bail on large blocks + property-key-order correctness, not the claimed 2× serialization. Hot kernel path; one-line swap, run `yarn run check`.
`[consider · small · ~0 LOC · low]`

**Consider a shared `toHex` helper for the two SHA-256 hex hand-rolls** — `src/plugins/birthday/gate.ts:37-43` (+ `src/plugins/agent-runtime/tokens.ts:38`)
`sha256Hex` hand-rolls byte→hex; identical to the (already-installed, already-used) `@scure/base` `hex.encode`. The hand-rolled idiom is correct and unremarkable, so this only pays rent if you fold **both** sites into one shared helper. **The original finding's proposed API is wrong** — `@scure/base` exports `hex.encode(bytes)` (sync), not `bytesToHex`/`bufToHex`, and there is no `await`.
`[consider · trivial · ~3 LOC · low]`

---

## Rejected / load-bearing (do NOT touch)

- **`isThenable`/`andThen` in `verbFacet.ts:122-134`** — not a Promise polyfill to flatten: `runSync` must stay synchronous at the DOM `preventDefault` boundary (paste/navigation read the result in the same tick). The proposed `Promise.resolve().then()` would turn `runSync` into a Promise and break the fire-and-forget passthrough contract; both are pinned by tests.
- **`defineVerbFacet` (486 LOC, `verbFacet.ts`)** — "zero in-tree contributors" is expected: it's a **published extension-API seam** (exported via `@/extensions/api.ts`, taught in the authoring catalog, spec'd in `docs/extensibility-axes.md`) that DB-installed user extensions target. Retiring it is a product/API-deprecation decision, not a mechanical simplification. `risk: high`.
- **`areSelectedValuesEqual` in `hooks/block.ts:56-66`** — the `Object.is` fast path earns its keep on a per-render `useSyncExternalStore` hot path dominated by primitives, and bare `isEqual` would silently change `+0/-0` semantics. Not equivalent.
- **`reprojectionMarkerKey`/backfill key helpers (`repo.ts:208-215`)** — load-bearing idempotency-key consistency: read-site and write-site keys must be derived byte-identically or reprojection/backfills re-run forever. The persisted format is a contract (pinned by a test). Inlining reintroduces the exact drift bug the helper removes.
- **`ClientLocalSettings` as a whole (`src/utils/ClientLocalSettings.ts`)** — not a redundant 1:1 Storage wrapper: it does JSON ser/de (both consumers store structured data), is a DI seam two test suites inject through, and guards quota/private-mode/corrupt-JSON failures. (Its `getString`/`setString`/`has` methods are separately dead — see Dead code.)
- **Hand-rolled command guards in `agent-runtime/commands.ts:74-118`** — Zod already runs upstream; these guards validate/**coerce** the intentionally-`looseObject` passthrough fields (sql/eval/create-block bodies) the bridge must forward verbatim. Making schemas strict would silently drop command payloads (pinned by `protocol.test.ts:26`). `risk: high`.
- **`normalizeTokenStore` in `agent-cli/cli.ts:173-201`** — not pure validation: it migrates the legacy pre-profiles `{token,savedAt}` shape, normalizes/rejects profile keys, and skip-bad-keep-good. The proposed `.parse()` + empty-profiles fallback would silently discard stored auth tokens on the next load.
- **`groupBy` in `CommandPalette.tsx:15,48`** — lodash `groupBy` **is** the standard solution; the proposed hand-rolled `reduce`/`Map.groupBy` is the wheel-reinvention (and `Map.groupBy` is ES2024, unavailable at the ES2020 target). Misclassified.
- **Error-translation in `_runAndDispatch` (`repo.ts:1098-1139`)** — a single centralized translation site (not duplicated); moving it into the pure `runTx` commit pipeline would couple it to `Repo`'s listener/toast concerns and require async post-rollback DB reads. Breaks a deliberate boundary.
- **Dedupe helper in `continuousGestures.ts:198-204`** — already idiomatic `[...new Set(x)]`; the proposed "fix" is the same pattern minus the documented `'none'`-dominates guard, i.e. a behavior change for ~1 LOC. Style-only churn on tested code.

### Notes on scope/effort
The `cn()` className-consistency finding (DefaultBlockRenderer, propertyPanel, etc.) verified real but is purely cosmetic with net-neutral LOC and no class-merge benefit currently exercised — fold in opportunistically when touching those files; not worth a dedicated PR. Several "wheel-reinvention" std-API swaps above are similarly cosmetic (`[consider]`, ~0 LOC) and are batched best as a single lodash/@scure-consolidation pass rather than individual changes.