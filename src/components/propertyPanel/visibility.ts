import {
  ChangeScope,
  type AnyPropertyEditorOverride,
  type AnyPropertySchema,
} from '@/data/api'
import type {PropertyDefinitionRegistrySnapshot} from '@/data/propertyDefinitionRegistry'
import {isPropertySeedDeclaration} from '@/data/propertySeeds'
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
): boolean => {
  if (definitions) {
    const winner = definitions.definitionsByName.get(name)?.[0]
    if (winner) return winner.hidden

    const seeds = definitions.seedsByName.get(name)
    // An ambiguous synthesized name has no winner yet. Do not let whichever
    // declaration happened to reach the name-keyed schema map dictate policy.
    if (seeds !== undefined) return seeds.length === 1 && seeds[0]!.hidden
  }

  // Stage 0 (or a registry snapshot briefly lagging a runtime swap) still
  // carries the actual seed declaration as the behavioral schema entry. Read
  // its declaration-only flag without widening AnyPropertySchema itself.
  return schema !== undefined && isPropertySeedDeclaration(schema) && schema.hidden
}

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
  const ui = uis.get(name)
  return isPropertyPanelReadOnlyProperty(name) ||
    ui?.hidden === true ||
    isDefinitionHidden(name, schema, definitions) ||
    name.startsWith('system:') ||
    schema?.changeScope === ChangeScope.UiState
}
