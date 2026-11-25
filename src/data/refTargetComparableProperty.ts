import { isRefCodec, isRefListCodec, memberCodecOf, type AnyPropertySchema } from './api'
import type { QueryableField, RefTargetComparableProperty } from './facets'

/** A reference can compare through one stored scalar property shared by all its target types. */
export const resolveRefTargetComparableProperty = (
  schema: AnyPropertySchema,
  properties: ReadonlyMap<string, AnyPropertySchema> | null,
  {fields, targets, allowLists}: {
    fields: ReadonlyMap<string, QueryableField> | undefined
    targets: ReadonlyMap<string, RefTargetComparableProperty> | undefined
    allowLists: boolean
  },
): AnyPropertySchema | undefined => {
  const {codec} = schema
  if (fields?.has(schema.name) || !targets) return undefined
  if (!isRefCodec(codec) && !(allowLists && isRefListCodec(codec))) return undefined

  const firstType = codec.targetTypes[0]
  const property = firstType === undefined ? undefined : targets.get(firstType)?.property
  if (property === undefined || !codec.targetTypes.every(type => targets.get(type)?.property === property)) {
    return undefined
  }
  if (fields?.has(property)) return undefined
  const inner = properties?.get(property)
  return inner?.codec.where && !memberCodecOf(inner.codec) ? inner : undefined
}
