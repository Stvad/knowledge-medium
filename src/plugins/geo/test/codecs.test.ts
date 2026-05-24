import { describe, expect, it } from 'vitest'
import { CodecError } from '@/data/api/codecs'
import { optionalRefCodec } from '../codecs'

describe('optionalRefCodec', () => {
  it('round-trips a string id', () => {
    const codec = optionalRefCodec()
    const encoded = codec.encode('block-123')
    expect(encoded).toBe('block-123')
    expect(codec.decode(encoded)).toBe('block-123')
  })

  it('encodes undefined to null', () => {
    expect(optionalRefCodec().encode(undefined)).toBeNull()
  })

  it('decodes null and undefined back to undefined', () => {
    const codec = optionalRefCodec()
    expect(codec.decode(null)).toBeUndefined()
    expect(codec.decode(undefined)).toBeUndefined()
  })

  it('rejects non-string, non-null JSON on decode', () => {
    const codec = optionalRefCodec()
    expect(() => codec.decode(42)).toThrow(CodecError)
    expect(() => codec.decode({id: 'x'})).toThrow(CodecError)
    expect(() => codec.decode(['a'])).toThrow(CodecError)
  })

  it('carries targetTypes when provided', () => {
    const codec = optionalRefCodec({targetTypes: ['place', 'page']})
    expect(codec.targetTypes).toEqual(['place', 'page'])
  })

  it('defaults targetTypes to an empty array', () => {
    expect(optionalRefCodec().targetTypes).toEqual([])
  })

  it('reports the ref discriminator type', () => {
    expect(optionalRefCodec().type).toBe('ref')
  })
})
