/**
 * React adapters over the new data-layer surface (Block facade +
 * BlockCache + Repo). Each hook is a thin `useSyncExternalStore`
 * wrapper around `cache.subscribe(id, listener)` + `cache.getSnapshot`,
 * with the same external signatures the legacy hooks exposed so the
 * call-site sweep stays mechanical.
 *
 * Phase 2 (HandleStore + useHandle) replaces these with handle-based
 * implementations as a packaging refactor — same `useSyncExternalStore`
 * underneath, formal Handle<T> at the call site.
 */

import { isEqual } from 'lodash'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { BlockData, PropertySchema } from '@/data/api'
import { useRepo } from '@/context/repo.tsx'
import { Block } from '@/data/internals/block'
import type { Repo } from '@/data/internals/repo'

const EMPTY_CHILD_IDS: string[] = []
const EMPTY_BACKLINK_IDS: string[] = []

const areSelectedValuesEqual = <T,>(left: T, right: T) => {
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

/** Side-effect-only hook: kicks off `repo.load(block.id)` when the
 *  block changes. Idempotent — `repo.load` is internally dedup'd. */
const useEnsureBlockLoaded = (block: Block) => {
  const repo = useRepo()
  useEffect(() => {
    void repo.load(block.id)
  }, [repo, block.id])
}

/** Reactive read of the block's BlockData snapshot. Returns
 *  `undefined` until the row is loaded; subsequent updates fire as
 *  the cache snapshot changes. */
export const useData = (block: Block): BlockData | undefined => {
  const repo = useRepo()
  useEnsureBlockLoaded(block)

  const subscribe = useCallback(
    (listener: () => void) => repo.cache.subscribe(block.id, listener),
    [repo, block.id],
  )
  const getSnapshot = useCallback(
    () => repo.cache.getSnapshot(block.id),
    [repo, block.id],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Reactive read with a selector applied to the BlockData. The
 *  selector + equality fns may be inline lambdas; latest-ref pattern
 *  keeps `useSyncExternalStore`'s subscribe/getSnapshot identities
 *  stable across renders.
 *
 *  `getSnapshot` MUST return a stable reference while the underlying
 *  cache snapshot is unchanged — otherwise React may either cycle
 *  ("Cached snapshot inside store mutated") or warn about a render
 *  loop. Selectors that allocate (codec.list decode → fresh array,
 *  object spread, etc.) violate this if we naively re-call them on
 *  every getSnapshot. We memoize against the source snapshot
 *  identity: BlockCache reuses the deepFrozen snapshot reference
 *  until it actually changes, so `Object.is(prev, next)` is the
 *  correct "no underlying change" test. */
export const useDataWithSelector = <T,>(
  block: Block,
  selector: (doc: BlockData | undefined) => T,
  isSelectionEqual: (left: T, right: T) => boolean = areSelectedValuesEqual,
): T => {
  const repo = useRepo()
  // Latest-ref pattern: capture the freshest selector / equality fns
  // for getSnapshot to read during render. Mutating refs in render
  // is the standard idiom for this useSyncExternalStore shape — a
  // useLayoutEffect copy lags by one commit and would return stale
  // selections on the same render that re-reads the store.
  const selectorRef = useRef(selector)
  const equalityRef = useRef(isSelectionEqual)
  // eslint-disable-next-line react-hooks/refs
  selectorRef.current = selector
  // eslint-disable-next-line react-hooks/refs
  equalityRef.current = isSelectionEqual

  // Snapshot-identity memo for getSnapshot stability. SOURCE_NEVER_SET
  // is the sentinel for "first call" — we can't use undefined because
  // the source snapshot can legitimately be undefined (block not
  // loaded yet) and we'd then refuse to seed the cache.
  const SOURCE_NEVER_SET = useRef<BlockData | undefined>(undefined).current
  const lastSourceRef = useRef<BlockData | undefined | typeof SOURCE_NEVER_SET>(
    SOURCE_NEVER_SET,
  )
  const lastSelectionRef = useRef<T | undefined>(undefined)
  const lastSelectorRef = useRef<typeof selector | undefined>(undefined)

  useEnsureBlockLoaded(block)

  const getSelection = useCallback(
    (): T => {
      const source = repo.cache.getSnapshot(block.id)
      const cached =
        lastSourceRef.current !== SOURCE_NEVER_SET &&
        Object.is(source, lastSourceRef.current) &&
        lastSelectorRef.current === selectorRef.current
      if (cached) return lastSelectionRef.current as T
      const next = selectorRef.current(source)
      lastSourceRef.current = source
      lastSelectorRef.current = selectorRef.current
      lastSelectionRef.current = next
      return next
    },
    [repo, block.id, SOURCE_NEVER_SET],
  )

  return useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        let currentSelection = getSelection()
        const unsubscribe = repo.cache.subscribe(block.id, () => {
          const nextSelection = getSelection()
          if (equalityRef.current(currentSelection, nextSelection)) return
          currentSelection = nextSelection
          listener()
        })
        // Best-effort kickoff load on subscribe (cheap if already cached).
        void repo.load(block.id)
        return unsubscribe
      },
      [repo, block.id, getSelection],
    ),
    getSelection,
    getSelection,
  )
}

