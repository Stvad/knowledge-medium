import { describe, expect, it } from 'vitest'
import { encodeBytes, verifyObjectBytes } from './byteTransform.js'
import { BINARY_ENVELOPE_OVERHEAD_BYTES, hasBinaryEnvelopeMagic } from './crypto/binaryEnvelope.js'
import { computeContentHash } from './crypto/contentHash.js'
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

describe('byte transform (encodeBytes / verifyObjectBytes)', () => {
  describe('plaintext (mode "none") is the identity case', () => {
    it('encode passes bytes through unchanged, and they verify, needing no key', async () => {
      const bytes = sampleBytes()
      const ref = { contentHash: await computeContentHash(bytes), workspaceId: 'ws-A' }
      const encoded = await encodeBytes(bytes, 'none', noKey, ref)
      expect(encoded).toBe(bytes) // identity: the same reference, no copy
      expect(hasBinaryEnvelopeMagic(encoded)).toBe(false) // not framed/encrypted
      const verified = await verifyObjectBytes(encoded, 'none', noKey, ref)
      expect(verified.ok && Uint8Array.from(verified.plaintext)).toEqual(bytes)
    })
  })

  describe('e2ee round-trip', () => {
    it('seals to an encb:v1: envelope that opens and verifies back to the original bytes', async () => {
      const getCek = cekFrom(0x01)
      const bytes = sampleBytes()
      const ref = { contentHash: await computeContentHash(bytes), workspaceId: 'ws-A' }
      const sealed = await encodeBytes(bytes, 'e2ee', getCek, ref)
      expect(hasBinaryEnvelopeMagic(sealed)).toBe(true)
      expect(Uint8Array.from(sealed)).not.toEqual(bytes) // actually encrypted
      expect(sealed.length).toBe(bytes.length + BINARY_ENVELOPE_OVERHEAD_BYTES)
      const verified = await verifyObjectBytes(sealed, 'e2ee', getCek, ref)
      expect(verified.ok && Uint8Array.from(verified.plaintext)).toEqual(bytes)
    })

    it('round-trips a 1 MiB buffer (multi-block GCM at realistic media size)', async () => {
      // Every other test here is <=64 bytes; the feature's real payloads are
      // multi-MB images/PDFs. Exercise seal/open/envelope over a realistic,
      // non-uniform buffer to catch any chunking/offset assumption.
      const getCek = cekFrom(0x01)
      const bytes = new Uint8Array(1 << 20)
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761) & 0xff
      const ref = { contentHash: await computeContentHash(bytes), workspaceId: 'ws-A' }
      const sealed = await encodeBytes(bytes, 'e2ee', getCek, ref)
      const verified = await verifyObjectBytes(sealed, 'e2ee', getCek, ref)
      expect(verified.ok && Uint8Array.from(verified.plaintext)).toEqual(bytes)
      // Heavy by design (1 MiB fill + seal/open + a 1 MiB deep-equal); give it
      // headroom so a contended CI runner doesn't trip the 5s default timeout.
    }, 30_000)

    it('fails closed when the workspace key is unavailable: no seal, and nothing verifies', async () => {
      const bytes = sampleBytes()
      const ref = { contentHash: await computeContentHash(bytes), workspaceId: 'ws-A' }
      await expect(encodeBytes(bytes, 'e2ee', noKey, ref)).rejects.toThrow(/no workspace key/)
      const sealed = await encodeBytes(bytes, 'e2ee', cekFrom(0x01), ref)
      expect(await verifyObjectBytes(sealed, 'e2ee', noKey, ref)).toEqual({ ok: false, reason: 'decode-failed' })
    })
  })

  describe('decode-failed: an object that does not open', () => {
    it('under a wrong key, or bytes that are not an envelope', async () => {
      const bytes = sampleBytes()
      const ref = { contentHash: await computeContentHash(bytes), workspaceId: 'ws-A' }
      const sealed = await encodeBytes(bytes, 'e2ee', cekFrom(0x01), ref)
      expect(await verifyObjectBytes(sealed, 'e2ee', cekFrom(0x02), ref)).toEqual({ ok: false, reason: 'decode-failed' })
      expect(await verifyObjectBytes(bytes, 'e2ee', cekFrom(0x01), ref)).toEqual({ ok: false, reason: 'decode-failed' })
    })

    it('sealed for a different content hash: the AAD binding blocks a cross-content swap', async () => {
      const getCek = cekFrom(0x01)
      const bytesA = sampleBytes()
      const sealed = await encodeBytes(bytesA, 'e2ee', getCek, {
        contentHash: await computeContentHash(bytesA),
        workspaceId: 'ws-A',
      })
      // Server returns this object for a DIFFERENT block's content key.
      const refOther = { contentHash: `sha256:${'0'.repeat(64)}`, workspaceId: 'ws-A' }
      expect(await verifyObjectBytes(sealed, 'e2ee', getCek, refOther)).toEqual({ ok: false, reason: 'decode-failed' })
    })

    it('rebound to another workspace', async () => {
      const getCek = cekFrom(0x01)
      const bytes = sampleBytes()
      const contentHash = await computeContentHash(bytes)
      const sealed = await encodeBytes(bytes, 'e2ee', getCek, { contentHash, workspaceId: 'ws-A' })
      expect(await verifyObjectBytes(sealed, 'e2ee', getCek, { contentHash, workspaceId: 'ws-B' })).toEqual({
        ok: false,
        reason: 'decode-failed',
      })
    })
  })

  describe('hash-mismatch: stale / poisoned bytes, the load-bearing gate', () => {
    it('e2ee — bytes that open cleanly under the right AAD but do not match the hash', async () => {
      // A poisoner who knows content hash H seals GARBAGE under the correct
      // (H, ws) AAD. GCM-open SUCCEEDS (the AAD matches), so the envelope check
      // can't catch it — only the sha256 check against the block's hash does
      // (§5.1 / §10.1 first-write-wins poisoning → §17).
      const getCek = cekFrom(0x01)
      const ref = { contentHash: await computeContentHash(sampleBytes()), workspaceId: 'ws-A' }
      const poisoned = await encodeBytes(new Uint8Array(64).fill(0xab), 'e2ee', getCek, ref)
      expect(await verifyObjectBytes(poisoned, 'e2ee', getCek, ref)).toEqual({ ok: false, reason: 'hash-mismatch' })
    })

    it('plaintext — substituted bytes for a content path', async () => {
      // Plaintext mode has no AAD/GCM, so the hash check is the ONLY integrity
      // gate. A server returning different raw bytes for a content path must not pass.
      const ref = { contentHash: await computeContentHash(sampleBytes()), workspaceId: 'ws-A' }
      expect(await verifyObjectBytes(new Uint8Array(64).fill(0x99), 'none', noKey, ref)).toEqual({
        ok: false,
        reason: 'hash-mismatch',
      })
    })
  })
})
