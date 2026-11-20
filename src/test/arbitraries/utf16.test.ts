// @vitest-environment node
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { codePointUnitArb } from './utf16'

const isOneNonSurrogateCodePoint = (value: string): boolean => {
  const chars = [...value]
  const codePoint = value.codePointAt(0)
  return chars.length === 1 && codePoint !== undefined && (codePoint < 0xd800 || codePoint > 0xdfff)
}

describe('codePointUnitArb', () => {
  it('generates single code points outside the surrogate block, astral included', () => {
    const values = fc.sample(codePointUnitArb, {numRuns: 2000, seed: 1})
    expect(values.every(isOneNonSurrogateCodePoint)).toBe(true)
    expect(values.some(value => value.length === 2)).toBe(true)
  })

  // fast-check tokenizes its injected dangerous strings (`__proto__`, …) with
  // the unit's unmapper; a unit that rejects a value it could generate drops
  // those strings from every suite built on it.
  it('recognizes exactly the values it can generate', () => {
    for (const value of ['\u0000', 'a', '퟿', '', '😀', '\u{10FFFF}']) {
      expect(codePointUnitArb.canShrinkWithoutContext(value), JSON.stringify(value)).toBe(true)
    }
    for (const value of ['', 'ab', '\uD800', '\uDFFF', '😀a', 42, undefined]) {
      expect(codePointUnitArb.canShrinkWithoutContext(value), JSON.stringify(value)).toBe(false)
    }
  })

  it('keeps the dangerous strings in a string built from it', () => {
    const values = fc.sample(fc.string({unit: codePointUnitArb, maxLength: 60}), {numRuns: 5000, seed: 20260714})
    expect(values).toContain('__proto__')
  })
})
