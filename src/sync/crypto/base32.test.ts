import { describe, expect, it } from 'vitest'
import { base32ToBytes, bytesToBase32 } from './base32.js'

describe('base32', () => {
  it('round-trips arbitrary byte lengths', () => {
    for (let len = 0; len <= 40; len++) {
      const input = new Uint8Array(len)
      for (let i = 0; i < len; i++) input[i] = (i * 53 + 7) & 0xff
      expect(base32ToBytes(bytesToBase32(input))).toEqual(input)
    }
  })

  it('encodes 32 bytes to 52 unpadded chars (the WK length, §5)', () => {
    const key = new Uint8Array(32).fill(0xa5)
    const encoded = bytesToBase32(key)
    expect(encoded).toHaveLength(52)
    expect(encoded).not.toContain('=')
  })

  it('decodes case-insensitively', () => {
    const input = Uint8Array.from([0xde, 0xad, 0xbe, 0xef])
    const upper = bytesToBase32(input)
    expect(base32ToBytes(upper.toLowerCase())).toEqual(input)
  })

  it('rejects characters outside the alphabet', () => {
    // 0, 1, 8, 9 are not in the RFC 4648 base32 alphabet.
    expect(() => base32ToBytes('AAAA0')).toThrow(/invalid character/)
  })
})
