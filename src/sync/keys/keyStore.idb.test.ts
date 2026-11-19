// File-scoped IndexedDB polyfill, as in `@/utils/idbKeyedStore.test.ts`. Records
// here hold plain objects where the browser holds `CryptoKey`s, which Node
// cannot structured-clone.
import 'fake-indexeddb/auto'

import { describe, expect, it, vi } from 'vitest'
import { IdbKeyedStore } from '@/utils/idbKeyedStore.js'
import {
  IndexedDbWorkspaceKeyStore,
  KeyRecordUnreadableError,
  keyStoreRecordId,
  type WorkspaceKeyRecord,
} from './keyStore.js'

const record = (): WorkspaceKeyRecord =>
  ({wk: {name: 'wk'}, contentKeyHmac: {name: 'k_id'}}) as unknown as WorkspaceKeyRecord

/** The stored value as a locked iOS device reads it: `null`, record still there. */
const sealRecord = (userId: string, workspaceId: string) =>
  new IdbKeyedStore('km-e2ee-keys', 'workspace_keys')
    .tx('readwrite', store => store.put(null, keyStoreRecordId(userId, workspaceId)))

describe('IndexedDbWorkspaceKeyStore', () => {
  it('throws for a record that is stored but reads as null, rather than calling it absent', async () => {
    await sealRecord('u', 'never-read')

    await expect(new IndexedDbWorkspaceKeyStore().get('u', 'never-read'))
      .rejects.toBeInstanceOf(KeyRecordUnreadableError)
  })

  it('answers null for a record that is not stored', async () => {
    expect(await new IndexedDbWorkspaceKeyStore().get('u', 'absent')).toBeNull()
  })

  it('serves the record it last read while the stored one cannot be read', async () => {
    const store = new IndexedDbWorkspaceKeyStore()
    await store.put('u', 'sealed', record())
    const read = await store.get('u', 'sealed')
    await sealRecord('u', 'sealed')

    expect(await store.get('u', 'sealed')).toBe(read)
  })

  it('serves the record it last read while the store throws', async () => {
    const store = new IndexedDbWorkspaceKeyStore()
    await store.put('u', 'throws', record())
    const read = await store.get('u', 'throws')
    vi.spyOn(IdbKeyedStore.prototype, 'tx').mockRejectedValueOnce(new Error('connection lost'))

    expect(await store.get('u', 'throws')).toBe(read)
  })

  it('stops serving a record once a read finds it gone', async () => {
    const store = new IndexedDbWorkspaceKeyStore()
    await store.put('u', 'evicted', record())
    await store.get('u', 'evicted')
    await new IdbKeyedStore('km-e2ee-keys', 'workspace_keys')
      .tx('readwrite', s => s.delete(keyStoreRecordId('u', 'evicted')))

    expect(await store.get('u', 'evicted')).toBeNull()
    await sealRecord('u', 'evicted')
    await expect(store.get('u', 'evicted')).rejects.toBeInstanceOf(KeyRecordUnreadableError)
  })

  it('stops serving records it deleted or cleared', async () => {
    const store = new IndexedDbWorkspaceKeyStore()
    await store.put('u', 'deleted', record())
    await store.put('other', 'cleared', record())
    await store.delete('u', 'deleted')
    await store.clearForUser('other')
    await sealRecord('u', 'deleted')
    await sealRecord('other', 'cleared')

    await expect(store.get('u', 'deleted')).rejects.toBeInstanceOf(KeyRecordUnreadableError)
    await expect(store.get('other', 'cleared')).rejects.toBeInstanceOf(KeyRecordUnreadableError)
  })
})
