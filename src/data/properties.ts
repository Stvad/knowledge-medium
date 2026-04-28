import { useUIStateProperty } from '@/data/globalState.ts'
import {
  BlockProperty,
  StringBlockProperty,
  NumberBlockProperty,
  BooleanBlockProperty,
  ObjectBlockProperty,
  ListBlockProperty,
  EditorSelectionState, BlockPropertyValue,
} from '@/types'
import { reassembleTagProducer } from '@/utils/templateLiterals.ts'
import { removeUndefined } from '@/utils/object.ts'
import { Block } from '@/data/block.ts'

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

export const listProperty = <T extends BlockPropertyValue>(
  name: string,
  value?: T[],
  changeScope?: string,
): ListBlockProperty<T> => defineCreatorFunction<ListBlockProperty<T>>('list')(name, value, changeScope)

export const sp = reassembleTagProducer(stringProperty)
export const np = reassembleTagProducer(numberProperty)
export const bp = reassembleTagProducer(booleanProperty)

export const fromList = (...values: BlockProperty[]) =>
  Object.fromEntries(values.map(v => [v.name, v]))

export const aliasProp = (aliases: string[] = []) =>
  listProperty<string>('alias', aliases)

export const useIsEditing = () => useUIStateProperty(isEditingProp)

export const uiChangeScope = 'ui-state'
/**
 * Common prop configs
 */

// System properties
export const showPropertiesProp = boolProp('system:showProperties', false, uiChangeScope)
export const isCollapsedProp = boolProp('system:collapsed', false, uiChangeScope)
export const isEditingProp = boolProp('isEditing', false, uiChangeScope)
export const topLevelBlockIdProp = stringProperty('topLevelBlockId', undefined, uiChangeScope)
export const focusedBlockIdProp = stringProperty('focusedBlockId', undefined, uiChangeScope)
export const editorSelection = objectProperty<EditorSelectionState>('editorSelection', undefined, uiChangeScope)
export const editorFocusRequestProp = numberProperty('editorFocusRequest', 0, uiChangeScope)
export const recentBlockIdsProp = listProperty<string>('recentBlockIds', [], uiChangeScope)

export const RECENT_BLOCKS_LIMIT = 10

export const pushRecentBlockId = (uiStateBlock: Block, blockId: string) => {
  const current = (uiStateBlock.dataSync()?.properties[recentBlockIdsProp.name]?.value as string[] | undefined) ?? []
  const next = [blockId, ...current.filter(id => id !== blockId)].slice(0, RECENT_BLOCKS_LIMIT)
  uiStateBlock.setProperty({...recentBlockIdsProp, value: next})
}

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

// Extension lifecycle properties — content-scope (a flagged extension
// stays disabled across reloads), so no uiChangeScope.
export const extensionDisabledProp = boolProp('system:disabled', false)

// Timing properties
export const previousLoadTimeProp = numberProperty('previousLoadTime')
export const currentLoadTimeProp = numberProperty('currentLoadTime')
export const createdAtProp = numberProperty('createdAt')

// Block reference properties
export const sourceBlockIdProp = stringProperty('sourceBlockId')


export const setIsEditing = (uiStateBlock: Block, editing: boolean) => {
  // In a read-only workspace, refuse the transition into edit mode at the
  // source. Wrappers like enterBlockEditMode / enterEditMode also short-
  // circuit, but gating here keeps any future caller honest.
  if (editing && uiStateBlock.repo.isReadOnly) return
  uiStateBlock.setProperty({...isEditingProp, value: editing})
}
export const setFocusedBlockId = (uiStateBlock: Block, id: string) => {
  uiStateBlock.setProperty({...focusedBlockIdProp, value: id})
}

export const requestEditorFocus = (uiStateBlock: Block) => {
  const currentRequestId =
    (uiStateBlock.dataSync()?.properties[editorFocusRequestProp.name]?.value as number | undefined) ?? 0

  uiStateBlock.setProperty({
    ...editorFocusRequestProp,
    value: currentRequestId + 1,
  })
}
