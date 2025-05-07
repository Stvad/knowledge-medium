import { useUIStateProperty } from '@/data/globalState.ts'
import {
  BlockProperty,
  BlockPropertyValue,
  StringBlockProperty,
  NumberBlockProperty,
  BooleanBlockProperty,
  ObjectBlockProperty, SelectionState,
} from '@/types'
import { reassembleTagProducer } from '@/utils/templateLiterals.ts'
import { uiChangeScope } from '@/data/block.ts'

export const createProperty = <T extends BlockPropertyValue>(
  name: string,
  type: string,
  value: T,
  changeScope?: string,
): BlockProperty => ({
  name,
  type,
  value,
  changeScope,
})

export const stringProperty = (name: string, value?: string, changeScope?: string): StringBlockProperty => ({
  name,
  type: 'string',
  value,
  changeScope,
})

export const sp = reassembleTagProducer(stringProperty)

export const numberProperty = (name: string, value?: number, changeScope?: string): NumberBlockProperty => ({
  name,
  type: 'number',
  value,
  changeScope,
})

export const np = reassembleTagProducer(numberProperty)

export const booleanProperty = (name: string, value?: boolean, changeScope?: string): BooleanBlockProperty => ({
  name,
  type: 'boolean',
  value,
  changeScope,
})

export const boolProp = booleanProperty

export const bp = reassembleTagProducer(booleanProperty)

export const objectProperty = <V extends object>(
  name: string,
  value?: V,
  changeScope?: string,
): ObjectBlockProperty<V> => ({
  name,
  type: 'object',
  value,
  changeScope,
})

export const migratePropertyValue = (name: string, value: BlockPropertyValue): BlockProperty => {
  if (value === undefined) return createProperty(name, 'undefined', undefined)
  if (value === null) return createProperty(name, 'null', null)

  const type = Array.isArray(value) ? 'array' : typeof value
  return createProperty(name, type, value)
}

// Helper to determine if a value is already a BlockProperty
export const isBlockProperty = (value: unknown): value is BlockProperty => {
  if (!value || typeof value !== 'object') return false
  return 'type' in value && 'value' in value && 'name' in value
}

export const useIsEditing = () => {
  return useUIStateProperty(booleanProperty('isEditing', false))
}

/**
 * Common prop configs
 */

export const showPropertiesProp = boolProp('system:showProperties', false, uiChangeScope)
export const isCollapsedProp = boolProp('system:collapsed', false, uiChangeScope)
export const topLevelBlockIdProp = sp`topLevelBlockId`
export const focusedBlockIdProp = sp`focusedBlockId`
export const selectionProp = objectProperty<SelectionState>('selection')
