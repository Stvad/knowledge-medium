# Module-singleton reset audit (test-isolation sweep)

Follow-up to the test-flakiness work in #112 (last open item: "module-singleton
reset audit — verify-only; no observed failure"). Vitest runs with `isolate: true`
(`maxWorkers: '100%'`), so each test **file** gets a fresh module graph. The only
state-leak vector module singletons can introduce is therefore **within-file,
cross-test** contamination: a module-scope mutable value that code-under-test
writes and that is not reset between tests in the same file.

## Conclusion

**No unguarded contamination vector found.** Every module-level singleton that is
*both* mutated at runtime *and* exercised across more than one test in a file is
already reset — either through a dedicated `__reset*` hook wired into the file's
`beforeEach`/`afterEach`, or by the test setting the value back to its default.
Everything else is structurally safe (write-once, `WeakMap`, immutable, keyed so
collisions can't happen, or only reachable from app-bootstrap code that no test
drives across tests). No production change was required for this item; the
`#85` reprojection-quiescence fix shipped in the same PR is unrelated to this
conclusion.

## Method

Swept `src/` (excluding tests) for module-scope mutable state: top-level `let`,
`const x = new Map/Set/WeakMap()/[]` used as a registry/cache, lazy singletons
(`let instance; … instance ??= …`), and mutable module objects. For each, asked:
is it mutated at runtime, is it reachable from a test that runs >1 case, and is
it reset between those cases? Only the intersection (mutated ∧ multi-test ∧
not-reset) is a flake risk.

## Already guarded — has a reset hook wired into tests

| Singleton | Reset hook |
| --- | --- |
| `data/repo.ts` `reprojectionMarkers` | `__resetReprojectionMarkerCache` |
| `extensions/blockGestureConflicts.ts` `activeGestureByBlockId` | `__resetBlockGestureClaimsForTest` |
| `extensions/compileExtensionModule.ts` `compileImpl` / `defaultCache` | `__setCompileImplForTest` / `__resetCompileCacheForTest` |
| `plugins/agent-runtime/describeRuntime.ts` `cachedApiSurface` | `__resetApiSurfaceCacheForTest` |
| `plugins/app-intents/appIntents.ts` `consumed` | `__resetAppIntentForTesting` |
| `plugins/spatial-navigation/walker.ts` `lastPositionByPanel` | `__resetSpatialNavigationForTesting` |
| `utils/dialogs.ts` `nextId` / `queue` | `__resetDialogsForTests` |
| `utils/layoutSessionId.ts` `memoizedLayoutSessionId` | `__resetLayoutSessionIdForTesting` |

## Already guarded — reset in-test (no dedicated hook needed)

- **`plugins/theme-toggle/theme.ts`** `registry` / `registryById` — both
  `effect.test.ts` and `plugin.test.ts` call `setThemeRegistry([FALLBACK_THEME])`
  in `beforeEach` *and* `afterEach`. (This is the same global state that made
  the "theme-toggle `dispose()`" item in #112 a verified non-issue.)
- **`plugins/srs-rescheduling/srsClipboard.ts`** `entry` — every `setSrsClipboard`
  mutation lives inside the `srs.cut / srs.paste flow` describe, which has
  `afterEach(clearSrsClipboard)`.

## Structurally safe — no reset required

- **Write-once / idempotent memoization (stable value):**
  `agent-runtime/bridge.ts` `bridgeClientId` (a `crypto.randomUUID()` cached
  once), `data/repoProvider.ts` `opfsProbe` (a probe that settles once per
  process). The cached value does not depend on per-test state, so reuse across
  tests is benign.
- **`WeakMap` decorator caches:** `plugins/todo/index.tsx` `todoDecoratorCache`,
  `plugins/geo/geoContentDecorator.tsx` `cache`. Keyed by `BlockRenderer`
  identity; entries are GC'd when the renderer is dropped — no cross-test bleed.
- **Immutable-after-init constants:** `data/repo.ts` `KERNEL_TYPES` /
  `KERNEL_PROPERTY_SCHEMA_MAP`, `spatial-navigation/walker.ts`
  `NON_NAVIGABLE_SURFACES`, `roam-import/plan.ts` `ROAM_COMMANDS_*`,
  `typedBlockQuery.ts` comparator sets, the various `uploadErrorClassifier.ts`
  code sets. Built at import, never written.
- **Error-swallowing FIFO chain:** `plugins/references/renameProcessor.ts`
  `renameQueue`. The chain anchor is re-armed as
  `next.then(() => {}, () => {})`, so it can never settle rejected — a failed or
  pending rename in one test cannot block or contaminate the next. Renames are
  post-commit and awaited via `awaitProcessors()`, so the queue is drained at
  test end anyway.
- **Monotonic counters:** `DateScrubOverlay.tsx` `nextScrubSession`,
  `utils/propertyNavigation.ts` `propertyCreateRequestSeq`. Only ever increment;
  uniqueness (their sole purpose) is preserved across tests — the same property
  the dueCards `tx_id` fix in #112 relied on. No test asserts a specific value.
- **Gesture-lifecycle maps:** `daily-notes/dateScrubGesture.ts`
  `singleByBlockId` / `multiByBlockId`, `vim-normal-mode/interactions.ts` and
  `swipe-quick-actions/swipeGesture.ts` `touchStartByBlockId`. Written on
  `touchstart`, deleted on `touchend`/`touchcancel`; empty once a gesture
  completes. A test would have to abandon a gesture mid-flight to leak, and none
  do.
- **Idempotency / guard flags:** `roam-import/runtime.ts` and
  `data/metricsConsoleHook.ts` `installed`, `utils/viewTransition.ts`
  `inTransition`. "Install once" / re-entrancy guards; no test re-installs across
  cases.

## Reachable only from app-bootstrap — not exercised across tests

`data/repoProvider.ts` (`dbsByUser`, `initPromises`, `activeUserId`,
`connectChain`) and `App.tsx` (`initialLayoutCache`, `landingRuntimeCache`) are
per-user / per-workspace caches on the live provider + root component. No test
imports these modules, so there is no within-file multi-test path that mutates
them. **If** a future full-app render test mounts the root across cases reusing a
workspace id / user id, give these a `__reset*` hook and wire it into that test's
`beforeEach` — until then there is nothing to reset.

> Out of scope (noted, not a test issue): `dbsByUser` / `initPromises` are never
> evicted, so a very long-lived app session accumulates one entry per user ever
> signed in. That is a production memory observation for `docs/follow-ups.md`,
> not a test-isolation flake.

## How to extend this audit

When adding module-scope mutable state, check the intersection above. If it is
mutated at runtime and a test exercises it across more than one case, add a
`__reset<Name>ForTest()` export and call it from the test's `beforeEach`
(matching the eight files in the first table). If it is write-once, a `WeakMap`,
immutable, a monotonic counter, or gesture-lifecycle-scoped, it needs nothing.
