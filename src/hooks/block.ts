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
  useState,
  useSyncExternalStore,
} from 'react'
import type { BlockData, Handle, PropertySchema } from '@/data/api'
import { Block } from '@/data/internals/block'

const EMPTY_BLOCK_DATA_ARRAY: readonly BlockData[] = Object.freeze([])

/** Sentinel used by the snapshot-identity memo to distinguish "no source
 *  has been observed yet" from `undefined` (a valid first source). */
const SELECTOR_NEVER_SET = Symbol('useHandle.selectorNeverSet')
type SelectorNeverSet = typeof SELECTOR_NEVER_SET

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

interface UseHandleState<T, S> {
  selector: (v: T | undefined) => S
  equality: (a: S, b: S) => boolean
  /** Last source observed by `getSelection`. SELECTOR_NEVER_SET on the
   *  first call (sentinel for "no source seen yet"). */
  lastSource: T | undefined | SelectorNeverSet
  /** Selection produced by the latest `selector(lastSource)` call. */
  lastSelection: S | undefined
  /** Selector identity at the time `lastSelection` was computed. Used
   *  to invalidate the memo when the selector reference changes (a new
   *  selector with the same source must re-run). */
  lastSelector: ((v: T | undefined) => S) | undefined
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

  // Latest-state pattern via useState — React Compiler / React 19 lock
  // down useRef objects against `.current` mutation during render, so
  // we store the mutable bag inside a useState slot instead. The
  // initialState factory runs once; we then mutate FIELDS of the
  // returned plain object, which is permitted because the object
  // itself isn't sealed by the runtime. Identity stays stable across
  // renders, so closures that close over `state` always read the
  // freshest selector / equality / memo state without re-subscribing.
  const [state] = useState<UseHandleState<T, S>>(() => ({
    selector,
    equality,
    lastSource: SELECTOR_NEVER_SET,
    lastSelection: undefined,
    lastSelector: undefined,
  }))
  // Field-level mutation of the state object during render is the
  // explicit intent here — see comment block above. The
  // `react-hooks/immutability` rule flags this conservatively because
  // it can't tell that `state` is a deliberate mutable bag, not a
  // hook return value the compiler optimizes against.
  // eslint-disable-next-line react-hooks/immutability
  state.selector = selector
  // eslint-disable-next-line react-hooks/immutability
  state.equality = equality

  const getSelection = useCallback((): S => {
    const source = handle.peek()
    const firstCall = state.lastSource === SELECTOR_NEVER_SET
    const sourceUnchanged = !firstCall && Object.is(source, state.lastSource)
    const selectorUnchanged = state.lastSelector === state.selector

    // Fast path: source AND selector identity unchanged → return the
    // cached selection. Common case across re-renders that don't
    // touch the underlying handle.
    if (sourceUnchanged && selectorUnchanged) {
      return state.lastSelection as S
    }

    const next = state.selector(source)
    /* eslint-disable react-hooks/immutability */
    state.lastSource = source
    state.lastSelector = state.selector

    // Reference-stability path (reviewer P3): when the source or
    // selector identity changed but the resulting value is structurally
    // equal to the previous selection, keep the OLD reference.
    // Inline-lambda selectors that decode/allocate fresh objects each
    // render (e.g. `useProperty(recentBlockIdsProp)`) would otherwise
    // produce a new !== reference per render even though the value is
    // unchanged — which retriggers `useEffect` deps that close over
    // the selection (e.g. QuickFind's recents-load effect). Returning
    // the prior reference when `equality` says "same" prevents the
    // spurious bounce.
    if (!firstCall && state.equality(state.lastSelection as S, next)) {
      // Update lastSource (different identity) but keep lastSelection
      // pointing at the old structurally-equal value.
      return state.lastSelection as S
    }

    state.lastSelection = next
    /* eslint-enable react-hooks/immutability */
    return next
  }, [handle, state])

  // Ensure-load: fire-and-forget on mount. Idempotent (LoaderHandle and
  // Block both dedup their inflight load promise). The status() check
  // prevents an unnecessary roundtrip when the handle is already ready.
  useEffect(() => {
    if (handle.status() === 'idle') {
      void handle.load().catch(() => {/* error stored on the handle */})
    }
  }, [handle])

  return useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        let currentSelection = getSelection()
        const unsubscribe = handle.subscribe(() => {
          const nextSelection = getSelection()
          if (state.equality(currentSelection, nextSelection)) return
          currentSelection = nextSelection
          listener()
        })
        return unsubscribe
      },
      [handle, getSelection, state],
    ),
    getSelection,
    getSelection,
  )
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

/** Reactive child-id list (in `(orderKey, id)` order). Returns `[]`
 *  while the children handle is loading or for a leaf block; the
 *  `repo.children(id)` handle re-resolves on local writes (TxEngine
 *  fast path) and sync arrivals (row_events tail). */
export const useChildIds = (block: Block): string[] => {
  const data = useHandle(block.repo.children(block.id))
  return useMemo(() => (data ?? EMPTY_BLOCK_DATA_ARRAY).map(d => d.id), [data])
}

/** Reactive child Block facades. */
export const useChildren = (block: Block): Block[] => {
  const data = useHandle(block.repo.children(block.id))
  const repo = block.repo
  return useMemo(
    () => (data ?? EMPTY_BLOCK_DATA_ARRAY).map(d => repo.block(d.id)),
    [data, repo],
  )
}

/** Whether the block has children. Selector keeps re-renders pinned to
 *  the boolean — content edits inside a child don't bounce this hook. */
export const useHasChildren = (block: Block): boolean =>
  useHandle(block.repo.children(block.id), {
    selector: data => (data ?? EMPTY_BLOCK_DATA_ARRAY).length > 0,
  })

/** Reactive parent chain (root → … → immediate parent), excluding
 *  `block` itself. */
export const useParents = (block: Block): Block[] => {
  const data = useHandle(block.repo.ancestors(block.id))
  const repo = block.repo
  return useMemo(
    () => (data ?? EMPTY_BLOCK_DATA_ARRAY).map(d => repo.block(d.id)),
    [data, repo],
  )
}

/** Reactive backlinks — every block in `block`'s workspace whose
 *  `references` field points at `block.id`. */
export const useBacklinks = (block: Block): Block[] => {
  const data = useHandle(block.repo.backlinks(block.id))
  const repo = block.repo
  return useMemo(
    () => (data ?? EMPTY_BLOCK_DATA_ARRAY).map(d => repo.block(d.id)),
    [data, repo],
  )
}

/** Reactive subtree (root + descendants), in SUBTREE_SQL order. New in
 *  Phase 2.D for parity with the four `repo.X` factories; existing
 *  call sites can adopt incrementally. */
export const useSubtree = (block: Block): Block[] => {
  const data = useHandle(block.repo.subtree(block.id))
  const repo = block.repo
  return useMemo(
    () => (data ?? EMPTY_BLOCK_DATA_ARRAY).map(d => repo.block(d.id)),
    [data, repo],
  )
}
