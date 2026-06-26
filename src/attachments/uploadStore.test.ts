// File-scoped IndexedDB polyfill — sets global `indexedDB`/`IDBKeyRange` so the
// real IndexedDbByteUploadStore can be exercised under Node (the records are
// plain JSON, unlike the keyStore's non-cloneable CryptoKey, so this works).
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

import { beforeEach, describe, expect, it } from 'vitest'
import {
  type ByteUploadRecord,
  type ByteUploadStore,
  IndexedDbByteUploadStore,
  InMemoryByteUploadStore,
  uploadRecordId,
  uploadUserPrefix,
  type StageInput,
} from './uploadStore.js'

// A fresh IndexedDB per test. The store caches its connection by design, so a
// prior test's still-open connection would block a `deleteDatabase`; swapping the
// whole factory sidesteps that and guarantees an empty DB each test.
const freshIndexedDb = () => {
  globalThis.indexedDB = new IDBFactory()
}

const stageInput = (over: Partial<StageInput> = {}): StageInput => ({
  userId: 'u1',
  assetBlockId: 'media:ck-abc',
  workspaceId: 'ws1',
  contentHash: 'sha256:abc',
  contentKey: 'ck-abc',
  ...over,
})

describe('uploadRecordId / uploadUserPrefix', () => {
  it('encodes so a delimiter inside an id cannot collide two distinct pairs', () => {
    // ('a:b', 'c') vs ('a', 'b:c') must not produce the same record id.
    expect(uploadRecordId('a:b', 'c')).not.toBe(uploadRecordId('a', 'b:c'))
  })

  it('the user prefix is a true prefix of every one of that user’s record ids', () => {
    expect(uploadRecordId('u1', 'media:x').startsWith(uploadUserPrefix('u1'))).toBe(true)
    // enc("u1"): is NOT a prefix of enc("u12"):… — the trailing ':' + encoding guarantees it.
    expect(uploadRecordId('u12', 'media:x').startsWith(uploadUserPrefix('u1'))).toBe(false)
  })
})

// One contract suite, run against BOTH the in-memory double and the real
// (fake-)IndexedDB store, so they can never drift.
const backends: Array<{ name: string; make: (now: () => number) => ByteUploadStore }> = [
  { name: 'InMemoryByteUploadStore', make: now => new InMemoryByteUploadStore(now) },
  { name: 'IndexedDbByteUploadStore', make: now => new IndexedDbByteUploadStore(now) },
]

