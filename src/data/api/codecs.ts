import { CodecError } from './errors'

/** Bidirectional encode/decode for typed values stored in the JSON-shaped
 *  `properties_json` column. Codecs run at exactly four boundary call sites
 *  (`block.set`, `block.get`, `tx.setProperty`, `tx.getProperty`); storage
 *  and cache always hold the encoded shape. See spec §5.6. */
export type CodecShape = 'string' | 'number' | 'boolean' | 'list' | 'object' | 'date'

export interface Codec<T> {
  /** Primitive editor/storage shape. Semantic codecs can add metadata. */
  readonly shape: CodecShape
  /** Encode to a JSON-serializable value. */
  encode(value: T): unknown
  /** Decode from a JSON-decoded value. Throws CodecError on shape mismatch. */
  decode(json: unknown): T
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCodec = Codec<any>

export interface RefCodecOptions {
  readonly targetTypes?: readonly string[]
}

export interface RefCodec extends Codec<string> {
  readonly refKind: 'ref'
  readonly targetTypes: readonly string[]
}

export interface RefListCodec extends Codec<readonly string[]> {
  readonly refKind: 'refList'
  readonly targetTypes: readonly string[]
}

const stringCodec: Codec<string> = {
  shape: 'string',
  encode: v => v,
  decode: j => {
    if (typeof j !== 'string') throw new CodecError('string', j)
    return j
  },
}

const requireFiniteNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CodecError('finite number', value)
  }
  return value
}

const numberCodec: Codec<number> = {
  shape: 'number',
  encode: requireFiniteNumber,
  decode: requireFiniteNumber,
}

const booleanCodec: Codec<boolean> = {
  shape: 'boolean',
  encode: v => v,
  decode: j => {
    if (typeof j !== 'boolean') throw new CodecError('boolean', j)
    return j
  },
}

const dateCodec: Codec<Date> = {
  shape: 'date',
  encode: v => v.toISOString(),
  decode: j => {
    if (typeof j !== 'string') throw new CodecError('date', j)
    const d = new Date(j)
    if (Number.isNaN(d.getTime())) throw new CodecError('date', j)
    return d
  },
}

const optional = <T>(inner: Codec<T>): Codec<T | undefined> => ({
  shape: inner.shape,
  encode: v => (v === undefined ? null : inner.encode(v)),
  decode: j => (j === null || j === undefined ? undefined : inner.decode(j)),
})

const list = <T>(inner: Codec<T>): Codec<T[]> => ({
  shape: 'list',
  encode: v => v.map(item => inner.encode(item)),
  decode: j => {
    if (!Array.isArray(j)) throw new CodecError('array', j)
    return j.map(item => inner.decode(item))
  },
})

const normalizeTargetTypes = (options: RefCodecOptions = {}): readonly string[] =>
  Object.freeze([...(options.targetTypes ?? [])])

const ref = (options?: RefCodecOptions): RefCodec => ({
  shape: 'string',
  refKind: 'ref',
  targetTypes: normalizeTargetTypes(options),
  encode: stringCodec.encode,
  decode: stringCodec.decode,
})

const refList = (options?: RefCodecOptions): RefListCodec => {
  return {
    shape: 'list',
    refKind: 'refList',
    targetTypes: normalizeTargetTypes(options),
    encode: v => v.map(item => stringCodec.encode(item)),
    decode: j => {
      if (!Array.isArray(j)) throw new CodecError('array', j)
      return j.map(item => stringCodec.decode(item))
    },
  }
}

export const isRefCodec = (codec: unknown): codec is RefCodec =>
  (codec as Partial<RefCodec>).refKind === 'ref'

export const isRefListCodec = (codec: unknown): codec is RefListCodec =>
  (codec as Partial<RefListCodec>).refKind === 'refList'

const hasCodecShape = (codec: unknown, shape: CodecShape): codec is Codec<unknown> =>
  (codec as Partial<Codec<unknown>>).shape === shape

export const isStringCodec = (codec: unknown): codec is Codec<string> =>
  hasCodecShape(codec, 'string')

export const isNumberCodec = (codec: unknown): codec is Codec<number> =>
  hasCodecShape(codec, 'number')

export const isBooleanCodec = (codec: unknown): codec is Codec<boolean> =>
  hasCodecShape(codec, 'boolean')

export const isListCodec = (codec: unknown): codec is Codec<readonly unknown[]> =>
  hasCodecShape(codec, 'list')

export const isObjectCodec = (codec: unknown): codec is Codec<Record<string, unknown>> =>
  hasCodecShape(codec, 'object')

export const isDateCodec = (codec: unknown): codec is Codec<Date> =>
  hasCodecShape(codec, 'date')

/** Explicitly unsafe identity codec. Reserved for kernel-internal use where
 *  the JSON shape is guaranteed by construction. NOT a default for plugin
 *  authors — pick a primitive codec or compose your own. */
const unsafeIdentity = <T>(shape: CodecShape = 'object'): Codec<T> => ({
  shape,
  encode: v => v as unknown,
  decode: j => j as T,
})

export const codecs = {
  string: stringCodec,
  number: numberCodec,
  boolean: booleanCodec,
  date: dateCodec,
  optional,
  list,
  ref,
  refList,
  unsafeIdentity,
}

export { CodecError }
