import { isEqual } from 'lodash'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { BlockData, BlockProperty } from '@/types.ts'
import { useRepo } from '@/context/repo.tsx'
import { Block } from '@/data/block.ts'
import { Repo } from '@/data/repo.ts'

const EMPTY_CHILD_IDS: string[] = []

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

const useEnsureBlockLoaded = (block: Block) => {
  const repo = useRepo()

  useEffect(() => {
    void repo.loadBlockData(block.id)
  }, [repo, block.id])
}

export const useData = (block: Block) => {
  const repo = useRepo()
  useEnsureBlockLoaded(block)

  return useSyncExternalStore(
    useCallback((listener) => repo.subscribeToBlock(block.id, listener), [repo, block.id]),
    useCallback(() => repo.getCachedBlockData(block.id), [repo, block.id]),
    useCallback(() => repo.getCachedBlockData(block.id), [repo, block.id]),
  )
}

export const useDataWithSelector =
  <T>(
    block: Block,
    selector: (doc: BlockData | undefined) => T,
    isSelectionEqual: (left: T, right: T) => boolean = areSelectedValuesEqual,
  ) => {
    const repo = useRepo()
    // Latest-selector / latest-equality pattern: keep the subscribe and
    // getSnapshot identities stable for useSyncExternalStore (so the store
    // doesn't tear down on every render when callers pass inline lambdas),
    // while still consulting the freshest selector during render. We
    // can't use useLayoutEffect here — getSnapshot runs during render, so
    // a one-commit-old ref would return stale data when the selector
    // changes on the same render that re-reads the store. Mutating the ref
    // during render is the standard idiom for this pattern; the suggested
    // useEffectEvent replacement doesn't fit because getSnapshot is a
    // render-time call site.
    const selectorRef = useRef(selector)
    const equalityRef = useRef(isSelectionEqual)
    // eslint-disable-next-line react-hooks/refs
    selectorRef.current = selector
    // eslint-disable-next-line react-hooks/refs
    equalityRef.current = isSelectionEqual

    useEnsureBlockLoaded(block)

    const getSelection = useCallback(
      () => selectorRef.current(repo.getCachedBlockData(block.id)),
      [repo, block.id],
    )

    return useSyncExternalStore(
      useCallback((listener) => {
        let currentSelection = getSelection()
        const unsubscribe = repo.subscribeToBlock(block.id, () => {
          const nextSelection = getSelection()
          if (equalityRef.current(currentSelection, nextSelection)) return

          currentSelection = nextSelection
          listener()
        })

        void repo.loadBlockData(block.id)
        return unsubscribe
      }, [repo, block.id, getSelection]),
      getSelection,
      getSelection,
    )
  }

export function useProperty<T extends BlockProperty>(block: Block, config: T): [T, (value: T) => void] {
  const name = config.name
  const property = useDataWithSelector(block, doc => doc?.properties[name])

  const setProperty = useCallback((newProperty: T) => {
    block.setProperty(newProperty)
  }, [block])

  return [(property ?? config) as T, setProperty]
}

export function usePropertyValue<T extends BlockProperty>(block: Block, config: T): [T['value'], (value: T['value']) => void] {
  const [property, setProperty] = useProperty(block, config)

  const setValue = useCallback((newValue: T['value']) => {
    setProperty({
      ...property,
      value: newValue,
    })
  }, [property, setProperty])

  return [property.value, setValue]
}

export const useContent = (block: Block) => useDataWithSelector(block, doc => doc?.content || '')

export const useChildIds = (block: Block) =>
  useDataWithSelector(block, doc => doc?.childIds ?? EMPTY_CHILD_IDS)

export const useChildren = (block: Block): Block[] =>
  useChildIds(block).map(childId => block.repo.find(childId))

export const useHasChildren = (block: Block) =>
  useDataWithSelector(block, (data?: BlockData) => data ? data.childIds.length > 0 : false)

// Walk parent chain from cached snapshots (synchronous). Returns what's
// currently in cache; missing links short-circuit the walk so we never
// render stale chains.
const computeParentsFromCache = (repo: Repo, blockId: string): Block[] => {
  const result: Block[] = []
  const seen = new Set<string>([blockId])
  let currentId: string | undefined = blockId
  while (currentId) {
    const data = repo.getCachedBlockData(currentId)
    if (!data?.parentId || seen.has(data.parentId)) break
    seen.add(data.parentId)
    result.unshift(repo.find(data.parentId))
    currentId = data.parentId
  }
  return result
}

// Returns the parent chain for a block reactively, without suspending.
// Initial render uses the cached chain (typically complete for blocks
// we've already rendered); an effect then asks the repo to load any
// missing ancestors and updates state when they arrive.
export const useParents = (block: Block): Block[] => {
  const repo = useRepo()
  const blockId = block.id
  const [parents, setParents] = useState<Block[]>(() => computeParentsFromCache(repo, blockId))

  useEffect(() => {
    setParents(computeParentsFromCache(repo, blockId))

    let cancelled = false
    void block.parents().then(loaded => {
      if (cancelled) return
      setParents(prev => {
        const sameChain =
          loaded.length === prev.length &&
          loaded.every((p, i) => p.id === prev[i]?.id)
        return sameChain ? prev : loaded
      })
    })
    return () => {
      cancelled = true
    }
  }, [repo, block, blockId])

  return parents
}

const EMPTY_BACKLINK_IDS: string[] = []

// Returns the set of blocks whose `references` field points at `block.id`,
// reactively re-querying when any block changes (writes flush to block_events).
// 250ms throttle keeps it cheap during bursts of typing.
export const useBacklinks = (block: Block): Block[] => {
  const repo = useRepo()
  const [backlinkIds, setBacklinkIds] = useState<string[]>(EMPTY_BACKLINK_IDS)

  const blockId = block.id
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const workspaceId =
        repo.getCachedBlockData(blockId)?.workspaceId ?? repo.activeWorkspaceId
      if (!workspaceId) return
      try {
        const blocks = await repo.findBacklinks(workspaceId, blockId)
        if (cancelled) return
        const nextIds = blocks.map(b => b.id)
        setBacklinkIds(prev => isEqual(prev, nextIds) ? prev : nextIds)
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
      {tables: ['block_events'], throttleMs: 250},
    )

    return () => {
      cancelled = true
      dispose()
    }
  }, [repo, blockId])

  return useMemo(
    () => backlinkIds.map(id => repo.find(id)),
    [backlinkIds, repo],
  )
}
