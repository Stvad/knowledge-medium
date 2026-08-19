import { describe, expect, it } from 'vitest'
import {
  InMemoryWorkspaceKeyStore,
  keyStoreRecordId,
  normalizeKeyRecord,
  type WorkspaceKeyRecord,
} from './keyStore.js'
import { deriveContentKeyHmac } from '../crypto/contentKey.js'
import { generateWorkspaceKeyBytes, importWorkspaceKey } from '../crypto/workspaceKey.js'

const aKey = () => importWorkspaceKey(generateWorkspaceKeyBytes())
/** A full record (WK + a real derived K_id), as the flows now write it. */
const aRecord = async (): Promise<WorkspaceKeyRecord> => {
  const bytes = generateWorkspaceKeyBytes()
  return { wk: await importWorkspaceKey(bytes), contentKeyHmac: await deriveContentKeyHmac(bytes) }
}

describe('keyStoreRecordId', () => {
  it('combines user and workspace', () => {
    expect(keyStoreRecordId('u', 'w')).toBe('u:w')
  })

  it('does not alias ids that share a delimiter', () => {
    expect(keyStoreRecordId('a', 'b:c')).not.toBe(keyStoreRecordId('a:b', 'c'))
  })
})

describe('normalizeKeyRecord (§10 legacy migration)', () => {
  it('passes a new-shape record through unchanged', async () => {
    const rec = await aRecord()
    expect(normalizeKeyRecord(rec)).toBe(rec)
  })

  it('wraps a LEGACY bare CryptoKey as { wk, contentKeyHmac: null } (no K_id → fail-closed media)', async () => {
    const legacy = await aKey()
    expect(normalizeKeyRecord(legacy)).toEqual({ wk: legacy, contentKeyHmac: null })
  })

  it('maps null / undefined to null', () => {
    expect(normalizeKeyRecord(null)).toBeNull()
    expect(normalizeKeyRecord(undefined)).toBeNull()
  })
})

// The IndexedDB implementation needs a real browser (CryptoKey isn't
// structured-cloneable under Node); the in-memory store exercises the
// shared interface contract that the flows depend on.
describe('InMemoryWorkspaceKeyStore', () => {
  it('returns null for an absent key', async () => {
    const store = new InMemoryWorkspaceKeyStore()
    expect(await store.get('u', 'w')).toBeNull()
  })

  it('round-trips a record (WK + K_id) by (user, workspace)', async () => {
    const store = new InMemoryWorkspaceKeyStore()
    const rec = await aRecord()
    await store.put('u', 'w', rec)
    expect(await store.get('u', 'w')).toBe(rec)
  })

  it('isolates keys per (user, workspace)', async () => {
    const store = new InMemoryWorkspaceKeyStore()
    const r1 = await aRecord()
    const r2 = await aRecord()
    await store.put('u', 'w1', r1)
    await store.put('u', 'w2', r2)
    expect(await store.get('u', 'w1')).toBe(r1)
    expect(await store.get('u', 'w2')).toBe(r2)
    expect(await store.get('other', 'w1')).toBeNull()
  })

  it('deletes a single key without touching others', async () => {
    const store = new InMemoryWorkspaceKeyStore()
    await store.put('u', 'w1', await aRecord())
    await store.put('u', 'w2', await aRecord())
    await store.delete('u', 'w1')
    expect(await store.get('u', 'w1')).toBeNull()
    expect(await store.get('u', 'w2')).not.toBeNull()
  })

  it("clearForUser drops the user's keys but leaves OTHER accounts' keys (Lock & wipe, §6)", async () => {
    // The store is shared across accounts in a browser profile, but Lock & wipe
    // is per-user — wiping 'u' must not lock account 'other'.
    const store = new InMemoryWorkspaceKeyStore()
    await store.put('u', 'w1', await aRecord())
    await store.put('u', 'w2', await aRecord())
    const otherRec = await aRecord()
    await store.put('other', 'w1', otherRec)

    await store.clearForUser('u')

    expect(await store.get('u', 'w1')).toBeNull()
    expect(await store.get('u', 'w2')).toBeNull()
    expect(await store.get('other', 'w1')).toBe(otherRec)
  })

  it('clearForUser does not drop a different user whose id shares a prefix', async () => {
    // 'ab' must not match 'abc' — the encoded `:` delimiter guards against it.
    const store = new InMemoryWorkspaceKeyStore()
    const abcRec = await aRecord()
    await store.put('ab', 'w', await aRecord())
    await store.put('abc', 'w', abcRec)

    await store.clearForUser('ab')

    expect(await store.get('ab', 'w')).toBeNull()
    expect(await store.get('abc', 'w')).toBe(abcRec)
  })
})
