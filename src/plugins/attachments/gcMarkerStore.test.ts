// File-scoped IndexedDB polyfill so the real IndexedDbGcMarkerStore runs under Node
// (records are plain JSON). Mirrors uploadStore.test.ts.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

import { beforeEach, describe, expect, it } from 'vitest'
import {
  type GcMarker,
  type GcMarkerStore,
  IndexedDbGcMarkerStore,
  InMemoryGcMarkerStore,
} from './gcMarkerStore.js'

// A fresh IndexedDB per test — the store caches its connection, so swapping the whole
// factory guarantees an empty DB each test (same pattern as uploadStore.test.ts).
const freshIndexedDb = () => {
  globalThis.indexedDB = new IDBFactory()
}

const marker = (over: Partial<GcMarker> = {}): GcMarker => ({
  userId: 'u1',
  workspaceId: 'ws-A',
  firstSeenOrphanedAt: 5000,
  ...over,
})

const backends: Array<{ name: string; make: () => GcMarkerStore }> = [
  { name: 'InMemoryGcMarkerStore', make: () => new InMemoryGcMarkerStore() },
  { name: 'IndexedDbGcMarkerStore', make: () => new IndexedDbGcMarkerStore() },
]

for (const backend of backends) {
  describe(`GcMarkerStore contract — ${backend.name}`, () => {
    let store: GcMarkerStore

    beforeEach(() => {
      freshIndexedDb()
      store = backend.make()
    })

    it('set → get round-trips a marker by (user, workspace)', async () => {
      await store.set(marker())
      expect(await store.get('u1', 'ws-A')).toEqual(marker())
    })

    it('get of an absent marker is null', async () => {
      expect(await store.get('u1', 'nope')).toBeNull()
    })

    it('set overwrites an existing marker', async () => {
      await store.set(marker({ firstSeenOrphanedAt: 1000 }))
      await store.set(marker({ firstSeenOrphanedAt: 2000 }))
      expect(await store.get('u1', 'ws-A')).toMatchObject({ firstSeenOrphanedAt: 2000 })
    })

    it('clear drops one marker; idempotent when absent', async () => {
      await store.set(marker())
      await store.clear('u1', 'ws-A')
      expect(await store.get('u1', 'ws-A')).toBeNull()
      await expect(store.clear('u1', 'ws-A')).resolves.toBeUndefined() // no-op
    })

    it('isolates markers by user and by workspace', async () => {
      await store.set(marker({ userId: 'u1', workspaceId: 'ws-A' }))
      await store.set(marker({ userId: 'u1', workspaceId: 'ws-B' }))
      await store.set(marker({ userId: 'u2', workspaceId: 'ws-A' }))
      expect(await store.get('u1', 'ws-A')).not.toBeNull()
      expect(await store.get('u2', 'ws-A')).not.toBeNull()
      // clearing u1/ws-A leaves the u2 and ws-B markers
      await store.clear('u1', 'ws-A')
      expect(await store.get('u1', 'ws-A')).toBeNull()
      expect(await store.get('u1', 'ws-B')).not.toBeNull()
      expect(await store.get('u2', 'ws-A')).not.toBeNull()
    })

    it('listForUser returns only that user’s markers', async () => {
      await store.set(marker({ userId: 'u1', workspaceId: 'ws-A' }))
      await store.set(marker({ userId: 'u1', workspaceId: 'ws-B' }))
      await store.set(marker({ userId: 'u2', workspaceId: 'ws-C' }))
      const ids = (await store.listForUser('u1')).map(m => m.workspaceId).sort()
      expect(ids).toEqual(['ws-A', 'ws-B'])
      expect(await store.listForUser('never')).toEqual([])
    })

    it('clearForUser drops all of one user’s markers, leaving other accounts', async () => {
      await store.set(marker({ userId: 'u1', workspaceId: 'ws-A' }))
      await store.set(marker({ userId: 'u1', workspaceId: 'ws-B' }))
      await store.set(marker({ userId: 'u2', workspaceId: 'ws-C' }))
      await store.clearForUser('u1')
      expect(await store.listForUser('u1')).toEqual([])
      expect(await store.get('u2', 'ws-C')).not.toBeNull()
    })
  })
}

describe('IndexedDbGcMarkerStore — durability across instances', () => {
  beforeEach(() => freshIndexedDb())

  it('a fresh instance (a page reload) reads a marker written by a prior instance', async () => {
    await new IndexedDbGcMarkerStore().set(marker())
    // A brand-new instance models a reload reopening the persisted DB.
    expect(await new IndexedDbGcMarkerStore().get('u1', 'ws-A')).toEqual(marker())
  })
})
