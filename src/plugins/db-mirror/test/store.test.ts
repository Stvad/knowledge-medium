// File-scoped IndexedDB polyfill so the real store runs under Node. The
// settings record is plain JSON; the directory handle is stored under its own
// key, and stands in here as a plain object (a real handle is host-defined but
// structured-cloneable, which is the whole reason it can live in IndexedDB).
import 'fake-indexeddb/auto'
import {IDBFactory} from 'fake-indexeddb'

import {beforeEach, describe, expect, it} from 'vitest'
import {
  DB_MIRROR_DEFAULTS,
  createDbMirrorStore,
  type DbMirrorStore,
} from '../store.js'

const USER = 'alice'

let store: DbMirrorStore

beforeEach(() => {
  // A fresh IndexedDB per test: the store caches its connection, so a prior
  // test's open handle would block a delete.
  globalThis.indexedDB = new IDBFactory()
  store = createDbMirrorStore()
})

const fakeDirectory = (name: string) =>
  ({kind: 'directory', name} as unknown as FileSystemDirectoryHandle)

describe('db-mirror store', () => {
  it('starts off, with no folder and no history', async () => {
    const state = await store.load(USER)
    expect(state).toEqual({
      settings: DB_MIRROR_DEFAULTS,
      status: {},
      directory: undefined,
    })
    expect(DB_MIRROR_DEFAULTS.enabled).toBe(false)
  })

  it('persists settings across a reload', async () => {
    await store.load(USER)
    await store.updateSettings(USER, {enabled: true, keepCount: 5})

    const reopened = createDbMirrorStore()
    expect((await reopened.load(USER)).settings).toMatchObject({
      enabled: true,
      keepCount: 5,
      intervalMinutes: DB_MIRROR_DEFAULTS.intervalMinutes,
    })
  })

  it('persists the folder handle across a reload', async () => {
    await store.load(USER)
    await store.setDirectory(USER, fakeDirectory('Backups'))

    const reopened = createDbMirrorStore()
    expect((await reopened.load(USER)).directory).toMatchObject({name: 'Backups'})
  })

  it('forgets the folder when the user stops mirroring', async () => {
    await store.load(USER)
    await store.setDirectory(USER, fakeDirectory('Backups'))
    await store.setDirectory(USER, undefined)

    expect((await createDbMirrorStore().load(USER)).directory).toBeUndefined()
  })

  it('keeps each account’s settings separate', async () => {
    await store.load(USER)
    await store.updateSettings(USER, {enabled: true})
    await store.load('bob')

    expect((await store.load('bob')).settings.enabled).toBe(false)
    expect((await store.load(USER)).settings.enabled).toBe(true)
  })

  it('clamps a hand-edited keep count into a range that still leaves a copy', async () => {
    await store.load(USER)
    expect((await store.updateSettings(USER, {keepCount: 0})).settings.keepCount).toBe(1)
    expect((await store.updateSettings(USER, {keepCount: 999})).settings.keepCount).toBe(20)
  })

  it('records a success and clears the previous failure', async () => {
    await store.load(USER)
    await store.recordStatus(USER, {lastError: 'quota', lastErrorAt: 1, permissionLost: true})
    const state = await store.recordStatus(USER, {
      lastMirrorAt: 100,
      lastMarker: '42',
      lastFilename: 'copy.db',
      lastBytes: 1024,
      lastError: undefined,
      lastErrorAt: undefined,
      permissionLost: false,
    })

    expect(state.status).toEqual({
      lastMirrorAt: 100,
      lastMarker: '42',
      lastFilename: 'copy.db',
      lastBytes: 1024,
      permissionLost: false,
    })
  })

  it('remembers the last success when a later run fails', async () => {
    await store.load(USER)
    await store.recordStatus(USER, {lastMirrorAt: 100, lastMarker: '42'})
    const state = await store.recordStatus(USER, {lastError: 'quota', lastErrorAt: 200})

    expect(state.status).toMatchObject({lastMirrorAt: 100, lastMarker: '42', lastError: 'quota'})
  })

  it('notifies subscribers and hands them a new snapshot only on a change', async () => {
    const seen: unknown[] = []
    const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()))

    await store.load(USER)
    const afterLoad = store.getSnapshot()
    await store.updateSettings(USER, {enabled: true})

    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(store.getSnapshot()).not.toBe(afterLoad)
    expect(store.getSnapshot()).toBe(store.getSnapshot())
    unsubscribe()
  })

  it('survives a storage failure by answering with the defaults', async () => {
    const broken = createDbMirrorStore('km-db-mirror-broken')
    // No IndexedDB at all — the private-window / blocked-storage shape.
    const indexedDb = globalThis.indexedDB
    Reflect.deleteProperty(globalThis, 'indexedDB')
    try {
      expect((await broken.load(USER)).settings).toEqual(DB_MIRROR_DEFAULTS)
    } finally {
      globalThis.indexedDB = indexedDb
    }
  })
})