for (const backend of backends) {
  describe(`ByteUploadStore contract — ${backend.name}`, () => {
    let clock = 0
    const now = () => clock
    let store: ByteUploadStore

    beforeEach(() => {
      freshIndexedDb()
      clock = 1000
      store = backend.make(now)
    })

    it('stage → get returns a staged record stamped with status/attempts/stagedAt', async () => {
      await store.stage(stageInput())
      const rec = await store.get('u1', 'media:ck-abc')
      expect(rec).toMatchObject<Partial<ByteUploadRecord>>({
        userId: 'u1',
        assetBlockId: 'media:ck-abc',
        workspaceId: 'ws1',
        contentHash: 'sha256:abc',
        contentKey: 'ck-abc',
        status: 'staged',
        attempts: 0,
        stagedAt: 1000,
      })
    })

    it('get of an absent record is null', async () => {
      expect(await store.get('u1', 'nope')).toBeNull()
    })

    it('stage is an idempotent upsert — a re-stage re-arms (status→staged, attempts→0, fresh stamp)', async () => {
      await store.stage(stageInput())
      await store.promote('u1', 'media:ck-abc')
      await store.recordAttempt('u1', 'media:ck-abc')
      // re-paste: same content-key, later clock
      clock = 2000
      await store.stage(stageInput())
      const rec = await store.get('u1', 'media:ck-abc')
      expect(rec).toMatchObject({ status: 'staged', attempts: 0, stagedAt: 2000 })
    })

    it('promote flips staged → pending (the post-commit flip)', async () => {
      await store.stage(stageInput())
      await store.promote('u1', 'media:ck-abc')
      expect((await store.get('u1', 'media:ck-abc'))?.status).toBe('pending')
    })

    it('recordAttempt increments attempts and leaves status unchanged', async () => {
      await store.stage(stageInput())
      await store.promote('u1', 'media:ck-abc')
      await store.recordAttempt('u1', 'media:ck-abc')
      await store.recordAttempt('u1', 'media:ck-abc')
      const rec = await store.get('u1', 'media:ck-abc')
      expect(rec).toMatchObject({ status: 'pending', attempts: 2 })
    })

    it('markFailed flips to failed', async () => {
      await store.stage(stageInput())
      await store.promote('u1', 'media:ck-abc')
      await store.markFailed('u1', 'media:ck-abc')
      expect((await store.get('u1', 'media:ck-abc'))?.status).toBe('failed')
    })

    it('delete removes the record (confirmed upload or reap)', async () => {
      await store.stage(stageInput())
      await store.delete('u1', 'media:ck-abc')
      expect(await store.get('u1', 'media:ck-abc')).toBeNull()
    })

    it('markFailed / recordAttempt with a STALE expectedStagedAt no-op — a re-paste re-armed the record', async () => {
      await store.stage(stageInput()) // stagedAt 1000
      await store.promote('u1', 'media:ck-abc')
      const staleStamp = (await store.get('u1', 'media:ck-abc'))?.stagedAt // 1000
      // A re-paste of the same content re-arms it with a fresh stamp.
      clock = 2000
      await store.stage(stageInput()) // status staged, attempts 0, stagedAt 2000
      // A drain decision computed from the OLD snapshot must not bury the re-paste.
      await store.markFailed('u1', 'media:ck-abc', staleStamp)
      await store.recordAttempt('u1', 'media:ck-abc', staleStamp)
      expect(await store.get('u1', 'media:ck-abc')).toMatchObject({
        status: 'staged',
        attempts: 0,
        stagedAt: 2000,
      })
      // The CURRENT stamp still applies (a non-stale drain isn't disarmed).
      await store.markFailed('u1', 'media:ck-abc', 2000)
      expect((await store.get('u1', 'media:ck-abc'))?.status).toBe('failed')
    })

    it('promote / recordAttempt / markFailed on an absent record are no-ops (never throw)', async () => {
      await expect(store.promote('u1', 'gone')).resolves.toBeUndefined()
      await expect(store.recordAttempt('u1', 'gone')).resolves.toBeUndefined()
      await expect(store.markFailed('u1', 'gone')).resolves.toBeUndefined()
      expect(await store.get('u1', 'gone')).toBeNull()
    })

    it('listByStatus filters by status and is scoped to the user', async () => {
      await store.stage(stageInput({ assetBlockId: 'media:a' }))
      await store.stage(stageInput({ assetBlockId: 'media:b' }))
      await store.promote('u1', 'media:b')
      // a different account in the same profile/store must not leak in
      await store.stage(stageInput({ userId: 'u2', assetBlockId: 'media:c' }))
      await store.promote('u2', 'media:c')

      const staged = await store.listByStatus('u1', 'staged')
      const pending = await store.listByStatus('u1', 'pending')
      expect(staged.map(r => r.assetBlockId)).toEqual(['media:a'])
      expect(pending.map(r => r.assetBlockId)).toEqual(['media:b'])
      // u2's pending record is invisible to u1
      expect((await store.listByStatus('u1', 'pending')).every(r => r.userId === 'u1')).toBe(true)
    })

    it('clearForUser drops only that user’s records', async () => {
      await store.stage(stageInput({ userId: 'u1', assetBlockId: 'media:a' }))
      await store.stage(stageInput({ userId: 'u2', assetBlockId: 'media:b' }))
      await store.clearForUser('u1')
      expect(await store.get('u1', 'media:a')).toBeNull()
      expect(await store.get('u2', 'media:b')).not.toBeNull()
    })
  })
}

describe('IndexedDbByteUploadStore — durability across instances', () => {
  beforeEach(() => freshIndexedDb())

  it('a record staged by one instance is visible to a fresh instance reopening the same DB', async () => {
    const a = new IndexedDbByteUploadStore(() => 1000)
    await a.stage(stageInput())
    const b = new IndexedDbByteUploadStore(() => 2000)
    expect((await b.get('u1', 'media:ck-abc'))?.status).toBe('staged')
  })
})
