import {
  isRefCodec,
  isRefListCodec,
  type AnyPropertySchema,
  type BlockData,
  type BlockReference,
} from '@/data/api'

const appendPropertyRef = (
  refs: BlockReference[],
  seen: Set<string>,
  sourceField: string,
  id: string,
): void => {
  const targetId = id.trim()
  if (!targetId) return
  const key = `${sourceField}\u0000${targetId}`
  if (seen.has(key)) return
  seen.add(key)
  refs.push({id: targetId, alias: targetId, sourceField})
}

export const projectPropertyReferences = (
  source: Pick<BlockData, 'properties'>,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): BlockReference[] => {
  const refs: BlockReference[] = []
  const seen = new Set<string>()

  for (const [name, encodedValue] of Object.entries(source.properties)) {
    const schema = propertySchemas.get(name)
    if (!schema) continue

    if (isRefCodec(schema.codec)) {
      try {
        appendPropertyRef(refs, seen, name, schema.codec.decode(encodedValue))
      } catch {
        // Decode failures are property-local. One malformed typed field
        // should not block content refs or other well-formed ref fields.
      }
      continue
    }

    if (isRefListCodec(schema.codec)) {
      try {
        for (const id of schema.codec.decode(encodedValue)) {
          appendPropertyRef(refs, seen, name, id)
        }
      } catch {
        // See single-ref case above.
      }
    }
  }

  return refs
}
