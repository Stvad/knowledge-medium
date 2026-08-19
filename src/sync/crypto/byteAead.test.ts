import { describe, expect, it } from 'vitest'
import { assetBytesAad } from './aad.js'
import { openBytes, sealBytes } from './byteAead.js'
import { hasBinaryEnvelopeMagic } from './binaryEnvelope.js'
import { importWorkspaceKey } from './workspaceKey.js'

const keyFrom = (fill: number) => importWorkspaceKey(new Uint8Array(32).fill(fill))
const bytes = (...values: number[]) => new Uint8Array(values)

describe('AES-256-GCM sealBytes/openBytes', () => {
  it('round-trips raw bytes under matching key and AAD', async () => {
    const key = await keyFrom(0x01)
    const aad = assetBytesAad('sha256:aa', 'ws-A')
    const plaintext = bytes(0x00, 0x01, 0xfe, 0xff, 0x80)
    const sealed = await sealBytes(key, plaintext, aad)
    expect(hasBinaryEnvelopeMagic(sealed)).toBe(true)
    expect(Uint8Array.from(await openBytes(key, sealed, aad))).toEqual(plaintext)
  })

  it('round-trips empty bytes (payload sits on the nonce+tag floor)', async () => {
    const key = await keyFrom(0x01)
    const aad = assetBytesAad('sha256:e3', 'ws-A')
    const sealed = await sealBytes(key, new Uint8Array(0), aad)
    expect(Uint8Array.from(await openBytes(key, sealed, aad))).toEqual(new Uint8Array(0))
  })

  it('produces a fresh nonce per seal (distinct envelopes for identical input)', async () => {
    const key = await keyFrom(0x01)
    const aad = assetBytesAad('sha256:aa', 'ws-A')
    const a = await sealBytes(key, bytes(1, 2, 3), aad)
    const b = await sealBytes(key, bytes(1, 2, 3), aad)
    expect(Uint8Array.from(a)).not.toEqual(Uint8Array.from(b))
    expect(Uint8Array.from(await openBytes(key, b, aad))).toEqual(bytes(1, 2, 3))
  })

  it('fails to open under a different key', async () => {
    const aad = assetBytesAad('sha256:aa', 'ws-A')
    const sealed = await sealBytes(await keyFrom(0x01), bytes(1, 2, 3), aad)
    await expect(openBytes(await keyFrom(0x02), sealed, aad)).rejects.toThrow()
  })

  it('fails when the content-hash AAD differs (cross-content swap)', async () => {
    const key = await keyFrom(0x01)
    const sealed = await sealBytes(key, bytes(1, 2, 3), assetBytesAad('sha256:aa', 'ws-A'))
    await expect(openBytes(key, sealed, assetBytesAad('sha256:bb', 'ws-A'))).rejects.toThrow()
  })

  it('fails when rebound to another workspace (AAD workspace binding)', async () => {
    const key = await keyFrom(0x01)
    const sealed = await sealBytes(key, bytes(1, 2, 3), assetBytesAad('sha256:aa', 'ws-A'))
    await expect(openBytes(key, sealed, assetBytesAad('sha256:aa', 'ws-B'))).rejects.toThrow()
  })

  it('fails when the ciphertext (auth tag) is tampered', async () => {
    const key = await keyFrom(0x01)
    const aad = assetBytesAad('sha256:aa', 'ws-A')
    const sealed = await sealBytes(key, bytes(1, 2, 3), aad)
    const tampered = Uint8Array.from(sealed)
    tampered[tampered.length - 1] ^= 0x01 // flip a tag bit
    await expect(openBytes(key, tampered, aad)).rejects.toThrow()
  })
})
