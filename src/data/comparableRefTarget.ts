import { isRefCodec, memberCodecOf, type AnyPropertySchema } from './api'
import { queryableFieldsFacet, refTargetComparablePropertiesFacet, type RefTargetComparableProperty } from './facets'
import type { Repo } from './repo'

/** A scalar reference can compare through one property shared by its target types. */
const comparableRefTarget = (
  schema: AnyPropertySchema,
  defaults: ReadonlyMap<string, RefTargetComparableProperty>,
  lookupSchema: (name: string) => AnyPropertySchema | undefined,
): AnyPropertySchema | undefined => {
  if (!isRefCodec(schema.codec) || memberCodecOf(schema.codec)) return undefined
  const targetTypes = schema.codec.targetTypes
  const firstType = targetTypes[0]
  const property = firstType === undefined ? undefined : defaults.get(firstType)?.property
  if (property === undefined || !targetTypes.every(type => defaults.get(type)?.property === property)) return undefined
  const inner = lookupSchema(property)
  return inner?.codec.where && !memberCodecOf(inner.codec) ? inner : undefined
}

export const refTargetComparisonFor = (repo: Repo, workspaceId: string) => {
  const fields = repo.facetRuntime?.read(queryableFieldsFacet, workspaceId)
  const defaults = repo.facetRuntime?.read(refTargetComparablePropertiesFacet, workspaceId)
  const properties = repo.propertySchemasFor(workspaceId)
  return (schema: AnyPropertySchema): AnyPropertySchema | undefined => {
    if (!defaults || fields?.has(schema.name)) return undefined
    return comparableRefTarget(schema, defaults, name => fields?.has(name) ? undefined : properties?.get(name))
  }
}
