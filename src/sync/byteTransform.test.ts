import { describe, expect, it } from 'vitest'
import { decodeBytes, encodeBytes } from './byteTransform.js'
import { hasBinaryEnvelopeMagic } from './crypto/binaryEnvelope.js'
import { computeContentHash, verifyContentHash } from './crypto/contentHash.js'
import { importWorkspaceKey } from './crypto/workspaceKey.js'
import type { GetCek } from './transform.js'

const cekFrom = (fill: number): GetCek => {
  const keyPromise = importWorkspaceKey(new Uint8Array(32).fill(fill))
  return async () => keyPromise
}
const noKey: GetCek = async () => null

const sampleBytes = () => {
  const b = new Uint8Array(64)
  for (let i = 0; i < b.length; i++) b[i] = (i * 7) & 0xff
  return b
}

describe('byte transform (encodeBytes / decodeBytes)', () => {
  describe('plaintext (mode "none") is the identity case', () => {
    it('encode and decode pass bytes through unchanged, needing no key', async () => {
      const bytes = sampleBytes()
      const ref = { contentHash: await computeContentHash(bytes), workspaceId: 'ws-A' }
      const encoded = await encodeBytes(bytes, 'none', noKey, ref)
      expect(encoded).toBe(bytes) // identity: the same reference, no copy
      expect(hasBinaryEnvelopeMagic(encoded)).toBe(false) // not framed/encrypted
      const decoded = await decodeBytes(encoded, 'none', noKey, ref)
      expect(Uint8Array.from(decoded)).toEqual(bytes)
    })
  })

  describe('e2ee round-trip', () => {
    it('seals to an encb:v1: envelope and opens back to the original bytes', async () => {
      const getCek = cekFrom(0x01)
      const bytes = sampleBytes()
      const ref = { contentHash: await computeContentHash(bytes), workspaceId: 'ws-A' }
      const sealed = await encodeBytes(bytes, 'e2ee', getCek, ref)
      expect(hasBinaryEnvelopeMagic(sealed)).toBe(true)
      expect(Uint8Array.from(sealed)).not.toEqual(bytes) // actually encrypted
      const opened = await decodeBytes(sealed, 'e2ee', getCek, ref)
      expect(Uint8Array.from(opened)).toEqual(bytes)
      expect(await verifyContentHash(opened, ref.contentHash)).toBe(true)
    })

    it('throws when the workspace key is unavailable (fail-closed, never plaintext)', async () => {
      const bytes = sampleBytes()
      const ref = { contentHash: await computeContentHash(bytes), workspaceId: 'ws-A' }
      await expect(encodeBytes(bytes, 'e2ee', noKey, ref)).rejects.toThrow(/no workspace key/)
      const sealed = await encodeBytes(bytes, 'e2ee', cekFrom(0x01), ref)
      await expect(decodeBytes(sealed, 'e2ee', noKey, ref)).rejects.toThrow(/no workspace key/)
    })
  })

  describe('tamper / swap (e2ee): the AAD content-hash binding blocks substitution', () => {
    it('rejects bytes sealed for a different content hash (cross-content swap)', async () => {
      const getCek = cekFrom(0x01)
      const bytesA = sampleBytes()
      const refA = { contentHash: await computeContentHash(bytesA), workspaceId: 'ws-A' }
      const sealed = await encodeBytes(bytesA, 'e2ee', getCek, refA)
      // Server returns this object for a DIFFERENT block's content key.
      const refOther = { contentHash: `sha256:${'0'.repeat(64)}`, workspaceId: 'ws-A' }
      await expect(decodeBytes(sealed, 'e2ee', getCek, refOther)).rejects.toThrow()
    })

    it('rejects bytes rebound to another workspace', async () => {
      const getCek = cekFrom(0x01)
      const bytes = sampleBytes()
      const contentHash = await computeContentHash(bytes)
      const sealed = await encodeBytes(bytes, 'e2ee', getCek, { contentHash, workspaceId: 'ws-A' })
      await expect(
        decodeBytes(sealed, 'e2ee', getCek, { contentHash, workspaceId: 'ws-B' }),
      ).rejects.toThrow()
    })
  })

  describe('stale / poisoned bytes: the read-side hash check is the load-bearing gate', () => {
    it('e2ee — bytes that decrypt cleanly under the right AAD but do not match the hash fail verifyContentHash', async () => {
      // A poisoner who knows content hash H seals GARBAGE under the correct
      // (H, ws) AAD. GCM-open SUCCEEDS (the AAD matches), so the envelope check
      // can't catch it — only the read-side sha256 verify against the block's
      // hash does (§5.1 / §10.1 first-write-wins poisoning → §17).
      const getCek = cekFrom(0x01)
      const honestHash = await computeContentHash(sampleBytes())
      const garbage = new Uint8Array(64).fill(0xab)
      const poisoned = await encodeBytes(garbage, 'e2ee', getCek, {
        contentHash: honestHash, // poisoner targets the honest path's AAD
        workspaceId: 'ws-A',
      })
      const opened = await decodeBytes(poisoned, 'e2ee', getCek, {
        contentHash: honestHash,
        workspaceId: 'ws-A',
      })
      expect(Uint8Array.from(opened)).toEqual(garbage) // decrypts fine...
      expect(await verifyContentHash(opened, honestHash)).toBe(false) // ...but fails the hash gate
    })

    it('plaintext — stale/substituted bytes for a content path are caught by verifyContentHash', async () => {
      // Plaintext mode has no AAD/GCM, so the read-side hash check is the ONLY
      // integrity gate. A server returning different raw bytes for a content
      // path must not pass.
      const expectedHash = await computeContentHash(sampleBytes())
      const stale = new Uint8Array(64).fill(0x99)
      const decoded = await decodeBytes(stale, 'none', noKey, {
        contentHash: expectedHash,
        workspaceId: 'ws-A',
      })
      expect(await verifyContentHash(decoded, expectedHash)).toBe(false)
    })
  })
})
