import { describe, expect, it } from 'vitest'
import { encodeBytes } from '../byteTransform.js'
import type { GetCek } from '../transform.js'
import { BINARY_ENVELOPE_MAGIC } from './binaryEnvelope.js'
import { computeContentHash, digestFromContentHash } from './contentHash.js'
import {
  classifyStoredObject,
  CONTENT_KEY_HKDF_INFO,
  deriveContentKey,
  deriveContentKeyHmac,
  indexKeyedNames,
} from './contentKey.js'
import { bytesToHex } from './hex.js'
import { importWorkspaceKey } from './workspaceKey.js'

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

describe('classifyStoredObject (the cleaner\'s one rule, by content)', () => {
  const WS = 'ws-A'
  const cek = (fill: number): GetCek => {
    const key = importWorkspaceKey(wkBytes(fill))
    return async () => key
  }
  const rawName = async (bytes: Uint8Array<ArrayBuffer>) =>
    deriveContentKey({contentHash: await computeContentHash(bytes), mode: 'none', contentKeyHmac: null})

  /** A workspace keyed with WK fill 7, knowing the hashes of `known`. */
  const workspace = async (...known: Uint8Array<ArrayBuffer>[]) => {
    const hmac = await deriveContentKeyHmac(wkBytes(7))
    const names = await indexKeyedNames(await Promise.all(known.map(b => computeContentHash(b))), hmac)
    const keyedName = async (bytes: Uint8Array<ArrayBuffer>) =>
      deriveContentKey({contentHash: await computeContentHash(bytes), mode: 'e2ee', contentKeyHmac: hmac})
    const seal = async (bytes: Uint8Array<ArrayBuffer>, getCek = cek(7)) =>
      encodeBytes(bytes, 'e2ee', getCek, {contentHash: await computeContentHash(bytes), workspaceId: WS})
    return {keyed: {names, getCek: cek(7)}, keyedName, seal}
  }

  it('raw: bytes under the hex of their own sha256', async () => {
    const bytes = utf8('a photo')
    const {keyed} = await workspace()
    expect(await classifyStoredObject({workspaceId: WS, name: await rawName(bytes), bytes, keyed})).toEqual({
      kind: 'raw',
      contentHash: await computeContentHash(bytes),
    })
  })

  it('a plaintext file that begins with encb:v1: is still raw, by content', async () => {
    const bytes = new Uint8Array([...BINARY_ENVELOPE_MAGIC, ...new Uint8Array(64).fill(3)])
    const {keyed} = await workspace(bytes)
    const result = await classifyStoredObject({workspaceId: WS, name: await rawName(bytes), bytes, keyed})
    expect(result.kind).toBe('raw')
  })

  it('keyed: a sealed object at the keyed name of a hash the caller knows', async () => {
    const plain = utf8('a photo')
    const {keyed, keyedName, seal} = await workspace(plain)
    const name = await keyedName(plain)
    expect(await classifyStoredObject({workspaceId: WS, name, bytes: await seal(plain), keyed})).toEqual({
      kind: 'keyed',
      contentHash: await computeContentHash(plain),
    })
  })

  it('neither: a sealed object whose hash the caller does not know (the AAD needs it to open)', async () => {
    const plain = utf8('a photo')
    const {keyed, keyedName, seal} = await workspace()
    const name = await keyedName(plain)
    expect(await classifyStoredObject({workspaceId: WS, name, bytes: await seal(plain), keyed})).toEqual({kind: 'neither'})
  })

  it('neither: at a known keyed name, a wrong-key copy, a poisoned seal, corrupt bytes, or the raw plaintext', async () => {
    const plain = utf8('a photo')
    const {keyed, keyedName, seal} = await workspace(plain)
    const name = await keyedName(plain)
    const wrongKey = await seal(plain, cek(8))
    const poisoned = await encodeBytes(utf8('junk'), 'e2ee', cek(7), {
      contentHash: await computeContentHash(plain),
      workspaceId: WS,
    })
    const corrupt = await seal(plain)
    corrupt[corrupt.length - 1] ^= 1
    for (const bytes of [wrongKey, poisoned, corrupt, plain]) {
      expect(await classifyStoredObject({workspaceId: WS, name, bytes, keyed})).toEqual({kind: 'neither'})
    }
  })

  it('neither: bytes under a raw-shaped name that is not their own hash', async () => {
    const {keyed} = await workspace()
    const name = await rawName(utf8('the original'))
    expect(await classifyStoredObject({workspaceId: WS, name, bytes: utf8('truncated'), keyed})).toEqual({
      kind: 'neither',
    })
  })

  it('without a key nothing is keyed: a genuine sealed object is neither', async () => {
    const plain = utf8('a photo')
    const {keyedName, seal} = await workspace(plain)
    const name = await keyedName(plain)
    expect(await classifyStoredObject({workspaceId: WS, name, bytes: await seal(plain), keyed: null})).toEqual({
      kind: 'neither',
    })
  })

  it('indexKeyedNames skips a malformed hash instead of throwing', async () => {
    const hmac = await deriveContentKeyHmac(wkBytes(7))
    const names = await indexKeyedNames(['not-a-hash', await HASH_ABC()], hmac)
    expect([...names.hashByName.values()]).toEqual([await HASH_ABC()])
  })
})
