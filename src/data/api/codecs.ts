import { CodecError } from './errors'

/** Bidirectional encode/decode for typed values stored in the JSON-shaped
 *  `properties_json` column. Codecs run at exactly four boundary call sites
 *  (`block.set`, `block.get`, `tx.setProperty`, `tx.getProperty`); storage
 *  and cache always hold the encoded shape. See spec §5.6. */
export interface Codec<T> {
  /** Encode to a JSON-serializable value. */
  encode(value: T): unknown
  /** Decode from a JSON-decoded value. Throws CodecError on shape mismatch. */
  decode(json: unknown): T
}

const stringCodec: Codec<string> = {
  encode: v => v,
  decode: j => {
    if (typeof j !== 'string') throw new CodecError('string', j)
    return j
  },
}

const numberCodec: Codec<number> = {
  encode: v => v,
  decode: j => {
    if (typeof j !== 'number') throw new CodecError('number', j)
    return j
  },
}

const booleanCodec: Codec<boolean> = {
  encode: v => v,
  decode: j => {
    if (typeof j !== 'boolean') throw new CodecError('boolean', j)
    return j
  },
}

const dateCodec: Codec<Date> = {
  encode: v => v.toISOString(),
  decode: j => {
    if (typeof j !== 'string') throw new CodecError('date', j)
    const d = new Date(j)
    if (Number.isNaN(d.getTime())) throw new CodecError('date', j)
    return d
  },
}

const optional = <T>(inner: Codec<T>): Codec<T | undefined> => ({
  encode: v => (v === undefined ? null : inner.encode(v)),
  decode: j => (j === null || j === undefined ? undefined : inner.decode(j)),
})

const list = <T>(inner: Codec<T>): Codec<T[]> => ({
  encode: v => v.map(item => inner.encode(item)),
  decode: j => {
    if (!Array.isArray(j)) throw new CodecError('array', j)
    return j.map(item => inner.decode(item))
  },
})

/** Explicitly unsafe identity codec. Reserved for kernel-internal use where
 *  the JSON shape is guaranteed by construction. NOT a default for plugin
 *  authors — pick a primitive codec or compose your own. */
const unsafeIdentity = <T>(): Codec<T> => ({
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
  unsafeIdentity,
}

export { CodecError }
