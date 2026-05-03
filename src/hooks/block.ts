/**
 * React adapters over the data-layer surface (spec §5.1, §9.5).
 *
 * Phase 2.D: every hook below is a thin wrapper over `useHandle(...)`,
 * which is the React→Handle bridge:
 *
 *   - `useHandle(handle)` — `useSyncExternalStore` over `handle.peek()`
 *     + `handle.subscribe()`. Optional `{selector, eq}` for derived
 *     selections with snapshot-identity memoization (so selectors that
 *     allocate, e.g. `doc => doc.children.map(...)`, don't violate
 *     React's "getSnapshot must return a stable reference" rule).
 *
 * Behavior contract per hook:
 *   - useData / useContent / useProperty: row-grain reactivity via
 *     Block (which implements Handle<BlockData|null>).
 *   - useChildIds / useChildren / useHasChildren: collection reactivity
 *     via `repo.children(id)`. The HandleStore + TxEngine fast path +
 *     row_events tail (Phase 2.C) drive invalidation; the per-hook
 *     `db.onChange({tables: ['blocks']})` polling that the old shape
 *     used is gone.
 *   - useBacklinks: handle via `repo.backlinks(id)`. Same story —
 *     no more ad-hoc throttled re-query, the engine handles it.
 *   - useParents: handle via `repo.ancestors(id)`.
 *   - useSubtree: handle via `repo.subtree(id)` (new in Phase 2.D).
 *
 * The legacy `useDataWithSelector` is gone — selectors move to the
 * `useHandle(handle, {selector})` option.
 */

import { isEqual } from 'lodash'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { BlockData, Handle, PropertySchema } from '@/data/api'
import { Block } from '../data/block'

const EMPTY_BLOCK_DATA_ARRAY: readonly BlockData[] = Object.freeze([])

const areSelectedValuesEqual = <T,>(left: T, right: T): boolean => {
  if (Object.is(left, right)) return true
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false
  }
  return isEqual(left, right)
}

const identitySelector = <V,>(v: V): V => v

export interface UseHandleOptions<T, S> {
  /** Project the handle's value before returning. The hook applies
   *  snapshot-identity memoization so a selector that allocates (e.g.
   *  `data => data.map(d => d.id)`) only re-runs when the underlying
   *  value actually changes — required for `useSyncExternalStore` to
   *  not loop. */
  selector?: (value: T | undefined) => S
  /** Custom equality test for the selected value. Default:
   *  Object.is + lodash.isEqual deep fallback for objects/arrays. */
  eq?: (a: S, b: S) => boolean
}

interface CommittedSelection<S> {
  hasValue: boolean
  value: S
}

/** React→Handle bridge. Subscribes to `handle.subscribe(...)`,
 *  reads `handle.peek()` for the current value, and (best-effort) kicks
 *  off `handle.load()` on mount when the handle is idle.
 *
 *  Without a selector, returns the handle's value (`T | undefined`).
 *  With a selector, returns the selected value `S`. */
export function useHandle<T>(handle: Handle<T>): T | undefined
export function useHandle<T, S>(
  handle: Handle<T>,
  opts: UseHandleOptions<T, S> & { selector: (value: T | undefined) => S },
): S

