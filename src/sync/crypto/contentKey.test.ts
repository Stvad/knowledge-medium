import { describe, expect, it } from 'vitest'
import { computeContentHash, digestFromContentHash } from './contentHash.js'
import { CONTENT_KEY_HKDF_INFO, deriveContentKey, deriveContentKeyHmac } from './contentKey.js'
import { bytesToHex } from './hex.js'

const utf8 = (s: string) => new TextEncoder().encode(s)
const wkBytes = (fill: number) => new Uint8Array(32).fill(fill)
const HASH_ABC = () => computeContentHash(utf8('abc'))
const HASH_XYZ = () => computeContentHash(utf8('xyz'))

describe('deriveContentKeyHmac (K_id)', () => {
  it('is deterministic — the same WK bytes derive a key with the same MAC output', async () => {
    const digest = digestFromContentHash(await HASH_ABC())
    const a = await deriveContentKeyHmac(wkBytes(7))
    const b = await deriveContentKeyHmac(wkBytes(7))
    const macA = new Uint8Array(await crypto.subtle.sign('HMAC', a, digest))
    const macB = new Uint8Array(await crypto.subtle.sign('HMAC', b, digest))
    expect(bytesToHex(macA)).toBe(bytesToHex(macB))
  })

  it('derives DIFFERENT subkeys from different WK material (cross-workspace separation)', async () => {
    const digest = digestFromContentHash(await HASH_ABC())
    const a = await deriveContentKeyHmac(wkBytes(7))
    const b = await deriveContentKeyHmac(wkBytes(8))
    const macA = new Uint8Array(await crypto.subtle.sign('HMAC', a, digest))
    const macB = new Uint8Array(await crypto.subtle.sign('HMAC', b, digest))
    expect(bytesToHex(macA)).not.toBe(bytesToHex(macB))
  })

  it('is non-extractable (the subkey bytes can never be read back out)', async () => {
    const k = await deriveContentKeyHmac(wkBytes(7))
    await expect(crypto.subtle.exportKey('raw', k)).rejects.toThrow()
  })

  it('binds the version label that domain-separates this derivation', () => {
    expect(CONTENT_KEY_HKDF_INFO).toBe('km/asset-content-key/v1')
  })
})

describe('deriveContentKey (the §10 object-path segment)', () => {
  it('plaintext mode → the raw sha256 hex (the server already holds these bytes)', async () => {
    const contentHash = await HASH_ABC()
    const key = await deriveContentKey({ contentHash, mode: 'none', contentKeyHmac: null })
    expect(key).toBe(bytesToHex(digestFromContentHash(contentHash)))
  })

  it('e2ee mode → a keyed hash that is NOT the raw sha256 (no content oracle)', async () => {
    const contentHash = await HASH_ABC()
    const hmac = await deriveContentKeyHmac(wkBytes(7))
    const key = await deriveContentKey({ contentHash, mode: 'e2ee', contentKeyHmac: hmac })
    expect(key).not.toBe(bytesToHex(digestFromContentHash(contentHash)))
  })

  it('e2ee path is full-length (64 hex chars / 32 bytes — never truncated)', async () => {
    const hmac = await deriveContentKeyHmac(wkBytes(7))
    const key = await deriveContentKey({ contentHash: await HASH_ABC(), mode: 'e2ee', contentKeyHmac: hmac })
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it('e2ee matches a frozen known-answer vector (locks the HKDF salt + info label)', async () => {
    // WK = 32×0x07, content = sha256("abc"), info = 'km/asset-content-key/v1',
    // empty salt. A silent change to salt/info would shift EVERY path uniformly —
    // determinism/distinctness wouldn't catch it, this golden vector does.
    const hmac = await deriveContentKeyHmac(wkBytes(7))
    const key = await deriveContentKey({ contentHash: await HASH_ABC(), mode: 'e2ee', contentKeyHmac: hmac })
    expect(key).toBe('7fd7b282a04cce93685f9b304bb45a949c56e743a29ed5764ed283075b2c9d23')
  })

  it('e2ee is deterministic for one workspace (idempotent uploads / dedup)', async () => {
    const contentHash = await HASH_ABC()
    const hmac = await deriveContentKeyHmac(wkBytes(7))
    const k1 = await deriveContentKey({ contentHash, mode: 'e2ee', contentKeyHmac: hmac })
    const k2 = await deriveContentKey({ contentHash, mode: 'e2ee', contentKeyHmac: hmac })
    expect(k1).toBe(k2)
  })

  it('e2ee separates across workspaces (different K_id → different path for the same bytes)', async () => {
    const contentHash = await HASH_ABC()
    const k1 = await deriveContentKey({ contentHash, mode: 'e2ee', contentKeyHmac: await deriveContentKeyHmac(wkBytes(7)) })
    const k2 = await deriveContentKey({ contentHash, mode: 'e2ee', contentKeyHmac: await deriveContentKeyHmac(wkBytes(8)) })
    expect(k1).not.toBe(k2)
  })

  it('separates across content (different bytes → different path within a workspace)', async () => {
    const hmac = await deriveContentKeyHmac(wkBytes(7))
    const kAbc = await deriveContentKey({ contentHash: await HASH_ABC(), mode: 'e2ee', contentKeyHmac: hmac })
    const kXyz = await deriveContentKey({ contentHash: await HASH_XYZ(), mode: 'e2ee', contentKeyHmac: hmac })
    expect(kAbc).not.toBe(kXyz)
  })

  it('fails closed: an e2ee derivation with no K_id throws (the §10 re-paste migration)', async () => {
    await expect(
      deriveContentKey({ contentHash: await HASH_ABC(), mode: 'e2ee', contentKeyHmac: null }),
    ).rejects.toThrow(/K_id/)
  })

  it('rejects a malformed content hash before deriving any path', async () => {
    const hmac = await deriveContentKeyHmac(wkBytes(7))
    await expect(deriveContentKey({ contentHash: 'not-a-hash', mode: 'e2ee', contentKeyHmac: hmac })).rejects.toThrow()
  })
})
