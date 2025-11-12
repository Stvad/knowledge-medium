import { BlockProperty } from '@/types.ts'
import { useCallback } from 'react'
import { Block } from '@/data/block.ts'
import {
  usePowerSyncBlockData,
  usePowerSyncContent,
  usePowerSyncChildren,
  usePowerSyncProperty,
  usePowerSyncHasChildren,
} from './powerSyncBlock.ts'

export const useData = (block: Block) => {
  return usePowerSyncBlockData(block.id)
}

export function useProperty<T extends BlockProperty>(block: Block, config: T): [T, (value: T) => void] {
  const name = config.name
  const property = usePowerSyncProperty(block.id, name, config)

  const setProperty = useCallback((newProperty: T) => {
    block.setProperty(newProperty)
  }, [block])

  return [property as T, setProperty]
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
  return usePowerSyncContent(block.id)
}

export const useChildIds = (block: Block) => {
  return usePowerSyncChildren(block.id)
}

export const useChildren = (block: Block): Block[] =>
  useChildIds(block).map(childId => block.repo.find(childId))

export const useHasChildren = (block: Block) => usePowerSyncHasChildren(block.id)
