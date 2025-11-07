import { BlockData, BlockProperty } from '@/types.ts'
import { useDocumentWithSelector } from '@/data/automerge.ts'
import { useCallback } from 'react'
import { useDocument } from '@automerge/automerge-repo-react-hooks'
import { Block } from '@/data/block.ts'
import { USE_POWERSYNC } from '@/data/dataSource.ts'
import { usePowerSyncBlockData, usePowerSyncContent, usePowerSyncChildren } from './powerSyncBlock.ts'

export const useData = (block: Block) => {
  const automergeData = useDocument<BlockData>(block.id)[0]
  const powerSyncData = usePowerSyncBlockData(block.id)
  
  const result = USE_POWERSYNC ? powerSyncData : automergeData
  
  if (USE_POWERSYNC) {
    console.log('[useData PowerSync]', block.id, result)
  }
  
  return result
}

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

export const useContent = (block: Block) => {
  const automergeContent = useDataWithSelector(block, doc => doc?.content || '')
  const powerSyncContent = usePowerSyncContent(block.id)
  
  const result = USE_POWERSYNC ? powerSyncContent : automergeContent
  
  if (USE_POWERSYNC) {
    console.log('[useContent PowerSync]', block.id, result)
  }
  
  return result
}

export const useChildIds = (block: Block) => {
  const automergeChildIds = useDataWithSelector(block, doc => doc?.childIds || [])
  const powerSyncChildIds = usePowerSyncChildren(block.id)
  
  const result = USE_POWERSYNC ? powerSyncChildIds : automergeChildIds
  
  if (USE_POWERSYNC) {
    console.log('[useChildIds PowerSync]', block.id, result)
  }
  
  return result
}

export const useChildren = (block: Block): Block[] =>
  useChildIds(block).map(childId => block.repo.find(childId))

export const useHasChildren = (block: Block) =>
  useDataWithSelector(block, (data?: BlockData) => data ? data.childIds.length > 0 : false)
