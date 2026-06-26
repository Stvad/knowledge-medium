import { describe, expect, it } from 'vitest'
import {
  computeContentHash,
  digestFromContentHash,
  sha256,
  verifyContentHash,
} from './contentHash.js'

const utf8 = (s: string) => new TextEncoder().encode(s)

describe('asset content hash', () => {
  it('matches the NIST known-answer sha256("abc")', async () => {
    expect(await computeContentHash(utf8('abc'))).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('hashes empty input to the sha256 empty digest', async () => {
    expect(await computeContentHash(new Uint8Array(0))).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('sha256 returns the 32-byte raw digest (seeds the content-addressed path, §10)', async () => {
    expect((await sha256(utf8('abc'))).length).toBe(32)
  })

  it('verifyContentHash accepts a match and rejects a single-byte mismatch', async () => {
    const data = utf8('payload')
    const good = await computeContentHash(data)
    expect(await verifyContentHash(data, good)).toBe(true)
    // A single flipped byte must not verify — this is the read-side tamper /
    // stale-replay gate (§5.1).
    const tampered = Uint8Array.from(data)
    tampered[0] ^= 0x01
    expect(await verifyContentHash(tampered, good)).toBe(false)
  })

  it('digestFromContentHash recovers the raw digest sha256() produced', async () => {
    const data = utf8('abc')
    const expected = await sha256(data)
    expect(digestFromContentHash(await computeContentHash(data))).toEqual(expected)
  })

  it('digestFromContentHash rejects a missing prefix, wrong prefix, or wrong length', () => {
    const hex = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    expect(() => digestFromContentHash(hex)).toThrow(/prefix/) // bare hex, no tag
    expect(() => digestFromContentHash(`sha1:${hex}`)).toThrow(/prefix/)
    expect(() => digestFromContentHash('sha256:dead')).toThrow(/32-byte/) // too short
  })

  it('digestFromContentHash rejects non-lowercase hex (canonical form only, matches verify)', () => {
    // hexToBytes itself is case-insensitive, but the content hash is canonical
    // lowercase; an uppercase one would derive a valid path then spuriously fail
    // the case-sensitive read-side hash check, so reject it at the source.
    const upper = 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD'
    expect(() => digestFromContentHash(`sha256:${upper}`)).toThrow(/lowercase/)
  })
})
