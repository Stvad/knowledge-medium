import { describe, expect, it } from 'vitest'
import { hasLoneSurrogate } from '@/utils/string'
import { snippet } from '../agentViews/text'
import { decodeProperty, isEmptyValue } from '../agentViews/properties'
import type { AnyPropertySchema } from '@/data/api'

describe('snippet', () => {
  it('never cuts an astral character in half, whichever side of a pair its boundaries land on', () => {
    const content = `${'\u{1F600}'.repeat(100)} needle ${'\u{1F600}'.repeat(100)}`
    // Odd and even widths put each boundary on both halves of a pair.
    for (const width of [139, 140, 141, 142]) {
      const out = snippet(content, 'needle', width)
      expect(out).toContain('needle')
      expect(hasLoneSurrogate(out)).toBe(false)
    }
  })
})

describe('snippet anchoring', () => {
  it('never centers on a word from an excluded phrase', () => {
    const content = `enormousword ${'filler '.repeat(40)} the cat sat`
    expect(snippet(content, 'cat -"one enormousword three"')).toContain('cat sat')
    expect(snippet(content, 'cat NOT enormousword')).toContain('cat sat')
  })
})

describe('decodeProperty', () => {
  // An atomic encoding: valid only whole (here, it must end with 'end').
  const atomic = {codec: {
    type: 'test-atomic',
    encode: (value: unknown) => value,
    decode: (value: unknown) => {
      if (!Array.isArray(value) || value.at(-1) !== 'end') throw new Error('not a whole encoding')
      return value
    },
  }} as unknown as AnyPropertySchema
  const raw = [...Array.from({length: 150}, (_, i) => i), 'end']

  it('decodes an atomic array whole, never a head of it', () => {
    const decoded = decodeProperty(atomic, raw)
    expect(decoded).toMatchObject({kind: 'value'})
    expect((decoded as {value: unknown[]}).value).toHaveLength(151)
  })

  it('reads only a head of a schemaless list, keeping its length', () => {
    const decoded = decodeProperty(undefined, raw) as {value: unknown[], total: number}
    expect(decoded.value).toHaveLength(100)
    expect(decoded.total).toBe(151)
  })
})

describe('isEmptyValue', () => {
  it('treats [] as empty only for a list, never for an atomic encoding', () => {
    const atomic = {codec: {type: 'test-atomic', encode: (v: unknown) => v, decode: (v: unknown) => v}} as unknown as AnyPropertySchema
    expect(isEmptyValue([], undefined)).toBe(true)
    expect(isEmptyValue([], atomic)).toBe(false)
    expect(isEmptyValue(null, atomic)).toBe(true)
  })
})
