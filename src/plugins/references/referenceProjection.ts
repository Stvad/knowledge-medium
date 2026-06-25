import {
  decodeRefListIds,
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
      // Element-wise lenient decode: a single malformed element drops only
      // itself instead of stripping the whole field's backlinks to [] (#189).
      for (const id of decodeRefListIds(schema.codec, encodedValue)) {
        appendPropertyRef(refs, seen, name, id)
      }
    }
  }

  return refs
}

/** A prior property-derived ref a recompute must RETAIN rather than drop — the
 *  retain-on-source half of the add-only contract
 *  (docs/contracts/derived-data-add-only.md). True iff:
 *   - it's property-derived (`sourceField` set), AND
 *   - its schema is currently ABSENT from the registry — the owning plugin is
 *     toggled off / not yet loaded, so we *can't* re-derive it — AND
 *   - the field still holds a value (the relationship is still encoded), AND
 *   - this write did NOT change that field's own value.
 *  The last clause is the one exception to retention: if THIS write changed the
 *  field's value, a retained ref would contradict the new value and we can't
 *  re-derive it without the schema, so it's allowed to drop. A *present* schema
 *  (ref or non-ref) is handled by `projectPropertyReferences` above — it
 *  re-derives, or correctly drops a redefined-to-non-ref field's stale refs.
 *  Shared by the references post-commit processor and the Roam importer's
 *  reference rebuild so both honour the contract identically. */
export const isRetainableAbsentRef = (
  ref: BlockReference,
  after: Pick<BlockData, 'properties'>,
  before: Pick<BlockData, 'properties'> | null,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): boolean => {
  if (!ref.sourceField) return false
  if (propertySchemas.has(ref.sourceField)) return false
  const afterValue = after.properties[ref.sourceField]
  if (afterValue === undefined) return false
  return JSON.stringify(before?.properties[ref.sourceField]) === JSON.stringify(afterValue)
}
