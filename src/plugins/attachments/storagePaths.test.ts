import { describe, expect, it } from 'vitest'
import { attachmentObjectPath, authenticatedObjectUrl, deriveObjectKey } from './storagePaths.js'
import { computeContentHash } from '@/sync/crypto/contentHash.js'
import { deriveContentKey, deriveContentKeyHmac } from '@/sync/crypto/contentKey.js'

describe('attachmentObjectPath', () => {
  it('is the flat <workspaceId>/<contentKey> layout', () => {
    expect(attachmentObjectPath('ws-1', 'deadbeef')).toBe('ws-1/deadbeef')
  })
})

describe('authenticatedObjectUrl', () => {
  it('matches the storage-js download shape — /object/<bucket>/<path>, no /authenticated/ segment', () => {
    expect(authenticatedObjectUrl('https://x.supabase.co', 'attachments', 'ws-1/deadbeef')).toBe(
      'https://x.supabase.co/storage/v1/object/attachments/ws-1/deadbeef',
    )
  })

  it('percent-encodes each path segment (preserving the slash separator)', () => {
    expect(authenticatedObjectUrl('https://x.supabase.co', 'attachments', 'ws 1/a b#c')).toBe(
      'https://x.supabase.co/storage/v1/object/attachments/ws%201/a%20b%23c',
    )
  })

  it('tolerates a trailing slash on the base url', () => {
    expect(authenticatedObjectUrl('https://x.supabase.co/', 'attachments', 'w/k')).toBe(
      'https://x.supabase.co/storage/v1/object/attachments/w/k',
    )
  })
})

describe('deriveObjectKey — the address, derived when used', () => {
  const plain = new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>
  const kidBytes = new Uint8Array(32).fill(3) as Uint8Array<ArrayBuffer>

  it('plaintext: the raw name, which is also the only local name', async () => {
    const contentHash = await computeContentHash(plain)
    const raw = contentHash.slice('sha256:'.length)
    expect(await deriveObjectKey(contentHash, 'none', async () => null))
      .toEqual({ok: true, objectKey: raw, localKeys: [raw]})
  })

  it('e2ee: the keyed name, then the raw one locally (bytes stored before a conversion)', async () => {
    const contentHash = await computeContentHash(plain)
    const kid = await deriveContentKeyHmac(kidBytes.slice())
    const keyed = await deriveContentKey({contentHash, mode: 'e2ee', contentKeyHmac: kid})
    expect(await deriveObjectKey(contentHash, 'e2ee', async () => kid))
      .toEqual({ok: true, objectKey: keyed, localKeys: [keyed, contentHash.slice('sha256:'.length)]})
  })

  it('e2ee without K_id fails closed', async () => {
    expect(await deriveObjectKey(await computeContentHash(plain), 'e2ee', async () => null))
      .toEqual({ok: false, reason: 'no-content-key'})
  })

  it('a malformed hash fails closed', async () => {
    expect(await deriveObjectKey('sha256:nothex', 'none', async () => null))
      .toEqual({ok: false, reason: 'invalid-hash'})
  })

  it('reads K_id only for an e2ee workspace', async () => {
    let reads = 0
    await deriveObjectKey(await computeContentHash(plain), 'none', async () => { reads += 1; return null })
    expect(reads).toBe(0)
  })
})