/** Reactive typed property read + setter. The setter opens its own
 *  tx via `repo.mutate.setProperty` (whose scope derives from
 *  `schema.changeScope` — UiState writes go local-ephemeral, content
 *  writes upload). Returns `[value, setValue]` where value falls back
 *  to `schema.defaultValue` when the property isn't present. */
export function useProperty<T>(
  block: Block,
  schema: PropertySchema<T>,
): [T, (value: T) => void] {
  const value = useDataWithSelector(block, doc => {
    if (!doc) return schema.defaultValue
    const stored = doc.properties[schema.name]
    if (stored === undefined) return schema.defaultValue
    return schema.codec.decode(stored)
  })

  const setValue = useCallback(
    (next: T) => {
      void block.set(schema, next)
    },
    [block, schema],
  )

  return [value, setValue]
}

/** Alias kept for migration parity with the legacy hook name. The
 *  legacy `usePropertyValue` returned the property's `.value`; under
 *  the flat shape that distinction is gone and the new hook returns
 *  the typed value directly. Identical to `useProperty`. */
export const usePropertyValue = useProperty

/** Reactive content read. `''` when not loaded. */
export const useContent = (block: Block): string =>
  useDataWithSelector(block, doc => doc?.content ?? '')

/** Reactive child-id list. The hook owns hydration: on mount and on
 *  every `repo.db.onChange({tables: ['blocks']})` notification, it
 *  re-issues `repo.load(parentId, {children: true})` so the cache
 *  picks up sync-applied inserts (which write to SQL but don't go
 *  through the TxEngine cache walk). After each load resolves, the
 *  hook recomputes from `cache.childrenOf` and bumps state only when
 *  the id list actually shifted.
 *
 *  Why not just rely on `cache.subscribe(parentId)`: the row-grain
 *  cache subscription only fires for changes to the parent's own
 *  snapshot; sibling-row inserts and deletes don't notify it. The
 *  table-grain `db.onChange` is the substitute until Phase 2 ships
 *  the row_events tail (which can pin invalidation to the relevant
 *  parent ids). The throttle keeps typing-bursts cheap.
 *
 *  Cold render: `cache.areChildrenLoaded(parentId)` is false until
 *  the first `repo.load({children: true})` resolves, so the initial
 *  state reads as []. Once the load lands, the next setChildIds
 *  picks up the populated list. */
export const useChildIds = (block: Block): string[] => {
  const repo = useRepo()
  const [childIds, setChildIds] = useState<string[]>(() =>
    safeChildIds(repo, block.id),
  )

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      if (cancelled) return
      setChildIds(prev => {
        const next = safeChildIds(repo, block.id)
        return arraysEqual(prev, next) ? prev : next
      })
    }
    const reloadAndRefresh = async () => {
      try {
        await repo.load(block.id, {children: true})
      } catch (error) {
        if (!cancelled) console.warn('useChildIds load failed', error)
      }
      refresh()
    }
    // Cold-mount kickoff. The deduped load handles concurrent calls.
    void reloadAndRefresh()

    const unsubscribeCache = repo.cache.subscribe(block.id, refresh)
    const unsubscribeDb = repo.db.onChange(
      {
        onChange: () => {
          // Re-load children from SQL (catches sync-applied inserts
          // that didn't pass through the cache walk), then refresh.
          void reloadAndRefresh()
        },
        onError: (error) => {
          console.warn('useChildIds onChange error', error)
        },
      },
      {tables: ['blocks'], throttleMs: 32},
    )
    return () => {
      cancelled = true
      unsubscribeCache()
      unsubscribeDb()
    }
  }, [repo, block.id])

  return childIds
}

