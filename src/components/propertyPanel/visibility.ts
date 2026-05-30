import {
  ChangeScope,
  type AnyPropertyEditorOverride,
  type AnyPropertySchema,
} from '@/data/api'

const RETIRED_HIDDEN_PROPERTIES = new Set(['focusedBlockId'])

/**
 * Property-panel visibility policy. Prefer propertyEditorOverridesFacet
 * metadata so plugins/kernel UI can mark internal fields without
 * BlockProperties importing individual schemas. The scope/name fallbacks
 * keep dynamic and legacy system properties hidden even without an
 * override.
 */
export const isPropertyPanelHiddenProperty = (
  name: string,
  schemas: ReadonlyMap<string, AnyPropertySchema>,
  uis: ReadonlyMap<string, AnyPropertyEditorOverride>,
): boolean => {
  const schema = schemas.get(name)
  const ui = uis.get(name)
  return ui?.hidden === true ||
    RETIRED_HIDDEN_PROPERTIES.has(name) ||
    name.startsWith('system:') ||
    schema?.changeScope === ChangeScope.UiState
}
