import { describe, expect, it } from 'vitest'
import { codecs, CodecError } from './codecs'

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

describe('codecs.date', () => {
  it('encodes to ISO string and decodes back', () => {
    const d = new Date('2026-04-29T12:34:56.789Z')
    const encoded = codecs.date.encode(d)
    expect(encoded).toBe('2026-04-29T12:34:56.789Z')
    const decoded = codecs.date.decode(encoded)
    expect(decoded.getTime()).toBe(d.getTime())
  })

  it('rejects non-ISO strings and bad shapes', () => {
    expect(() => codecs.date.decode('not a date')).toThrow(CodecError)
    expect(() => codecs.date.decode(1234567890)).toThrow(CodecError)
    expect(() => codecs.date.decode(null)).toThrow(CodecError)
  })
})

describe('codecs.optional', () => {
  const inner = codecs.optional(codecs.string)

  it('encodes undefined as null and decodes null/undefined to undefined', () => {
    expect(inner.encode(undefined)).toBeNull()
    expect(inner.decode(null)).toBeUndefined()
    expect(inner.decode(undefined)).toBeUndefined()
  })

  it('round-trips a defined value through the inner codec', () => {
    expect(inner.encode('x')).toBe('x')
    expect(inner.decode(inner.encode('x'))).toBe('x')
  })

  it('forwards the inner codec error on shape mismatch', () => {
    expect(() => inner.decode(42)).toThrow(CodecError)
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

describe('CodecError', () => {
  it('mentions expected shape and a preview of what it got', () => {
    const e = new CodecError('string', {weird: 'shape'})
    expect(e.message).toContain('expected string')
    expect(e.message).toContain('object')
  })
})
