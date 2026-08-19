import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from './hex.js'

describe('bytesToHex', () => {
  it('encodes bytes as lowercase, zero-padded hex', () => {
    expect(bytesToHex(new Uint8Array([0x00, 0x0f, 0xa0, 0xff]))).toBe('000fa0ff')
  })

  it('encodes the empty array as the empty string', () => {
    expect(bytesToHex(new Uint8Array([]))).toBe('')
  })

  it('emits exactly two chars per byte (no dropped leading nibble)', () => {
    expect(bytesToHex(new Uint8Array([1, 2, 3]))).toBe('010203')
  })
})

describe('hexToBytes', () => {
  it('round-trips bytesToHex over a 256-value sweep', () => {
    const all = new Uint8Array(256).map((_, i) => i)
    expect(hexToBytes(bytesToHex(all))).toEqual(all)
  })

  it('decodes the empty string to an empty array', () => {
    expect(hexToBytes('')).toEqual(new Uint8Array(0))
  })

  it('accepts upper- and mixed-case hex', () => {
    expect(hexToBytes('A0fF')).toEqual(new Uint8Array([0xa0, 0xff]))
  })

  it('throws on an odd-length string', () => {
    expect(() => hexToBytes('abc')).toThrow(/odd-length/)
  })

  it('throws on non-hex characters (no silent parseInt truncation)', () => {
    // parseInt('zz', 16) is NaN and parseInt('1z', 16) is 1 — both must reject,
    // not coerce, or a malformed stored hash would route to a bogus path.
    expect(() => hexToBytes('zz')).toThrow(/non-hex/)
    expect(() => hexToBytes('1z')).toThrow(/non-hex/)
    expect(() => hexToBytes('0g')).toThrow(/non-hex/)
  })
})
