import {
  CodecError,
  type AnyPropertySchema,
  type BlockData,
  type PropertySchema,
} from '@/data/api'

export const isPropertyValueChild = (
  data: Pick<BlockData, 'fieldId'> | null | undefined,
): boolean => Boolean(data?.fieldId)

export const getPropertyFieldId = (
  data: Pick<BlockData, 'fieldId'> | null | undefined,
): string | undefined => data?.fieldId ?? undefined

export const isChildBackedPropertySchema = (
  schema: AnyPropertySchema,
): schema is AnyPropertySchema & {readonly fieldId: string} =>
  typeof schema.fieldId === 'string' && schema.fieldId.length > 0

export const findSchemaByFieldId = (
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
  fieldId: string,
): AnyPropertySchema | undefined => {
  for (const schema of propertySchemas.values()) {
    if (schema.fieldId === fieldId) return schema
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

const codecAcceptsNull = (schema: AnyPropertySchema): boolean => {
  try {
    schema.codec.decode(null)
    return true
  } catch {
    return false
  }
}

const encodedValueToContent = (schema: AnyPropertySchema, encoded: unknown): string => {
  if (encoded === undefined) return ''
  if (encoded === null) return codecAcceptsNull(schema) ? 'null' : ''
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
  if (content.trim() === 'null' && codecAcceptsNull(schema)) {
    return schema.codec.encode(schema.codec.decode(null))
  }
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

export const encodedPropertyValueToChildContent = (
  schema: AnyPropertySchema,
  encoded: unknown,
): string => encodedValueToContent(schema, encoded)

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
