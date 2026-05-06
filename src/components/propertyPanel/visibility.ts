import {
  ChangeScope,
  type AnyPropertySchema,
  type AnyPropertyUiContribution,
} from '@/data/api'

/**
 * Property-panel visibility policy. Prefer propertyUiFacet metadata so
 * plugins/kernel UI can mark internal fields without BlockProperties
 * importing individual schemas. The scope/name fallbacks keep dynamic
 * and legacy system properties hidden even without a UI contribution.
 */
export const isPropertyPanelHiddenProperty = (
  name: string,
  schemas: ReadonlyMap<string, AnyPropertySchema>,
  uis: ReadonlyMap<string, AnyPropertyUiContribution>,
): boolean => {
  const schema = schemas.get(name)
  const ui = uis.get(name)
  return ui?.hidden === true ||
    name.startsWith('system:') ||
    schema?.changeScope === ChangeScope.UiState
}
