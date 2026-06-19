import { describe, expect, it } from 'vitest'
import {
  codecs,
  CodecError,
  decodeRefListIds,
  isRefCodec,
  isRefListCodec,
  type RefListCodec,
} from './codecs'
import { assertRefListDeriveIsAddOnly } from '@/data/test/derivedDataContract'

describe('codec type metadata', () => {
  it('tags primitive and composed codecs with stable type ids', () => {
    expect(codecs.string.type).toBe('string')
    expect(codecs.number.type).toBe('number')
    expect(codecs.boolean.type).toBe('boolean')
    // Date is natively absence-aware (Codec<Date | undefined>).
    expect(codecs.date.type).toBe('date')
    expect(codecs.url.type).toBe('url')
    expect(codecs.list(codecs.number).type).toBe('list')
    expect(codecs.ref().type).toBe('ref')
    expect(codecs.refList().type).toBe('refList')
    expect(codecs.unsafeIdentity().type).toBe('object')
    expect(codecs.unsafeIdentity('string').type).toBe('string')
  })

  it('routes ref/refList recognition through type identity', () => {
    expect(isRefCodec(codecs.ref())).toBe(true)
    expect(isRefListCodec(codecs.refList())).toBe(true)
    expect(isRefCodec(codecs.string)).toBe(false)
    expect(isRefListCodec(codecs.list(codecs.string))).toBe(false)
  })
})

describe('codec where capability', () => {
  it('exposes where on scalar primitives but not on collections/refs', () => {
    expect(codecs.string.where).toBeDefined()
    expect(codecs.number.where).toBeDefined()
    expect(codecs.boolean.where).toBeDefined()
    expect(codecs.date.where).toBeDefined()
    expect(codecs.url.where).toBeDefined()
    expect(codecs.list(codecs.string).where).toBeUndefined()
    expect(codecs.unsafeIdentity().where).toBeUndefined()
    expect(codecs.ref().where).toBeUndefined()
    expect(codecs.refList().where).toBeUndefined()
  })

  it('booleans bind 0/1 for SQL equality', () => {
    expect(codecs.boolean.where!.encode(true)).toBe(1)
    expect(codecs.boolean.where!.encode(false)).toBe(0)
  })

  it('dates bind ISO strings', () => {
    const d = new Date('2026-04-29T12:34:56.789Z')
    expect(codecs.date.where!.encode(d)).toBe('2026-04-29T12:34:56.789Z')
  })

  it('date.where also accepts an already-encoded ISO string (idempotent)', () => {
    // Persisted operator predicates (e.g. backlinks:predicates) go
    // through JSON.stringify, which turns Date instances into ISO
    // strings. On reload the compiler re-runs `where.encode` on the
    // rehydrated value; rejecting the string would break every saved
    // date-range filter. Both shapes normalise to the same scalar.
    const iso = '2026-04-29T12:34:56.789Z'
    expect(codecs.date.where!.encode(iso as unknown as Date)).toBe(iso)
    // Strings that don't parse as dates still throw.
    expect(() => codecs.date.where!.encode('not-a-date' as unknown as Date))
      .toThrow(CodecError)
  })

  it('validates input types and rejects mismatches', () => {
    expect(() => codecs.string.where!.encode(42 as unknown as string)).toThrow(CodecError)
    expect(() => codecs.boolean.where!.encode('true' as unknown as boolean)).toThrow(CodecError)
    expect(() => codecs.number.where!.encode('42' as unknown as number)).toThrow(CodecError)
    expect(() => codecs.date.where!.encode('not a date' as unknown as Date)).toThrow(CodecError)
  })

  it('date.where rejects undefined directly (codec is natively absence-aware)', () => {
    expect(() => codecs.date.where!.encode(undefined)).toThrow(CodecError)
    const d = new Date('2026-04-29T00:00:00.000Z')
    expect(codecs.date.where!.encode(d)).toBe('2026-04-29T00:00:00.000Z')
  })
})

describe('codecs.string', () => {
  it('round-trips ascii and unicode', () => {
    for (const v of ['', 'hello', 'café 🐈‍⬛', '\n\t']) {
      expect(codecs.string.decode(codecs.string.encode(v))).toBe(v)
    }
  })

  it('rejects non-strings', () => {
    expect(() => codecs.string.decode(42)).toThrow(CodecError)
    expect(() => codecs.string.decode(null)).toThrow(CodecError)
    expect(() => codecs.string.decode({})).toThrow(CodecError)
  })
})

describe('codecs.number', () => {
  it('round-trips finite numbers', () => {
    expect(codecs.number.decode(codecs.number.encode(0))).toBe(0)
    expect(codecs.number.decode(codecs.number.encode(-3.14))).toBeCloseTo(-3.14)
  })

  it('rejects strings even if numeric', () => {
    expect(() => codecs.number.decode('42')).toThrow(CodecError)
  })

  it('rejects non-finite values before JSON storage can coerce them', () => {
    expect(() => codecs.number.encode(Number.NaN)).toThrow(CodecError)
    expect(() => codecs.number.encode(Number.POSITIVE_INFINITY)).toThrow(CodecError)
    expect(() => codecs.number.decode(Number.NEGATIVE_INFINITY)).toThrow(CodecError)
  })
})

describe('codecs.boolean', () => {
  it('round-trips true/false', () => {
    expect(codecs.boolean.decode(codecs.boolean.encode(true))).toBe(true)
    expect(codecs.boolean.decode(codecs.boolean.encode(false))).toBe(false)
  })

  it('rejects truthy non-booleans', () => {
    expect(() => codecs.boolean.decode(1)).toThrow(CodecError)
    expect(() => codecs.boolean.decode('true')).toThrow(CodecError)
  })
})

