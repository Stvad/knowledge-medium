import { describe, expect, it } from 'vitest'
import { open, seal } from './aead.js'
import { contentAad } from './aad.js'
import { ENVELOPE_PREFIX } from './envelope.js'
import { importWorkspaceKey } from './workspaceKey.js'

const keyFrom = (fill: number) => importWorkspaceKey(new Uint8Array(32).fill(fill))

describe('AES-256-GCM seal/open', () => {
  it('round-trips a string under matching key and AAD', async () => {
    const key = await keyFrom(0x01)
    const aad = contentAad('block-1', 'ws-A', 'content')
    const envelope = await seal(key, 'Hello, world 🌍', aad)
    expect(envelope.startsWith(ENVELOPE_PREFIX)).toBe(true)
    expect(await open(key, envelope, aad)).toBe('Hello, world 🌍')
  })

  it('produces a fresh nonce per seal (distinct envelopes for identical input)', async () => {
    const key = await keyFrom(0x01)
    const aad = contentAad('block-1', 'ws-A', 'content')
    const a = await seal(key, 'same', aad)
    const b = await seal(key, 'same', aad)
    expect(a).not.toBe(b)
    expect(await open(key, b, aad)).toBe('same')
  })

  it('fails to open under a different key', async () => {
    const aad = contentAad('block-1', 'ws-A', 'content')
    const envelope = await seal(await keyFrom(0x01), 'secret', aad)
    await expect(open(await keyFrom(0x02), envelope, aad)).rejects.toThrow()
  })

  it('fails when the AAD differs (column swap)', async () => {
    const key = await keyFrom(0x01)
    const envelope = await seal(key, 'secret', contentAad('block-1', 'ws-A', 'content'))
    await expect(
      open(key, envelope, contentAad('block-1', 'ws-A', 'properties_json')),
    ).rejects.toThrow()
  })

  it('fails when the ciphertext is tampered', async () => {
    const key = await keyFrom(0x01)
    const aad = contentAad('block-1', 'ws-A', 'content')
    const envelope = await seal(key, 'secret', aad)
    // Mutate the FIRST payload char (top bits of the nonce), not the last:
    // the final base64url char can carry only dropped padding bits, so
    // flipping it may be a no-op and make this test flaky.
    const at = ENVELOPE_PREFIX.length
    const tampered =
      envelope.slice(0, at) +
      (envelope[at] === 'A' ? 'B' : 'A') +
      envelope.slice(at + 1)
    await expect(open(key, tampered, aad)).rejects.toThrow()
  })
})
