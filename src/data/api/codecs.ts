import { CodecError } from './errors'

/** Bidirectional encode/decode for typed values stored in the JSON-shaped
 *  `properties_json` column. Codecs run at exactly four boundary call sites
 *  (`block.set`, `block.get`, `tx.setProperty`, `tx.getProperty`); storage
 *  and cache always hold the encoded shape. See spec §5.6 and the
 *  user-defined-properties §1a doc for the open-string `type` discriminator. */

/** Scalar value compatible with `json_extract(...) = ?` parameter binding.
 *  Excludes null deliberately — typed-query callers use `null` to mean
 *  "match unset" and the compiler short-circuits that to `IS NULL` *before*
 *  calling `where.encode`. A codec returning null from `where.encode` would
 *  compare-equal to SQL NULL and match no rows; narrowing the return type
 *  here makes that mistake unrepresentable. */
export type WhereValue = string | number

export interface WhereCapability<T> {
  /** Encode a decoded value to its scalar SQLite-comparable form. The
   *  caller can pass any runtime value, so this MUST validate that the
   *  input is actually a value of type T and throw `CodecError`
   *  otherwise — the same shape as `decode` validating its JSON input. */
  encode(value: T): WhereValue
}

export interface Codec<T> {
  /** Open-string discriminator. Stable preset id for codecs built by a
   *  ValuePreset (`'string'`, `'number'`, `'ref'`, `'url'`, …); plugin
   *  codecs MUST pick a unique value so the preset/editor lookup is
   *  unambiguous. */
  readonly type: string
  /** Encode to a JSON-serializable value. Called only on validated `T`
   *  from the type system at the four boundary call sites — does not
   *  validate input. */
  encode(value: T): unknown
  /** Decode from a JSON-decoded value. Throws CodecError on shape mismatch. */
  decode(json: unknown): T
  /** Optional capability: this codec can produce a scalar SQLite value
   *  for `json_extract(properties_json, ?) = ?` comparison. Codecs that
   *  cannot — refs (route via referencedBy), lists, objects — omit it.
   *  Presence of `where` is the authoritative signal that the property
   *  is queryable. */
  readonly where?: WhereCapability<T>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCodec = Codec<any>

export interface RefCodecOptions {
  readonly targetTypes?: readonly string[]
}

export interface RefCodec extends Codec<string> {
  readonly type: 'ref'
  readonly targetTypes: readonly string[]
}

export interface RefListCodec extends Codec<readonly string[]> {
  readonly type: 'refList'
  readonly targetTypes: readonly string[]
}

const stringCodec: Codec<string> = {
  type: 'string',
  encode: v => v,
  decode: j => {
    if (typeof j !== 'string') throw new CodecError('string', j)
    return j
  },
  where: {
    encode: v => {
      if (typeof v !== 'string') throw new CodecError('string', v)
      return v
    },
  },
}

const requireFiniteNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CodecError('finite number', value)
  }
  return value
}

const numberCodec: Codec<number> = {
  type: 'number',
  encode: requireFiniteNumber,
  decode: requireFiniteNumber,
  where: { encode: requireFiniteNumber },
}

const booleanCodec: Codec<boolean> = {
  type: 'boolean',
  encode: v => v,
  decode: j => {
    if (typeof j !== 'boolean') throw new CodecError('boolean', j)
    return j
  },
  where: {
    encode: v => {
      if (typeof v !== 'boolean') throw new CodecError('boolean', v)
      return v ? 1 : 0
    },
  },
}

/** Date codec is natively absence-aware — value type is `Date | undefined`,
 *  encode produces JSON null on undefined, decode round-trips. There's
 *  no inert "no value" Date sentinel (every Date instance is a real
 *  time), so absence has to be expressible at the codec level. See the
 *  user-defined-properties.md "Why no codecs.optional" section. */
const dateCodec: Codec<Date | undefined> = {
  type: 'date',
  encode: v => (v === undefined ? null : v.toISOString()),
  decode: j => {
    if (j === null || j === undefined) return undefined
    if (typeof j !== 'string') throw new CodecError('date', j)
    const d = new Date(j)
    if (Number.isNaN(d.getTime())) throw new CodecError('date', j)
    return d
  },
  where: {
    encode: v => {
      // null is short-circuited to IS NULL by the typed-query compiler
      // before reaching where.encode. undefined arriving here is a
      // caller bug — typed-query callers use null for unset matching.
      if (v === undefined) throw new CodecError('date (use null for unset)', v)
      if (!(v instanceof Date) || Number.isNaN(v.getTime())) throw new CodecError('date', v)
      return v.toISOString()
    },
  },
}

const list = <T>(inner: Codec<T>): Codec<T[]> => ({
  type: 'list',
  encode: v => v.map(item => inner.encode(item)),
  decode: j => {
    if (!Array.isArray(j)) throw new CodecError('array', j)
    return j.map(item => inner.decode(item))
  },
})

const normalizeTargetTypes = (options: RefCodecOptions = {}): readonly string[] =>
  Object.freeze([...(options.targetTypes ?? [])])

const ref = (options?: RefCodecOptions): RefCodec => ({
  type: 'ref',
  targetTypes: normalizeTargetTypes(options),
  encode: stringCodec.encode,
  decode: stringCodec.decode,
})

const refList = (options?: RefCodecOptions): RefListCodec => {
  return {
    type: 'refList',
    targetTypes: normalizeTargetTypes(options),
    encode: v => v.map(item => stringCodec.encode(item)),
    decode: j => {
      if (!Array.isArray(j)) throw new CodecError('array', j)
      return j.map(item => stringCodec.decode(item))
    },
  }
}

export const isRefCodec = (codec: unknown): codec is RefCodec =>
  typeof codec === 'object' && codec !== null && (codec as Codec<unknown>).type === 'ref'

export const isRefListCodec = (codec: unknown): codec is RefListCodec =>
  typeof codec === 'object' && codec !== null && (codec as Codec<unknown>).type === 'refList'

/** URL codec: plain string with light validation on encode/decode.
 *  Currently accepts any non-empty string; tightening the validation
 *  (URL parser, allowed schemes) is a follow-up. */
const validateUrlString = (value: unknown): string => {
  if (typeof value !== 'string') throw new CodecError('url', value)
  return value
}
const urlCodec: Codec<string> = {
  type: 'url',
  encode: validateUrlString,
  decode: validateUrlString,
  where: { encode: validateUrlString },
}

/** Explicitly unsafe identity codec. Reserved for kernel-internal use where
 *  the JSON shape is guaranteed by construction. NOT a default for plugin
 *  authors — pick a primitive codec or compose your own. The `type`
 *  argument lets callers tag the codec for the inferTypeFromValue
 *  fallback path; pass `'object'` for object-shaped data, `'string'`
 *  for opaque strings, etc. */
const unsafeIdentity = <T>(type = 'object'): Codec<T> => ({
  type,
  encode: v => v as unknown,
  decode: j => j as T,
})

export const codecs = {
  string: stringCodec,
  number: numberCodec,
  boolean: booleanCodec,
  /** Date codec is natively absence-aware (`Codec<Date | undefined>`).
   *  No generic `codecs.optional` wrapper exists — see the
   *  user-defined-properties.md "Why no codecs.optional" section. */
  date: dateCodec,
  url: urlCodec,
  list,
  ref,
  refList,
  unsafeIdentity,
}

export { CodecError }
