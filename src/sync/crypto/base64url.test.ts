import { describe, expect, it } from 'vitest'
import { base64UrlToBytes, bytesToBase64Url } from './base64url.js'

const bytes = (...values: number[]) => Uint8Array.from(values)

describe('base64url', () => {
  it('round-trips arbitrary byte lengths', () => {
    for (let len = 0; len <= 40; len++) {
      const input = new Uint8Array(len)
      for (let i = 0; i < len; i++) input[i] = (i * 37 + 13) & 0xff
      const encoded = bytesToBase64Url(input)
      expect(base64UrlToBytes(encoded)).toEqual(input)
    }
  })

  it('uses the URL-safe alphabet without padding', () => {
    // 0xFB 0xFF 0xFE -> would be "+//+" in standard base64; URL-safe is "-__-".
    const encoded = bytesToBase64Url(bytes(0xfb, 0xff, 0xfe))
    expect(encoded).not.toMatch(/[+/=]/)
    expect(encoded).toBe('-__-')
  })

  it('encodes the empty array to the empty string', () => {
    expect(bytesToBase64Url(bytes())).toBe('')
    expect(base64UrlToBytes('')).toEqual(bytes())
  })

  it('rejects an impossible single-char trailing group', () => {
    // len % 4 === 1 can never be produced by a real base64 encoding.
    expect(() => base64UrlToBytes('AAAAA')).toThrow(/invalid input/)
  })

  it('rejects characters outside the URL-safe alphabet (incl. + / =)', () => {
    expect(() => base64UrlToBytes('AA+A')).toThrow(/invalid input/)
    expect(() => base64UrlToBytes('AA=A')).toThrow(/invalid input/)
  })
})
