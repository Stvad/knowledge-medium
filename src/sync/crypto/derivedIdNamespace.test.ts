import { describe, expect, it } from 'vitest'
import { v5 as uuidv5 } from 'uuid'
import { deriveContentKeyHmac } from './contentKey.js'
import { deriveWorkspaceIdNamespace } from './derivedIdNamespace.js'

const kIdFor = (fill: number) => deriveContentKeyHmac(new Uint8Array(32).fill(fill))
const LABEL = 'km/property-definition-ns/v1'

describe('deriveWorkspaceIdNamespace', () => {
  it('is a namespace uuidv5 accepts — the version/variant forcing is what makes it one', async () => {
    const namespace = await deriveWorkspaceIdNamespace(await kIdFor(1), LABEL)
    expect(namespace).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(() => uuidv5('demo:orphan', namespace)).not.toThrow()
  })

  // Against a LITERAL, the way `derivedIds.test.ts` pins every other derived-id
  // formula: an expected value recomputed by the code under test would hold
  // just as well if the derivation moved to a different 16 bytes of the MAC, or
  // to a different label — and either silently re-points every id already
  // minted. Determinism follows from this; it does not need its own test.
  it('is HMAC(K_id, label) truncated to the first 16 bytes, and has not moved', async () => {
    expect(await deriveWorkspaceIdNamespace(await kIdFor(1), LABEL))
      .toBe('897d859e-5508-436c-a9bb-cc4a77b026b5')
  })

  it('differs per workspace key — the whole point, so one workspace cannot predict another\'s ids', async () => {
    expect(await deriveWorkspaceIdNamespace(await kIdFor(1), LABEL))
      .not.toBe(await deriveWorkspaceIdNamespace(await kIdFor(2), LABEL))
  })

  it('differs per label, so two derived-id kinds never share a namespace', async () => {
    const kId = await kIdFor(1)
    expect(await deriveWorkspaceIdNamespace(kId, LABEL))
      .not.toBe(await deriveWorkspaceIdNamespace(kId, 'km/alias-seat-ns/v1'))
  })

  it('refuses a 32-byte label — that is the asset content-key input set for this same key', async () => {
    await expect(deriveWorkspaceIdNamespace(await kIdFor(1), 'x'.repeat(32)))
      .rejects.toThrow(/must not be 32 bytes/)
  })
})