export function useHandle<T, S = T | undefined>(
  handle: Handle<T>,
  opts?: UseHandleOptions<T, S>,
): S {
  const selector = (opts?.selector ?? identitySelector) as (v: T | undefined) => S
  const equality = opts?.eq ?? areSelectedValuesEqual

  // Last value React actually committed for this hook instance. Read by
  // `getSelection` for cross-render reference stability; only ever
  // written by the post-commit useEffect below — so an abandoned render
  // (concurrent mode) can never pollute it. This is the structural
  // replacement for the previous useState-bag-mutated-during-render
  // shape (reviewer P3).
  const committedRef = useRef<CommittedSelection<S>>({
    hasValue: false,
    value: undefined as S,
  })

  // getSelection is recreated per `useMemo` invalidation key change
  // ([handle, selector, equality]) and carries closure-local memo state
  // that is keyed by source identity. Required by `useSyncExternalStore`,
  // which expects getSnapshot to return a stable reference for the same
  // observed state — selectors that allocate (e.g. `data => data.map(…)`)
  // would otherwise return a new array on each call.
  //
  // Why this is safe under concurrent mode (reviewer P3): the `let`
  // bindings are scoped to the closure useMemo returned. They never
  // appear on a shared object — an abandoned render that calls
  // getSelection only mutates locals on that render's closure (and only
  // when the closure is reused via stable deps; even then, mutations
  // are source-keyed memos, not selector identity, so the worst an
  // abandoned render can do is prime the memo with a now-superseded
  // (source, value) pair, which is harmless cache state). `committedRef`
  // — written ONLY in commit phase — provides the cross-render
  // reference-stability path, so an uncommitted render can never
  // poison what the committed subscription observes.
  /* eslint-disable react-hooks/immutability */
  const getSelection = useMemo(() => {
    let hasMemo = false
    let memoizedSource: T | undefined
    let memoizedSelection: S
    return (): S => {
      const source = handle.peek()
      if (hasMemo && Object.is(source, memoizedSource)) {
        return memoizedSelection
      }
      const next = selector(source)
      if (hasMemo && equality(memoizedSelection, next)) {
        memoizedSource = source
        return memoizedSelection
      }
      // Cross-render reference stability: when the latest committed
      // value is structurally equal, hand back its reference. Inline-
      // lambda selectors that decode/allocate fresh objects each render
      // (e.g. `useProperty(recentBlockIdsProp)`) would otherwise produce
      // a new !== reference per render even when the value is unchanged,
      // retriggering `useEffect` deps that close over the selection
      // (e.g. QuickFind's recents-load effect).
      if (
        committedRef.current.hasValue &&
        equality(committedRef.current.value, next)
      ) {
        hasMemo = true
        memoizedSource = source
        memoizedSelection = committedRef.current.value
        return memoizedSelection
      }
      hasMemo = true
      memoizedSource = source
      memoizedSelection = next
      return next
    }
  }, [handle, selector, equality])
  /* eslint-enable react-hooks/immutability */

  // Ensure-load: fire-and-forget on mount. Idempotent (LoaderHandle and
  // Block both dedup their inflight load promise). The status() check
  // prevents an unnecessary roundtrip when the handle is already ready.
  useEffect(() => {
    if (handle.status() === 'idle') {
      void handle.load().catch(() => {/* error stored on the handle */})
    }
  }, [handle])

  // Stable subscribe — only changes when the handle changes, so we
  // don't tear down handle.subscribe on every render that produces a
  // new selector. A listener firing for a value that didn't actually
  // change is bailed out by useSyncExternalStore: it re-checks
  // getSelection, finds the stable reference held by committedRef, and
  // skips the re-render.
  const subscribe = useCallback(
    (listener: () => void) => handle.subscribe(listener),
    [handle],
  )

  const value = useSyncExternalStore(subscribe, getSelection, getSelection)

  // Commit-phase update of the committed-value ref. React only runs
  // this for the render that actually committed; abandoned renders
  // skip it, which is what makes `committedRef` immune to the
  // concurrent-mode hazard the reviewer flagged.
  useEffect(() => {
    committedRef.current = {hasValue: true, value}
  }, [value])

  return value
}

// ════════════════════════════════════════════════════════════════════
// Row-grain hooks (Block-as-Handle)
// ════════════════════════════════════════════════════════════════════

/** Reactive read of the block's BlockData snapshot. `undefined` until
 *  the row is loaded or when confirmed-missing — callers that need the
 *  loading-vs-missing distinction read `block.status()` / `block.peek()`
 *  directly. */
export const useData = (block: Block): BlockData | undefined =>
  useHandle(block, {selector: doc => doc ?? undefined})

/** Reactive content read. `''` when not loaded. */
export const useContent = (block: Block): string =>
  useHandle(block, {selector: doc => doc?.content ?? ''})

/** Reactive typed property read + setter. The setter opens its own tx
 *  via `repo.mutate.setProperty` (whose scope derives from
 *  `schema.changeScope` — UiState writes go local-ephemeral, content
 *  writes upload). Returns `[value, setValue]` where value falls back
 *  to `schema.defaultValue` when the property isn't present. */
export function useProperty<T>(
  block: Block,
  schema: PropertySchema<T>,
): [T, (value: T) => void] {
  const value = useHandle(block, {
    selector: doc => {
      if (!doc) return schema.defaultValue
      const stored = doc.properties[schema.name]
      if (stored === undefined) return schema.defaultValue
      return schema.codec.decode(stored)
    },
  }) as T

  const setValue = useCallback(
    (next: T) => { void block.set(schema, next) },
    [block, schema],
  )

  return [value, setValue]
}

/** Alias kept for migration parity with the legacy hook name. */
export const usePropertyValue = useProperty

// ════════════════════════════════════════════════════════════════════
// Collection hooks (LoaderHandles)
// ════════════════════════════════════════════════════════════════════

const EMPTY_STRING_ARRAY: readonly string[] = Object.freeze([])