const safeChildIds = (repo: Repo, parentId: string): string[] => {
  if (!repo.cache.areChildrenLoaded(parentId)) {
    // Children not loaded yet — return empty rather than throwing.
    // Callers wanting strict gating use `block.childIds` directly.
    return EMPTY_CHILD_IDS
  }
  return repo.cache.childrenOf(parentId).map(c => c.id)
}

const arraysEqual = (a: string[], b: string[]): boolean => {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Reactive child Block facades (one per id). */
export const useChildren = (block: Block): Block[] => {
  const ids = useChildIds(block)
  const repo = block.repo
  return useMemo(() => ids.map(id => repo.block(id)), [ids, repo])
}

/** Whether the block has children. */
export const useHasChildren = (block: Block): boolean =>
  useChildIds(block).length > 0

/** Walk parent chain from cached snapshots (synchronous). Returns
 *  what's currently in cache; missing links short-circuit so we
 *  never render stale chains. */
const computeParentsFromCache = (repo: Repo, blockId: string): Block[] => {
  const result: Block[] = []
  const seen = new Set<string>([blockId])
  let currentId: string | undefined = blockId
  while (currentId) {
    const data = repo.cache.getSnapshot(currentId)
    if (!data?.parentId || seen.has(data.parentId)) break
    seen.add(data.parentId)
    result.unshift(repo.block(data.parentId))
    currentId = data.parentId
  }
  return result
}

/** Returns the parent chain for a block reactively, without suspending.
 *  Initial render uses the cached chain; an effect then asks the repo
 *  to load any missing ancestors and updates state when they arrive. */
export const useParents = (block: Block): Block[] => {
  const repo = useRepo()
  const blockId = block.id
  const [parents, setParents] = useState<Block[]>(() =>
    computeParentsFromCache(repo, blockId),
  )

  useEffect(() => {
    setParents(computeParentsFromCache(repo, blockId))
    let cancelled = false
    void repo.load(blockId, {ancestors: true}).then(() => {
      if (cancelled) return
      setParents(prev => {
        const next = computeParentsFromCache(repo, blockId)
        const sameChain =
          next.length === prev.length &&
          next.every((p, i) => p.id === prev[i]?.id)
        return sameChain ? prev : next
      })
    })
    return () => {
      cancelled = true
    }
  }, [repo, blockId])

  return parents
}

/** Returns the set of blocks whose `references` field points at
 *  `block.id`, reactively re-querying when any block changes
 *  (writes flush to row_events). Throttled to keep typing-bursts
 *  cheap. */
export const useBacklinks = (block: Block): Block[] => {
  const repo = useRepo()
  const [backlinkIds, setBacklinkIds] = useState<string[]>(EMPTY_BACKLINK_IDS)

  const blockId = block.id
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const workspaceId =
        repo.cache.getSnapshot(blockId)?.workspaceId ?? repo.activeWorkspaceId
      if (!workspaceId) return
      try {
        const blocks = await repo.findBacklinks(workspaceId, blockId)
        if (cancelled) return
        const nextIds = blocks.map(b => b.id)
        setBacklinkIds(prev => (isEqual(prev, nextIds) ? prev : nextIds))
      } catch (error) {
        if (!cancelled) console.warn('useBacklinks query failed', error)
      }
    }

    void refresh()

    const dispose = repo.db.onChange(
      {
        onChange: () => {
          void refresh()
        },
        onError: (error) => {
          console.warn('useBacklinks onChange error', error)
        },
      },
      {tables: ['row_events'], throttleMs: 250},
    )

    return () => {
      cancelled = true
      dispose()
    }
  }, [repo, blockId])

  return useMemo(
    () => backlinkIds.map(id => repo.block(id)),
    [backlinkIds, repo],
  )
}
