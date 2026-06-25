import { describe, expect, it } from 'vitest'
import {
  BINARY_ENVELOPE_MAGIC,
  BINARY_MAGIC_BYTES,
  decodeBinaryEnvelope,
  encodeBinaryEnvelope,
  hasBinaryEnvelopeMagic,
} from './binaryEnvelope.js'
import { GCM_TAG_BYTES, NONCE_BYTES } from './envelope.js'

const filled = (len: number, value: number) => new Uint8Array(len).fill(value)
const utf8 = (s: string) => new TextEncoder().encode(s)

/** A raw blob carrying the magic + a payload of exactly `payloadLen` bytes. */
const blobWithPayloadLen = (payloadLen: number) => {
  const blob = new Uint8Array(BINARY_MAGIC_BYTES + payloadLen)
  blob.set(BINARY_ENVELOPE_MAGIC, 0)
  return blob
}

describe('encb:v1: binary envelope', () => {
  it('round-trips nonce and ciphertext as raw bytes', () => {
    const nonce = filled(NONCE_BYTES, 0x11)
    const ciphertext = filled(GCM_TAG_BYTES + 5, 0x22)
    const envelope = encodeBinaryEnvelope(nonce, ciphertext)
    expect(hasBinaryEnvelopeMagic(envelope)).toBe(true)
    const decoded = decodeBinaryEnvelope(envelope)
    expect(Uint8Array.from(decoded.nonce)).toEqual(nonce)
    expect(Uint8Array.from(decoded.ciphertext)).toEqual(ciphertext)
  })

  it('frames raw bytes, not base64 text (magic is the literal encb:v1: ASCII)', () => {
    expect(Array.from(BINARY_ENVELOPE_MAGIC)).toEqual(Array.from(utf8('encb:v1:')))
    const envelope = encodeBinaryEnvelope(filled(NONCE_BYTES, 0), filled(GCM_TAG_BYTES, 0))
    expect(Array.from(envelope.subarray(0, BINARY_MAGIC_BYTES))).toEqual(Array.from(BINARY_ENVELOPE_MAGIC))
  })

  it('preserves arbitrary non-UTF-8 byte values (0x00..0xff)', () => {
    const nonce = filled(NONCE_BYTES, 0x80)
    const ciphertext = new Uint8Array(256 + GCM_TAG_BYTES)
    for (let i = 0; i < 256; i++) ciphertext[i] = i
    const decoded = decodeBinaryEnvelope(encodeBinaryEnvelope(nonce, ciphertext))
    expect(Uint8Array.from(decoded.ciphertext)).toEqual(ciphertext)
  })

  it('rejects a wrong-length nonce on encode', () => {
    expect(() => encodeBinaryEnvelope(filled(NONCE_BYTES - 1, 0), filled(GCM_TAG_BYTES, 0)))
      .toThrow(/nonce must be/)
  })

  it('requires the encb:v1: magic on decode (rejects the text enc:v1: prefix)', () => {
    expect(() => decodeBinaryEnvelope(utf8('enc:v1:not-binary'))).toThrow(/magic/)
  })

  it('rejects a payload too short to hold a nonce and tag', () => {
    const tooShort = encodeBinaryEnvelope(filled(NONCE_BYTES, 0), filled(GCM_TAG_BYTES - 1, 0))
    expect(() => decodeBinaryEnvelope(tooShort)).toThrow(/too short/)
  })

  it('pins the nonce+tag floor: rejects every payload below it, accepts it exactly', () => {
    // The floor is the smallest legal payload: a nonce plus a bare GCM tag
    // (what empty plaintext seals to). This brackets the `< floor` check so a
    // future `<= floor` regression — which would quarantine every empty asset
    // on download — fails here. Mirrors envelope.test.ts.
    const floor = NONCE_BYTES + GCM_TAG_BYTES
    for (let payloadLen = 0; payloadLen < floor; payloadLen++) {
      expect(
        () => decodeBinaryEnvelope(blobWithPayloadLen(payloadLen)),
        `payload of ${payloadLen} bytes must be rejected`,
      ).toThrow(/too short/)
    }
    const decoded = decodeBinaryEnvelope(blobWithPayloadLen(floor))
    expect(decoded.nonce.length).toBe(NONCE_BYTES)
    expect(decoded.ciphertext.length).toBe(GCM_TAG_BYTES)
  })

  it('hasBinaryEnvelopeMagic is a pure prefix check, not a decode', () => {
    expect(hasBinaryEnvelopeMagic(utf8('encb:v1:anything'))).toBe(true)
    expect(hasBinaryEnvelopeMagic(utf8('nope'))).toBe(false)
    expect(hasBinaryEnvelopeMagic(new Uint8Array(3))).toBe(false) // shorter than the magic
  })
})