/** Reactive child-id list (in `(orderKey, id)` order). Returns `[]`
 *  while the handle is loading or for a leaf block.
 *
 *  Backed by `repo.childIds(id)` rather than `repo.children(id)` —
 *  declares only a `parent-edge` dep, so unrelated child mutations
 *  (focus moves on a UI-state child, content edits, etc.) don't
 *  invalidate the handle at all. The list-shape consumers
 *  (`BlockChildren`, `LayoutRenderer`'s panel iteration) are the hot
 *  path that motivated the split.
 *
 *  Opts into `{hydrate: true}` so the loader runs the full
 *  CHILDREN_SQL and hydrates each child row into the cache. Without
 *  this, every LazyBlockComponent that mounts on intersection would
 *  pay its own `block.load()` round-trip and the page would visibly
 *  pop in block-by-block. The lean variant on `repo.childIds` is for
 *  non-rendering callers (counting / id-only scans). */
export const useChildIds = (block: Block): string[] =>
  useHandle(block.repo.query.childIds({id: block.id, hydrate: true}), {
    selector: ids => ids ?? EMPTY_STRING_ARRAY,
  }) as string[]

/** Reactive child Block facades. Same structural-equality bail-out
 *  story as `useChildIds` — `repo.block(id)` is identity-stable, so the
 *  Block[] returned compares equal across re-fires when the id list is
 *  unchanged, and `useHandle` hands back the previously-committed
 *  reference. Critical for callers like `LayoutRenderer` whose JSX
 *  builds context-provider overrides per panel; without ref stability
 *  here, every UI-state child mutation would propagate a fresh context
 *  value to the entire block subtree. */
export const useChildren = (block: Block): Block[] => {
  const repo = block.repo
  return useHandle(block.repo.query.children({id: block.id}), {
    selector: data => (data ?? EMPTY_BLOCK_DATA_ARRAY).map(d => repo.block(d.id)),
  })
}

/** Whether the block has children. Backed by `repo.childIds` so child
 *  content edits don't even invalidate the handle (vs. the prior
 *  `repo.children`-backed shape, which fired on every descendant row
 *  change and only bailed at the React boundary via the boolean
 *  selector).
 *
 *  Shares `useChildIds`'s hydrating handle slot (`{hydrate: true}`)
 *  rather than spinning up a separate lean handle for the same parent
 *  — every block that renders a bullet (BlockBullet) also renders its
 *  children (BlockChildren), so the two hooks subscribe to the same
 *  parent in lockstep and there's nothing to gain by splitting them. */
export const useHasChildren = (block: Block): boolean =>
  useHandle(block.repo.query.childIds({id: block.id, hydrate: true}), {
    selector: ids => (ids ?? EMPTY_STRING_ARRAY).length > 0,
  })

/** Reactive parent chain (root → … → immediate parent), excluding
 *  `block` itself. `repo.ancestors()` walks leaf-to-root, so reverse
 *  for the breadcrumb-friendly order callers expect. */
export const useParents = (block: Block): Block[] => {
  const repo = block.repo
  return useHandle(block.repo.query.ancestors({id: block.id}), {
    selector: data => (data ?? EMPTY_BLOCK_DATA_ARRAY).map(d => repo.block(d.id)).reverse(),
  })
}

/** Reactive backlinks — every block in `block`'s workspace whose
 *  `references` field points at `block.id`. The new `core.backlinks`
 *  query takes `workspaceId` as an arg (no implicit cache resolution
 *  inside the loader); we resolve it here from `useData(block)`,
 *  falling back to `repo.activeWorkspaceId` when the block isn't
 *  loaded yet — same fallback chain the legacy `repo.backlinks(id)`
 *  factory used. The query's resolver short-circuits on empty
 *  `workspaceId` to `[]`, so the no-workspace case still produces a
 *  stable empty handle without a SQL hit. */
export const useBacklinks = (block: Block): Block[] => {
  const repo = block.repo
  const data = useData(block)
  const workspaceId = data?.workspaceId ?? repo.activeWorkspaceId ?? ''
  return useHandle(
    repo.query.backlinks({workspaceId, id: block.id}),
    {
      selector: data => (data ?? EMPTY_BLOCK_DATA_ARRAY).map(d => repo.block(d.id)),
    },
  )
}

/** Reactive subtree (root + descendants), in SUBTREE_SQL order. New in
 *  Phase 2.D for parity with the four `repo.X` factories; existing
 *  call sites can adopt incrementally. */
export const useSubtree = (block: Block): Block[] => {
  const repo = block.repo
  return useHandle(block.repo.query.subtree({id: block.id}), {
    selector: data => (data ?? EMPTY_BLOCK_DATA_ARRAY).map(d => repo.block(d.id)),
  })
}
