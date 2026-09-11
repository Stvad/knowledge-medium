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
 *   - useParents: handle via `repo.ancestors(id)`.
 *   - useSubtree: handle via `repo.subtree(id)` (new in Phase 2.D).
 *
 * The legacy `useDataWithSelector` is gone — selectors move to the
 * `useHandle(handle, {selector})` option.
 */

import { isEqual } from 'lodash-es'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { BlockData, Handle, PropertySchema, TypedBlockQuery } from '@/data/api'
import { getAliases } from '@/data/properties.js'
import { Block } from '../data/block'
import type { Repo } from '@/data/repo'
import { useRepo } from '@/context/repo.js'

const EMPTY_BLOCK_DATA_ARRAY: readonly BlockData[] = Object.freeze([])

export interface BlockContentRevision {
  content: string
  updatedAt: number
}

export interface BlockUpdateMetadata {
  /** Row-version. Used only to detect the `0` pristine sentinel (a
   *  never-user-edited deterministic-id default), NOT for display. */
  updatedAt: number
  /** User-facing "last edited" stamp — what the indicator displays and sorts by. */
  userUpdatedAt: number
  updatedBy: string
}

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

/** Ensure-load for a handle a hook has just started observing.
 *
 *  `'error'` is retried alongside `'idle'`: a FIRST-load failure leaves
 *  the handle with no deps, so no change can ever invalidate it into a
 *  retry, and an arriving observer is the only retry such a handle can
 *  get until failure is observable in its own right (#930). Bounded by
 *  mounts and by changes to the observed set, so a persistently failing
 *  query costs one read per those, not a spin. */
const ensureLoaded = (handle: Handle<unknown>): void => {
  const status = handle.status()
  if (status !== 'idle' && status !== 'error') return
  // Logged rather than swallowed: the handle stores the error but nothing
  // reads it, so a surface that fails quietly by design (breadcrumbs, any
  // decoration) would otherwise leave a blank line and no trace of why.
  void handle.load().catch(error => {
    console.error(`[handle] load failed for ${handle.key}`, error)
  })
}

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
  // shape.
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
  // Why this is safe under concurrent mode: the `let`
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
      // would otherwise produce a new !== reference per render even when
      // the value is unchanged, retriggering effects that close over the
      // selection.
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
  // Block both dedup their inflight load promise). A disposed handle
  // reports its live replacement's status, so this reads the replacement
  // rather than a corpse; with the key vacant it reports 'disposed' and we
  // skip — the subscribe below mints a live handle at that key, whose own
  // first-subscriber load covers the ensure-load we declined.
  useEffect(() => { ensureLoaded(handle) }, [handle])

  // Stable subscribe — only changes when the handle changes, so we
  // don't tear down handle.subscribe on every render that produces a
  // new selector. A listener firing for a value that didn't actually
  // change is bailed out by useSyncExternalStore: it re-checks
  // getSelection, finds the stable reference held by committedRef, and
  // skips the re-render.
  //
  // No disposed-handle branch here on purpose. A subtree whose effects were
  // unmounted long enough for the store to GC its handle
  // (`<Activity mode="hidden">`) recovers because `handle.subscribe` itself
  // resolves to whatever is live at the key — and it has to live there rather
  // than in this hook, because the caller cannot re-acquire under React
  // Compiler. Full mechanism: docs/handle-lifecycle-hidden-subtrees.html.
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

/** A value stabilized by its CONTENT, for a caller that builds it inline.
 *
 *  `useHandles` keys its subscriptions on the handle array's identity, and
 *  that array is built from a list a caller assembles per render — so
 *  without this every render tears down N subscriptions and opens N more.
 *
 *  Serialized as JSON rather than joined on a delimiter: `blockId.ts`
 *  enforces canonical uuids only on the tx INSERT path and exempts
 *  sync-applied and `applyRaw` rows, so an id containing the delimiter is
 *  not impossible, and encoding it away removes the assumption. */
export const useStableJson = <T,>(value: T): T => {
  const key = JSON.stringify(value)
  return useMemo(() => JSON.parse(key) as T, [key])
}

export interface UseHandlesOptions {
  /** Whether an unresolved member is FETCHED. Default `true`.
   *
   *  Gates the ensure-load only, so it is meaningful for a handle whose
   *  `subscribe` does not itself load — `Block`, whose subscribe is a
   *  plain `BlockCache` listener. A `LoaderHandle` member loads on first
   *  subscribe regardless (`handleStore.ts`), so passing `false` for one
   *  buys nothing. */
  fetchMissing?: boolean
}

