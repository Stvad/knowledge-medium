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

  it('round-trips the empty string (blank block content)', async () => {
    // A blank block's content seals to a payload at exactly the
    // nonce+tag floor (the empty plaintext adds no ciphertext bytes), so
    // it sits right on decodeEnvelope's `< floor` boundary. This pins
    // open(seal('')) === '' so a future off-by-one in the floor check
    // (e.g. `< floor` → `<= floor`) can't silently quarantine every
    // empty block on download.
    const key = await keyFrom(0x01)
    const aad = contentAad('block-1', 'ws-A', 'content')
    const envelope = await seal(key, '', aad)
    expect(envelope.startsWith(ENVELOPE_PREFIX)).toBe(true)
    expect(await open(key, envelope, aad)).toBe('')
  })

  it('round-trips a leading U+FEFF instead of eating it as a byte-order mark (#534)', async () => {
    // A default `new TextDecoder()` strips a leading U+FEFF, so `open` used
    // to return this content one character short — silent corruption of any
    // encrypted block whose first character is a zero-width no-break space,
    // made permanent the moment that device saved the block back. Written as
    // `\ufeff` escapes on purpose: a literal BOM here would be invisible to
    // a reader and easy for an editor to eat. The cases pin the boundary the
    // decoder actually has — it strips at most one, and only at offset 0 —
    // so a doubled BOM must come back with both, and an interior one (never
    // at risk) guards against over-correcting into a strip-everywhere fix.
    const key = await keyFrom(0x01)
    const aad = contentAad('block-1', 'ws-A', 'content')
    for (const plaintext of ['\ufeff', '\ufeffhi', '\ufeff\ufeffhi', 'a\ufeffb']) {
      expect(await open(key, await seal(key, plaintext, aad), aad)).toBe(plaintext)
    }
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

  it('fails when the ciphertext is rebound to another workspace (AAD workspace binding)', async () => {
    // A server that copies a ciphertext from ws-A into ws-B (same block id,
    // same column) must not be able to make it decrypt under ws-B's view.
    const key = await keyFrom(0x01)
    const envelope = await seal(key, 'secret', contentAad('block-1', 'ws-A', 'content'))
    await expect(
      open(key, envelope, contentAad('block-1', 'ws-B', 'content')),
    ).rejects.toThrow()
  })

  it('fails when the ciphertext is rebound to another block (AAD block binding)', async () => {
    const key = await keyFrom(0x01)
    const envelope = await seal(key, 'secret', contentAad('block-1', 'ws-A', 'content'))
    await expect(
      open(key, envelope, contentAad('block-2', 'ws-A', 'content')),
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
