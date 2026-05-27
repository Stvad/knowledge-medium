import {
  ChangeScope,
  CodecError,
  codecs,
  defineProperty,
  type AnyPropertySchema,
  type BlockData,
  type PropertySchema,
} from '@/data/api'

/** Hidden marker on a property-value child. The value points at the
 *  user-defined property's schema block, not the mutable display name. */
export const propertyFieldIdProp = defineProperty<string | undefined>('system:propertyFieldId', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const isChildBackedPropertySchema = (
  schema: AnyPropertySchema,
): schema is AnyPropertySchema & {readonly fieldBlockId: string} =>
  typeof schema.fieldBlockId === 'string' && schema.fieldBlockId.length > 0

export const getPropertyFieldId = (
  data: Pick<BlockData, 'properties'> | null | undefined,
): string | undefined => {
  if (!data) return undefined
  const raw = data.properties[propertyFieldIdProp.name]
  if (raw === undefined) return undefined
  try {
    return propertyFieldIdProp.codec.decode(raw)
  } catch {
    return undefined
  }
}

export const findSchemaByFieldBlockId = (
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
  fieldBlockId: string,
): AnyPropertySchema | undefined => {
  for (const schema of propertySchemas.values()) {
    if (schema.fieldBlockId === fieldBlockId) return schema
  }
  return undefined
}

const finiteNumberFromContent = (content: string): number => {
  const value = Number(content.trim())
  if (!Number.isFinite(value)) throw new CodecError('finite number content', content)
  return value
}

const booleanFromContent = (content: string): boolean => {
  const normalized = content.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new CodecError('boolean content', content)
}

const jsonFromContent = (content: string): unknown => {
  try {
    return JSON.parse(content)
  } catch (err) {
    throw new CodecError('JSON content', err)
  }
}

const encodedValueToContent = (schema: AnyPropertySchema, encoded: unknown): string => {
  if (encoded === null || encoded === undefined) return ''
  if (
    schema.codec.type === 'string'
    || schema.codec.type === 'url'
    || schema.codec.type === 'ref'
    || schema.codec.type === 'date'
  ) {
    if (typeof encoded !== 'string') return JSON.stringify(encoded)
    return encoded
  }
  if (schema.codec.type === 'number' || schema.codec.type === 'boolean') {
    return String(encoded)
  }
  const serialized = JSON.stringify(encoded)
  return serialized === undefined ? '' : serialized
}

const contentToEncodedValue = (schema: AnyPropertySchema, content: string): unknown => {
  switch (schema.codec.type) {
    case 'string':
    case 'url':
    case 'ref':
      return content
    case 'date':
      return content.trim() === '' ? null : content.trim()
    case 'number':
      return finiteNumberFromContent(content)
    case 'boolean':
      return booleanFromContent(content)
    default:
      return jsonFromContent(content)
  }
}

/** Serialize a typed property value into the editable content of its
 *  backing child. Scalars stay human-readable; structured values fall
 *  back to their codec-encoded JSON. */
export const propertyValueToChildContent = <T>(
  schema: PropertySchema<T>,
  value: T,
): string => encodedValueToContent(schema, schema.codec.encode(value))

/** Parse a property-value child back into the canonical encoded value
 *  stored on the parent cache. Throws when the child content cannot be
 *  interpreted for this field's current codec. */
export const propertyChildContentToEncodedValue = (
  schema: AnyPropertySchema,
  content: string,
): unknown => {
  const encoded = contentToEncodedValue(schema, content)
  // Decode and re-encode so tolerant user text ("1" for number,
  // date strings, etc.) lands in the same canonical JSON shape as
  // tx.setProperty would have stored directly.
  return schema.codec.encode(schema.codec.decode(encoded))
}

const sameJson = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b)

export const propertiesEqual = (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean => sameJson(a, b)
