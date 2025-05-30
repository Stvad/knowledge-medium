import { BlockData, BlockProperty } from '@/types.ts'
import { useDocumentWithSelector } from '@/data/automerge.ts'
import { useCallback } from 'react'
import { useDocument } from '@automerge/automerge-repo-react-hooks'
import { Block } from '@/data/block.ts'

export const useData = (block: Block) => useDocument<BlockData>(block.id)[0]
export const useDataWithSelector =
  <T>(block: Block, selector: (doc: BlockData | undefined) => T) => useDocumentWithSelector<BlockData, T>(block.id, selector)[0]

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

export function useChildren(block: Block): Block[] {
  const doc = useData(block)
  if (!doc?.childIds?.length) return []

  return doc.childIds.map(childId => block.repo.find(childId))
}

export const useHasChildren = (block: Block) =>
  useDataWithSelector(block, (data?: BlockData) => data ? data.childIds.length > 0 : false)
