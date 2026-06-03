import { describe, expect, it } from 'vitest'
import { decodeFromWire, encodeForWire, encryptUploadColumns, type GetCek } from './transform.js'
import { generateWorkspaceKeyBytes, importWorkspaceKey } from './crypto/workspaceKey.js'
import { hasEnvelopePrefix } from './crypto/envelope.js'

const WS = 'ws-1'

const cekFor = async (): Promise<GetCek> => {
  const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
  return async (workspaceId) => (workspaceId === WS ? key : null)
}

const block = (overrides: Partial<Record<string, string>> = {}) => ({
  id: 'block-1',
  workspace_id: WS,
  content: 'Hello world',
  properties_json: '{"type":"text"}',
  references_json: '[]',
  ...overrides,
})

describe('sync transform — plaintext mode', () => {
  it('encode is identity', async () => {
    const getCek = await cekFor()
    const row = block()
    expect(await encodeForWire(row, 'none', getCek)).toEqual(row)
  })

  it('decode is identity', async () => {
    const getCek = await cekFor()
    const row = block()
    expect(await decodeFromWire(row, 'none', getCek)).toEqual(row)
  })

  it('does not consult getCek in plaintext mode', async () => {
    let called = false
    const getCek: GetCek = async () => { called = true; return null }
    await encodeForWire(block(), 'none', getCek)
    await decodeFromWire(block(), 'none', getCek)
    expect(called).toBe(false)
  })
})

describe('sync transform — e2ee mode', () => {
  it('encrypts only the three content columns, leaving identifiers in clear', async () => {
    const getCek = await cekFor()
    const wire = await encodeForWire(block(), 'e2ee', getCek)
    expect(wire.id).toBe('block-1')
    expect(wire.workspace_id).toBe(WS)
    expect(hasEnvelopePrefix(wire.content)).toBe(true)
    expect(hasEnvelopePrefix(wire.properties_json)).toBe(true)
    expect(hasEnvelopePrefix(wire.references_json)).toBe(true)
    expect(wire.content).not.toContain('Hello world')
  })

  it('round-trips through encode → decode', async () => {
    const getCek = await cekFor()
    const original = block()
    const wire = await encodeForWire(original, 'e2ee', getCek)
    const back = await decodeFromWire(wire, 'e2ee', getCek)
    expect(back).toEqual(original)
  })

  it('encrypts even empty/default column values', async () => {
    const getCek = await cekFor()
    const wire = await encodeForWire(block({ content: '', references_json: '[]' }), 'e2ee', getCek)
    expect(hasEnvelopePrefix(wire.content)).toBe(true)
    expect(hasEnvelopePrefix(wire.references_json)).toBe(true)
  })

  it('throws on encode when the key is unavailable', async () => {
    const getCek: GetCek = async () => null
    await expect(encodeForWire(block(), 'e2ee', getCek)).rejects.toThrow(/key/i)
  })

  it('throws on decode when the key is unavailable', async () => {
    const getCek = await cekFor()
    const wire = await encodeForWire(block(), 'e2ee', getCek)
    const noKey: GetCek = async () => null
    await expect(decodeFromWire(wire, 'e2ee', noKey)).rejects.toThrow(/key/i)
  })

  it('fails to decode a row whose ciphertext was moved to another block id (AAD binding)', async () => {
    const getCek = await cekFor()
    const wire = await encodeForWire(block(), 'e2ee', getCek)
    const swapped = { ...wire, id: 'block-2' }
    await expect(decodeFromWire(swapped, 'e2ee', getCek)).rejects.toThrow()
  })

  it('produces distinct ciphertext for two blocks with identical content', async () => {
    const getCek = await cekFor()
    const a = await encodeForWire(block({ id: 'a' }), 'e2ee', getCek)
    const b = await encodeForWire(block({ id: 'b' }), 'e2ee', getCek)
    expect(a.content).not.toBe(b.content)
  })
})

describe('encryptUploadColumns — partial upload payloads', () => {
  it('is identity in plaintext mode', async () => {
    const getCek = await cekFor()
    const payload = { workspace_id: WS, content: 'hi', updated_at: 5 }
    expect(await encryptUploadColumns('b1', WS, payload, 'none', getCek)).toEqual(payload)
  })

  it('seals all three content columns of a full (CREATE) payload, leaving metadata clear', async () => {
    const getCek = await cekFor()
    const payload = {
      workspace_id: WS, parent_id: 'p', order_key: 'a0',
      content: 'Hello', properties_json: '{"type":"text"}', references_json: '[]',
      updated_at: 5,
    }
    const out = await encryptUploadColumns('b1', WS, payload, 'e2ee', getCek)
    expect(hasEnvelopePrefix(out.content as string)).toBe(true)
    expect(hasEnvelopePrefix(out.properties_json as string)).toBe(true)
    expect(hasEnvelopePrefix(out.references_json as string)).toBe(true)
    // identifiers + metadata untouched
    expect(out.workspace_id).toBe(WS)
    expect(out.parent_id).toBe('p')
    expect(out.order_key).toBe('a0')
    expect(out.updated_at).toBe(5)
  })

  it('seals only the content columns present in a (PATCH) subset', async () => {
    const getCek = await cekFor()
    const out = await encryptUploadColumns(
      'b1', WS, { workspace_id: WS, content: 'edited', updated_at: 9 }, 'e2ee', getCek,
    )
    expect(hasEnvelopePrefix(out.content as string)).toBe(true)
    expect(out.updated_at).toBe(9)
    // columns not in the patch are NOT introduced
    expect('properties_json' in out).toBe(false)
    expect('references_json' in out).toBe(false)
  })

  it('AAD matches encodeForWire — a full payload sealed on upload opens via decodeFromWire', async () => {
    const getCek = await cekFor()
    const sealed = await encryptUploadColumns(
      'b1', WS,
      { id: 'b1', workspace_id: WS, content: 'secret', properties_json: '{"a":1}', references_json: '[]' },
      'e2ee', getCek,
    )
    const opened = await decodeFromWire(
      {
        id: 'b1', workspace_id: WS,
        content: sealed.content as string,
        properties_json: sealed.properties_json as string,
        references_json: sealed.references_json as string,
      },
      'e2ee', getCek,
    )
    expect(opened).toEqual({
      id: 'b1', workspace_id: WS, content: 'secret', properties_json: '{"a":1}', references_json: '[]',
    })
  })

  it('throws when the key is unavailable for an e2ee upload', async () => {
    const noKey: GetCek = async () => null
    await expect(
      encryptUploadColumns('b1', WS, { workspace_id: WS, content: 'x' }, 'e2ee', noKey),
    ).rejects.toThrow(/key/i)
  })
})
