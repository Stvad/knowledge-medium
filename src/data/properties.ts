import { useUIStateProperty } from '@/data/globalState.ts'
import {
  BlockProperty,
  StringBlockProperty,
  NumberBlockProperty,
  BooleanBlockProperty,
  ObjectBlockProperty, SelectionState,
} from '@/types'
import { reassembleTagProducer } from '@/utils/templateLiterals.ts'
import { removeUndefined } from '@/utils/object.ts'

const defineCreatorFunction = <T extends BlockProperty>(type: string) =>
  (name: string, value?: T['value'], changeScope?: string): T => removeUndefined({
    name,
    type,
    value,
    changeScope,
  }) as T

export const stringProperty = defineCreatorFunction<StringBlockProperty>('string')
export const numberProperty = defineCreatorFunction<NumberBlockProperty>('number')
export const booleanProperty = defineCreatorFunction<BooleanBlockProperty>('boolean')
export const boolProp = booleanProperty
export const objectProperty = <V extends object>(
  name: string,
  value?: V,
  changeScope?: string,
): ObjectBlockProperty<V> => defineCreatorFunction<ObjectBlockProperty<V>>('object')(name, value, changeScope)


export const sp = reassembleTagProducer(stringProperty)
export const np = reassembleTagProducer(numberProperty)
export const bp = reassembleTagProducer(booleanProperty)

export const fromList = (...values: BlockProperty[]) =>
  Object.fromEntries(values.map(v => [v.name, v]))

export const useIsEditing = () => {
  return useUIStateProperty(booleanProperty('isEditing', false))
}

export const uiChangeScope = 'ui-state'
/**
 * Common prop configs
 */

// System properties
export const showPropertiesProp = boolProp('system:showProperties', false, uiChangeScope)
export const isCollapsedProp = boolProp('system:collapsed', false, uiChangeScope)
export const isEditingProp = boolProp('isEditing', undefined, uiChangeScope)
export const topLevelBlockIdProp = stringProperty('topLevelBlockId', undefined, uiChangeScope)
export const focusedBlockIdProp = stringProperty('focusedBlockId', undefined, uiChangeScope)
export const selectionProp = objectProperty<SelectionState>('selection') // Commenting out or removing old/conflicting 'selection' if it was for text selection

export interface BlockSelectionState {
  selectedBlockIds: string[];
  anchorBlockId: string | null;
}

export const selectionStateProp: ObjectBlockProperty<BlockSelectionState> = objectProperty<BlockSelectionState>(
  'blockSelectionState',
  {
    selectedBlockIds: [],
    anchorBlockId: null,
  },
  uiChangeScope,
)

// Block type properties
export const typeProp = stringProperty('type')
export const rendererProp = stringProperty('renderer')
export const rendererNameProp = stringProperty('rendererName')

// OpenRouter properties
export const baseUrlProp = stringProperty('baseUrl', undefined, 'plugin-settings')
export const modelProp = stringProperty('model', undefined, 'plugin-settings')

// Timing properties
export const previousLoadTimeProp = numberProperty('previousLoadTime')
export const currentLoadTimeProp = numberProperty('currentLoadTime')
export const createdAtProp = numberProperty('createdAt')

// Block reference properties
export const sourceBlockIdProp = stringProperty('sourceBlockId')
