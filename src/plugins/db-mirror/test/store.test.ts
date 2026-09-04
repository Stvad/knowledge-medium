// File-scoped IndexedDB polyfill so the real store runs under Node. The
// settings record is plain JSON; the directory handle is stored under its own
// key, and stands in here as a plain object (a real handle is host-defined but
// structured-cloneable, which is the whole reason it can live in IndexedDB).
import 'fake-indexeddb/auto'
import {IDBFactory} from 'fake-indexeddb'

import {beforeEach, describe, expect, it, vi} from 'vitest'
import {IdbKeyedStore} from '@/utils/idbKeyedStore.js'
import {
  DB_MIRROR_DEFAULTS,
  createDbMirrorStore,
  type DbMirrorStore,
} from '../store.js'

const storedKeys = () =>
  new IdbKeyedStore('km-db-mirror', 'mirror').tx('readonly', s => s.getAllKeys())

/** The record ids the store uses, so a test can assert what namespaces them. */
const keyStringsFor = async () => (await storedKeys()).map(String)

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

  it('writes nothing for a user who has never opted in', async () => {
    // The scheduled loop reads this on every tick; a read that wrote back would
    // churn storage forever for someone who never turned the feature on.
    await store.load(USER)
    expect(await storedKeys()).toEqual([])
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

  it('forgets everything the previous folder’s copies said', async () => {
    // The change marker especially: carried across, the next run would report
    // "nothing changed" while the newly chosen folder stayed empty.
    await store.load(USER)
    await store.recordStatus(USER, {
      lastMarker: '42',
      lastMirrorAt: 100,
      lastFilename: 'copy.db',
      permissionLost: true,
      lastError: 'the grant lapsed',
      lastErrorAt: 1,
    })

    const state = await store.setDirectory(USER, fakeDirectory('Elsewhere'))

    expect(state.status).toEqual({})
  })

  it('namespaces the record by the database, not just by the account', async () => {
    // A PR preview and production are the same origin and the same account but
    // deliberately different SQLite files, each with its own change marker.
    await store.load(USER)
    await store.updateSettings(USER, {enabled: true})

    const {dbFilenameForUser} = await import('@/data/localDbStorage.js')
    const keys = await keyStringsFor()
    expect(keys.every(k => k.startsWith(encodeURIComponent(dbFilenameForUser(USER))))).toBe(true)
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

  it('does not let a second tab’s write revert this one’s', async () => {
    // Two stores against the same IndexedDB model two tabs: each holds its own
    // in-realm state, so only doing the read and the write in ONE transaction
    // keeps the pair from interleaving and clobbering each other.
    const tabA = createDbMirrorStore()
    const tabB = createDbMirrorStore()
    await tabA.load(USER)

    await Promise.all([
      tabA.updateSettings(USER, {enabled: true}),
      tabB.recordStatus(USER, {lastMarker: '42'}),
    ])

    const reopened = await createDbMirrorStore().load(USER)
    expect(reopened.settings.enabled).toBe(true)
    expect(reopened.status.lastMarker).toBe('42')
  })

  it('refuses to publish an operation for a user who is no longer signed in', async () => {
    // Local-only sign-out swaps accounts without a reload, so an operation for
    // the previous user can still land afterwards. Published, it would put that
    // account's folder and history back on screen — and the mounted dialog
    // would never reload it, since its effect keys on the current user id.
    await store.load('bob')
    const bobs = store.getSnapshot()

    await store.recordStatus('alice', {lastMarker: '42', lastFilename: 'alices-copy.db'})

    expect(store.getSnapshot()).toBe(bobs)
    expect(store.getSnapshot()?.status.lastMarker).toBeUndefined()
  })

  it('picks up a change another tab made', async () => {
    // Every tab owns its own in-memory listeners, and an IndexedDB write
    // notifies nobody — so without a broadcast, a settings dialog left open and
    // the status chip go on reporting a healthy mirror after a background tab
    // has recorded a failure.
    const tabA = createDbMirrorStore()
    const tabB = createDbMirrorStore()
    await tabA.load(USER)
    await tabB.load(USER)

    await tabB.recordStatus(USER, {lastError: 'the disk is full', lastErrorAt: 1})

    await vi.waitFor(() => expect(tabA.getSnapshot()?.status.lastError).toBe('the disk is full'))
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
