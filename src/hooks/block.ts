import { isEqual } from 'lodash'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { BlockData, BlockProperty } from '@/types.ts'
import { useRepo } from '@/context/repo.tsx'
import { Block } from '@/data/block.ts'

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
    const selectorRef = useRef(selector)
    const equalityRef = useRef(isSelectionEqual)
    selectorRef.current = selector
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
