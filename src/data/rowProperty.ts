import type {BlockData} from '@/data/api'

/** The minimal shape needed to read + decode a stored value off a raw row: a
 *  property's stored name and its codec. A `PropertySchema` satisfies it. */
interface DecodableProperty<T> {
  readonly name: string
  readonly codec: {decode(value: unknown): T}
}

interface DefaultingProperty<T> extends DecodableProperty<T> {
  readonly defaultValue: T
}

/** Decode a property's stored value straight off a raw row, or `undefined` when
 *  the property is absent. Reads the cell under the schema's own name: no
 *  winner resolution (that is `peekResolvedProperty`) and no cache-backed
 *  facade, so a caller holding authoritative `BlockData` reads exactly it.
 *  A decode error PROPAGATES: the caller decides whether a malformed value is
 *  fatal. */
export const peekRowProperty = <T>(
  row: Pick<BlockData, 'properties'>,
  property: DecodableProperty<T>,
): T | undefined => {
  const raw = row.properties[property.name]
  return raw === undefined ? undefined : property.codec.decode(raw)
}

/** Decode present-or-default: the field's `defaultValue` when absent, else the
 *  decoded value. A decode error PROPAGATES — use this for identity / write-policy
 *  fields where a malformed value must reject the whole definition, because a
 *  schema you can't trust is dangerous (every value stored under it is read
 *  through it). Its lenient twin is `safeDecodeRowProperty`. */
export const decodeRowProperty = <T>(
  row: Pick<BlockData, 'properties'>,
  property: DefaultingProperty<T>,
): T => {
  const raw = row.properties[property.name]
  return raw === undefined ? property.defaultValue : property.codec.decode(raw)
}

/** Like `decodeRowProperty`, but a decode error ALSO falls back to the default.
 *  Use this for display-only chrome (label / description / color / hide-flags):
 *  a malformed value from a raw import/sync/bridge write must never drop the
 *  whole row from registries and pickers — the identity is structural, so
 *  degrade the cosmetic field and keep the row. */
export const safeDecodeRowProperty = <T>(
  row: Pick<BlockData, 'properties'>,
  property: DefaultingProperty<T>,
): T => {
  try {
    return decodeRowProperty(row, property)
  } catch {
    return property.defaultValue
  }
}
