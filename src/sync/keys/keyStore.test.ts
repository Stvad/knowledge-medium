import { describe, expect, it } from 'vitest'
import { InMemoryWorkspaceKeyStore, keyStoreRecordId } from './keyStore.js'
import { generateWorkspaceKeyBytes, importWorkspaceKey } from '../crypto/workspaceKey.js'

const aKey = () => importWorkspaceKey(generateWorkspaceKeyBytes())

describe('keyStoreRecordId', () => {
  it('combines user and workspace', () => {
    expect(keyStoreRecordId('u', 'w')).toBe('u:w')
  })

  it('does not alias ids that share a delimiter', () => {
    expect(keyStoreRecordId('a', 'b:c')).not.toBe(keyStoreRecordId('a:b', 'c'))
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

  it('round-trips a CryptoKey by (user, workspace)', async () => {
    const store = new InMemoryWorkspaceKeyStore()
    const key = await aKey()
    await store.put('u', 'w', key)
    expect(await store.get('u', 'w')).toBe(key)
  })

  it('isolates keys per (user, workspace)', async () => {
    const store = new InMemoryWorkspaceKeyStore()
    const k1 = await aKey()
    const k2 = await aKey()
    await store.put('u', 'w1', k1)
    await store.put('u', 'w2', k2)
    expect(await store.get('u', 'w1')).toBe(k1)
    expect(await store.get('u', 'w2')).toBe(k2)
    expect(await store.get('other', 'w1')).toBeNull()
  })

  it('deletes a single key without touching others', async () => {
    const store = new InMemoryWorkspaceKeyStore()
    await store.put('u', 'w1', await aKey())
    await store.put('u', 'w2', await aKey())
    await store.delete('u', 'w1')
    expect(await store.get('u', 'w1')).toBeNull()
    expect(await store.get('u', 'w2')).not.toBeNull()
  })

  it('clearAll drops every key (Lock & wipe, §6)', async () => {
    const store = new InMemoryWorkspaceKeyStore()
    await store.put('u', 'w1', await aKey())
    await store.put('u', 'w2', await aKey())
    await store.clearAll()
    expect(await store.get('u', 'w1')).toBeNull()
    expect(await store.get('u', 'w2')).toBeNull()
  })
})