describe('codecs.date (natively absence-aware)', () => {
  it('encodes a defined Date to ISO string and round-trips', () => {
    const d = new Date('2026-04-29T12:34:56.789Z')
    const encoded = codecs.date.encode(d)
    expect(encoded).toBe('2026-04-29T12:34:56.789Z')
    const decoded = codecs.date.decode(encoded)
    expect(decoded?.getTime()).toBe(d.getTime())
  })

  it('encodes undefined as null and decodes null/undefined to undefined', () => {
    expect(codecs.date.encode(undefined)).toBeNull()
    expect(codecs.date.decode(null)).toBeUndefined()
    expect(codecs.date.decode(undefined)).toBeUndefined()
  })

  it('rejects non-ISO strings and bad non-null shapes', () => {
    expect(() => codecs.date.decode('not a date')).toThrow(CodecError)
    expect(() => codecs.date.decode(1234567890)).toThrow(CodecError)
  })
})

describe('codecs.list', () => {
  const inner = codecs.list(codecs.number)

  it('round-trips arrays element-wise', () => {
    expect(inner.decode(inner.encode([1, 2, 3]))).toEqual([1, 2, 3])
    expect(inner.decode(inner.encode([]))).toEqual([])
  })

  it('rejects non-arrays', () => {
    expect(() => inner.decode('not an array')).toThrow(CodecError)
    expect(() => inner.decode({0: 1, length: 1})).toThrow(CodecError)
  })

  it('propagates inner-codec errors on bad elements', () => {
    expect(() => inner.decode([1, 'two'])).toThrow(CodecError)
  })
})

describe('codecs.ref', () => {
  it('round-trips target ids and exposes ref metadata', () => {
    const inner = codecs.ref({targetTypes: ['project']})
    expect(inner.decode(inner.encode('target-1'))).toBe('target-1')
    expect(inner.type).toBe('ref')
    expect(inner.targetTypes).toEqual(['project'])
    expect(isRefCodec(inner)).toBe(true)
    expect(isRefListCodec(inner)).toBe(false)
  })

  it('rejects non-string targets', () => {
    expect(() => codecs.ref().decode(['target-1'])).toThrow(CodecError)
  })
})

describe('codecs.refList', () => {
  it('round-trips target id arrays and exposes ref-list metadata', () => {
    const inner = codecs.refList({targetTypes: ['task']})
    expect(inner.decode(inner.encode(['a', 'b']))).toEqual(['a', 'b'])
    expect(inner.type).toBe('refList')
    expect(inner.targetTypes).toEqual(['task'])
    expect(isRefListCodec(inner)).toBe(true)
    expect(isRefCodec(inner)).toBe(false)
  })

  it('rejects non-arrays and non-string members', () => {
    expect(() => codecs.refList().decode('target-1')).toThrow(CodecError)
    expect(() => codecs.refList().decode(['target-1', 42])).toThrow(CodecError)
  })

  it('decodeValid keeps well-formed ids and drops only the malformed elements (#189)', () => {
    const inner = codecs.refList()
    // The historical whole-field strip: one bad element must NOT discard the
    // valid backlinks alongside it.
    expect(inner.decodeValid!(['valid-1', 'valid-2', 42])).toEqual(['valid-1', 'valid-2'])
    expect(inner.decodeValid!(['a', null, 'b', {}, 'c'])).toEqual(['a', 'b', 'c'])
    expect(inner.decodeValid!([])).toEqual([])
    expect(inner.decodeValid!(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('decodeValid returns [] for non-array input (nothing recoverable)', () => {
    expect(codecs.refList().decodeValid!('target-1')).toEqual([])
    expect(codecs.refList().decodeValid!(42)).toEqual([])
    expect(codecs.refList().decodeValid!(null)).toEqual([])
  })
})

describe('decodeRefListIds', () => {
  it('uses the codec decodeValid when present (lenient element-wise, #189)', () => {
    expect(decodeRefListIds(codecs.refList(), ['valid-1', 42, 'valid-2'])).toEqual(['valid-1', 'valid-2'])
    expect(decodeRefListIds(codecs.refList(), 'not-an-array')).toEqual([])
  })

  it('satisfies the shared add-only / retain-on-source contract', () => {
    const codec = codecs.refList()
    assertRefListDeriveIsAddOnly(value => decodeRefListIds(codec, value))
  })

  it('falls back to a method-free string filter for a codec lacking decodeValid', () => {
    // Models a RefListCodec authored against the pre-decodeValid public
    // interface (RefListCodec is exported, so external/older plugins may
    // implement only the original shape). It must not throw
    // `decodeValid is not a function` and abort the block's whole projection
    // — it recovers the well-formed ids the same way.
    const legacy: RefListCodec = {
      type: 'refList',
      targetTypes: [],
      encode: v => v.map(item => item),
      decode: j => {
        if (!Array.isArray(j)) throw new CodecError('array', j)
        return j.map(item => {
          if (typeof item !== 'string') throw new CodecError('string', item)
          return item
        })
      },
    }
    expect(legacy.decodeValid).toBeUndefined()
    expect(decodeRefListIds(legacy, ['valid-1', 42, 'valid-2'])).toEqual(['valid-1', 'valid-2'])
    expect(decodeRefListIds(legacy, 'not-an-array')).toEqual([])
  })
})

describe('CodecError', () => {
  it('mentions expected shape and a preview of what it got', () => {
    const e = new CodecError('string', {weird: 'shape'})
    expect(e.message).toContain('expected string')
    expect(e.message).toContain('object')
  })
})
