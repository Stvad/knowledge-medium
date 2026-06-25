import { describe, expect, it } from 'vitest'
import { computeContentHash, sha256, verifyContentHash } from './contentHash.js'

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
})
