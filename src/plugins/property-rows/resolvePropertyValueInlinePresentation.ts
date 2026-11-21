import type { AnyPropertyEditorOverride, AnyPropertySchema } from '@/data/api'
import { propertyEditorOverridesFacet } from '@/data/facets'
import { resolveEditorOverride, type PropertyDefinitionRegistrySnapshot } from '@/data/propertyDefinitionRegistry'
import { readValuePresets } from '@/data/valuePresetRegistry'
import type { FacetRuntime } from '@/facets/facet'

/** Resolve the presentation supplying a schema's inline editor. */
export const resolvePropertyValueInlinePresentation = (
  runtime: FacetRuntime,
  definitions: PropertyDefinitionRegistrySnapshot | null,
  schema: AnyPropertySchema | undefined,
): Pick<AnyPropertyEditorOverride, 'InlineEditor'> | undefined => {
  if (!schema) return undefined
  const override = resolveEditorOverride(schema.name, definitions, runtime.read(propertyEditorOverridesFacet), schema)
  if (override?.InlineEditor) return override
  return readValuePresets(runtime).get(schema.codec.type)
}