/** `useHandle` for a SET of handles: one subscription each, values in
 *  the caller's order, `undefined` for a member that hasn't resolved.
 *
 *  Reach for it when the set itself moves — one handle per member is what
 *  lets a member that stays keep its resolved value across a change to
 *  the set. See `core.ancestors` for the shape this exists to serve.
 *
 *  The caller owns `handles`' identity: build the array from
 *  `useStableJson`'d ids, not from the source array.
 *
 *  Members are compared with `useHandle`'s equality, not by identity: a
 *  `LoaderHandle` stores every reload's value and applies its structural
 *  diff only to the NOTIFY, so `peek()` hands back a fresh array after a
 *  reload that changed nothing. Identity alone would rebuild the whole
 *  aggregate on each of those, and every consumer memo with it.
 *
 *  No `committedRef` counterpart to `useHandle`'s, because the memo below
 *  is rebuilt only when `handles` changes — which means the id set
 *  changed, and a new array is then the honest answer. */
export const useHandles = <T,>(
  handles: readonly Handle<T>[],
  opts?: UseHandlesOptions,
): readonly (T | undefined)[] => {
  const fetchMissing = opts?.fetchMissing ?? true
  // Same closure-local memo as `useHandle`, and safe for the same reason:
  // the bindings live in the closure `useMemo` returned, never on a shared
  // object, so an abandoned render can at worst prime the memo with a
  // superseded value array.
  /* eslint-disable react-hooks/immutability */
  const getSnapshot = useMemo(() => {
    let memoized: (T | undefined)[] | null = null
    return (): readonly (T | undefined)[] => {
      const next = handles.map(handle => handle.peek())
      if (memoized !== null && areSelectedValuesEqual(memoized, next)) return memoized
      memoized = next
      return next
    }
  }, [handles])
  /* eslint-enable react-hooks/immutability */

  const subscribe = useCallback((listener: () => void) => {
    const unsubscribes = handles.map(handle => handle.subscribe(listener))
    return () => { for (const unsubscribe of unsubscribes) unsubscribe() }
  }, [handles])

  // Every member starts in the same tick, which is what lets a batching
  // loader answer them with one read.
  useEffect(() => {
    if (!fetchMissing) return
    for (const handle of handles) ensureLoaded(handle)
  }, [handles, fetchMissing])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
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

/** Reactive existence read. `false` while loading and for confirmed-missing rows. */
export const useBlockExists = (block: Block): boolean =>
  useHandle(block, {selector: doc => Boolean(doc)})

/** Reactive workspace id read. Falls back while loading or confirmed missing. */
export const useWorkspaceId = (block: Block, fallback = ''): string =>
  useHandle(block, {selector: doc => doc?.workspaceId ?? fallback})

/** Reactive content plus updatedAt revision, for editors that need stale-write guards. */
export const useContentRevision = (block: Block): BlockContentRevision | undefined =>
  useHandle(block, {
    selector: doc => doc
      ? {
        content: doc.content,
        updatedAt: doc.updatedAt,
      }
      : undefined,
  })

/** Reactive update metadata for freshness indicators. */
export const useUpdateMetadata = (block: Block): BlockUpdateMetadata | undefined =>
  useHandle(block, {
    selector: doc => doc
      ? {
        updatedAt: doc.updatedAt,
        userUpdatedAt: doc.userUpdatedAt,
        updatedBy: doc.updatedBy,
      }
      : undefined,
  })

/** Reactive typed property read + setter. The setter opens its own tx
 *  via `repo.mutate.setProperty` (whose scope derives from
 *  `schema.changeScope` — the scope identity drives undo bucketing and
 *  schema validation; the actual upload routing is uniform across
 *  scopes). Returns `[value, setValue]` where value falls back to
 *  `schema.defaultValue` when the property isn't present. */
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

/** The block's page names (`alias`), reactively.
 *
 *  Deliberately NOT `usePropertyValue(block, aliasesProp)`: that calls
 *  `codec.decode` with no catch, and this read runs for EVERY rendered block
 *  (it feeds the page-styling seams — `useBlockTitleTextClass` and the bullet).
 *  One malformed stored value —
 *  imported, hand-written, arrived over sync — would throw inside the renderer
 *  itself, above the per-block error boundary, and blank out that block's whole
 *  subtree. `getAliases` is the codebase's existing tolerant decode for exactly
 *  this case; the shared empty array keeps the common no-alias path
 *  identity-stable through `useHandle`'s equality bail-out. */
export const useBlockAliases = (block: Block): readonly string[] =>
  useHandle(block, {
    selector: data => (data ? getAliases(data) : EMPTY_STRING_ARRAY),
  }) as readonly string[]

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
  // Display hook: the outline shows the visible view (recognized property
  // field rows excluded, §9). Structural traversals use the everything-by-
  // default query instead.
  useHandle(block.repo.query.childIds({id: block.id, hydrate: true, hidePropertyChildren: true}), {
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
  // Display hook: visible view (property field rows excluded, §9).
  return useHandle(block.repo.query.children({id: block.id, hidePropertyChildren: true}), {
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
  useHandle(block.repo.query.childIds({id: block.id, hydrate: true, hidePropertyChildren: true}), {
    selector: ids => (ids ?? EMPTY_STRING_ARRAY).length > 0,
  })

/** A leaf-to-root chain as breadcrumb-ordered facades. `core.ancestors`
 *  walks leaf-to-root; every consumer renders root-first. */
const parentsFromChain = (repo: Repo, chain: readonly BlockData[]): Block[] =>
  chain.map(data => repo.block(data.id)).reverse()

/** Reactive parent chain (root → … → immediate parent), excluding
 *  `block` itself. */
export const useParents = (block: Block): Block[] => {
  const repo = block.repo
  return useHandle(block.repo.query.ancestors({id: block.id}), {
    selector: data => parentsFromChain(repo, data ?? EMPTY_BLOCK_DATA_ARRAY),
  })
}

const EMPTY_PARENT_MAP: ReadonlyMap<string, Block[]> = new Map()

/** Batched variant of `useParents` — the parent chain for every id in
 *  `blocks`, as a Map<id, Block[]> in the same root→…→immediate-parent
 *  order each per-id `useParents` would produce.
 *
 *  One `core.ancestors` handle per id — see that query for why the set
 *  is not the unit. The walks coalesce into one statement, so the cold
 *  case costs what a single batched query did.
 *
 *  One handle, one subscription and one set of deps per id, so an
 *  ancestor shared by several chains is a dep on each of them.
 *
 *  A chain that has never resolved is absent from the map rather than
 *  empty, so a consumer can tell "not yet" from "this block is a root".
 *  A chain whose load FAILED is absent by the same route, and stays that
 *  way until an observer arrives or the id set changes: a first-load
 *  failure leaves the handle with no deps, so no change can invalidate it
 *  into a retry and `ensureLoaded` is the only thing that re-asks (#930). */
export const useManyParents = (blocks: readonly Block[]): ReadonlyMap<string, Block[]> => {
  const repo = useRepo()
  // Deduped and sorted so logically-equal block sets in different orders
  // share one set of handles.
  const ids = useStableJson(Array.from(new Set(blocks.map(block => block.id))).sort())
  const handles = useMemo(
    () => ids.map(id => repo.query.ancestors({id})),
    [ids, repo],
  )
  const chains = useHandles(handles)

  return useMemo(() => {
    const out = new Map<string, Block[]>()
    ids.forEach((id, index) => {
      const chain = chains[index]
      if (chain) out.set(id, parentsFromChain(repo, chain))
    })
    return out.size === 0 ? EMPTY_PARENT_MAP : out
  }, [ids, chains, repo])
}

/** Reactive subtree (root + descendants), in SUBTREE_SQL order. New in
 *  Phase 2.D for parity with the four `repo.X` factories; existing
 *  call sites can adopt incrementally. */
export const useSubtree = (block: Block): Block[] => {
  const repo = block.repo
  // Display hook: visible view (property field rows excluded, §9).
  return useHandle(block.repo.query.subtree({id: block.id, hidePropertyChildren: true}), {
    selector: data => (data ?? EMPTY_BLOCK_DATA_ARRAY).map(d => repo.block(d.id)),
  })
}

/** Reactive typed block query. `workspaceId` is required on the
 *  passed query — pass `repo.activeWorkspaceId` explicitly when you
 *  really do want the user's currently-active workspace. Requiring the
 *  field at the type level prevents background flows / import surfaces
 *  from silently mis-scoping when the user switches workspaces mid-flight. */
export const useBlockQuery = (query: TypedBlockQuery): BlockData[] => {
  const repo = useRepo()
  return useHandle(repo.query.typedBlocks(query), {
    selector: data => data ?? EMPTY_BLOCK_DATA_ARRAY,
  }) as BlockData[]
}
