import { describe, expect, it } from 'vitest'
import {
  ENVELOPE_PREFIX,
  GCM_TAG_BYTES,
  NONCE_BYTES,
  decodeEnvelope,
  encodeEnvelope,
  hasEnvelopePrefix,
} from './envelope.js'

const filled = (len: number, value: number) => new Uint8Array(len).fill(value)

describe('enc:v1: envelope', () => {
  it('round-trips nonce and ciphertext', () => {
    const nonce = filled(NONCE_BYTES, 0x11)
    const ciphertext = filled(GCM_TAG_BYTES + 5, 0x22)
    const envelope = encodeEnvelope(nonce, ciphertext)
    expect(envelope.startsWith(ENVELOPE_PREFIX)).toBe(true)
    const decoded = decodeEnvelope(envelope)
    expect(Uint8Array.from(decoded.nonce)).toEqual(nonce)
    expect(Uint8Array.from(decoded.ciphertext)).toEqual(ciphertext)
  })

  it('rejects a wrong-length nonce on encode', () => {
    expect(() => encodeEnvelope(filled(NONCE_BYTES - 1, 0), filled(GCM_TAG_BYTES, 0)))
      .toThrow(/nonce must be/)
  })

  it('requires the enc:v1: prefix on decode', () => {
    expect(() => decodeEnvelope('plaintext value')).toThrow(/prefix/)
  })

  it('rejects a payload too short to hold a nonce and tag', () => {
    const tooShort = encodeEnvelope(filled(NONCE_BYTES, 0), filled(GCM_TAG_BYTES - 1, 0))
    expect(() => decodeEnvelope(tooShort)).toThrow(/too short/)
  })

  it('hasEnvelopePrefix is a pure prefix check, not a decode', () => {
    expect(hasEnvelopePrefix('enc:v1:not-valid-base64!')).toBe(true)
    expect(hasEnvelopePrefix('nope')).toBe(false)
  })
})
