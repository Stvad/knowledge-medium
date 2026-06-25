import { describe, expect, it } from 'vitest'
import { bytesToHex } from './hex.js'

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
