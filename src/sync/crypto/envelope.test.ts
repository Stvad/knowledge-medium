import { describe, expect, it } from 'vitest'
import { bytesToBase64Url } from './base64url.js'
import {
  ENVELOPE_PREFIX,
  GCM_TAG_BYTES,
  NONCE_BYTES,
  decodeEnvelope,
  encodeEnvelope,
  hasEnvelopePrefix,
} from './envelope.js'

const filled = (len: number, value: number) => new Uint8Array(len).fill(value)

/** Envelope whose decoded payload is exactly `payloadLen` bytes. */
const envelopeWithPayloadLen = (payloadLen: number) =>
  ENVELOPE_PREFIX + bytesToBase64Url(filled(payloadLen, 0))

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

  it('pins the nonce+tag floor: rejects every payload below it, accepts it exactly', () => {
    // The floor is the smallest legal payload: a nonce plus a bare GCM tag
    // (what the empty plaintext seals to). Walk every truncated length in
    // [0, floor) and assert rejection, then assert the floor itself decodes.
    // This brackets the `< floor` check so a future `<= floor` regression —
    // which would quarantine every empty block on download — fails here.
    const floor = NONCE_BYTES + GCM_TAG_BYTES
    for (let payloadLen = 0; payloadLen < floor; payloadLen++) {
      expect(
        () => decodeEnvelope(envelopeWithPayloadLen(payloadLen)),
        `payload of ${payloadLen} bytes must be rejected`,
      ).toThrow(/too short/)
    }
    const decoded = decodeEnvelope(envelopeWithPayloadLen(floor))
    expect(decoded.nonce.length).toBe(NONCE_BYTES)
    expect(decoded.ciphertext.length).toBe(GCM_TAG_BYTES)
  })

  it('hasEnvelopePrefix is a pure prefix check, not a decode', () => {
    expect(hasEnvelopePrefix('enc:v1:not-valid-base64!')).toBe(true)
    expect(hasEnvelopePrefix('nope')).toBe(false)
  })
})
