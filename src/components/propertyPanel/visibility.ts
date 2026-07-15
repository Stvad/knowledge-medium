import {
  ChangeScope,
  type AnyPropertyEditorOverride,
  type AnyPropertySchema,
} from '@/data/api'
import {
  resolveDefinitionSource,
  resolveEditorOverride,
  type PropertyDefinitionRegistrySnapshot,
} from '@/data/propertyDefinitionRegistry'
import {seedKeyProp, seedRevisionProp} from '@/data/properties'

const INTRINSIC_READ_ONLY_PROPERTY_NAMES = new Set([
  seedKeyProp.name,
  seedRevisionProp.name,
])

/** Code-owned identity/upgrade metadata stays inspectable but never editable,
 * independent of optional UI extensions or safe-mode filtering. */
export const isPropertyPanelReadOnlyProperty = (name: string): boolean =>
  INTRINSIC_READ_ONLY_PROPERTY_NAMES.has(name)

const isDefinitionHidden = (
  name: string,
  schema: AnyPropertySchema | undefined,
  definitions: PropertyDefinitionRegistrySnapshot | null,
): boolean =>
  // Same winner→single-seed→stage-0 resolution the override join uses; the
  // `?? false` covers "no source" and the ambiguous-synthesized-name case
  // (>1 seed, no winner) where policy must not follow whichever declaration
  // happened to reach the name-keyed schema map.
  resolveDefinitionSource(name, definitions, schema)?.hidden ?? false

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
  definitions: PropertyDefinitionRegistrySnapshot | null = null,
): boolean => {
  const schema = schemas.get(name)
  const ui = resolveEditorOverride(name, definitions, uis, schema)
  return isPropertyPanelReadOnlyProperty(name) ||
    ui?.hidden === true ||
    isDefinitionHidden(name, schema, definitions) ||
    name.startsWith('system:') ||
    schema?.changeScope === ChangeScope.UiState
}
