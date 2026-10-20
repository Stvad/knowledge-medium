import { beforeAll, describe, expect, it, vi } from 'vitest'
import { encodeBytes, MAX_OBJECT_BYTES, verifyObjectBytes } from '../byteTransform.js'
import { BINARY_ENVELOPE_MAGIC, BINARY_ENVELOPE_OVERHEAD_BYTES } from '../crypto/binaryEnvelope.js'
import { mintCanary } from '../crypto/canary.js'
import { computeContentHash } from '../crypto/contentHash.js'
import { deriveContentKey, deriveContentKeyHmac } from '../crypto/contentKey.js'
import { importWorkspaceKey } from '../crypto/workspaceKey.js'
import { cleanAttachments, type ConversionBundle } from './attachmentCleaner.js'
import { ConversionRefusal } from './sealing.js'
import { createFakeAttachmentStorage, createFakeBundle, type FakeAttachmentStorage } from './test/fakeAttachmentStorage.js'

const WS = 'ws-convert'
const utf8 = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>

interface Keys {
  keys: {cek: CryptoKey; contentKeyHmac: CryptoKey}
  canary: string
}
const keysFor = async (fill: number): Promise<Keys> => {
  const wk = new Uint8Array(32).fill(fill)
  const cek = await importWorkspaceKey(wk)
  return {keys: {cek, contentKeyHmac: await deriveContentKeyHmac(wk)}, canary: await mintCanary(cek, WS)}
}

let keys: Keys
let otherKeys: Keys
beforeAll(async () => {
  keys = await keysFor(7)
  otherKeys = await keysFor(8)
})

const hashOf = (bytes: Uint8Array<ArrayBuffer>) => computeContentHash(bytes)
const rawName = async (bytes: Uint8Array<ArrayBuffer>) => (await hashOf(bytes)).slice('sha256:'.length)
const keyedName = async (bytes: Uint8Array<ArrayBuffer>, k = keys) =>
  deriveContentKey({contentHash: await hashOf(bytes), mode: 'e2ee', contentKeyHmac: k.keys.contentKeyHmac})
const seal = async (bytes: Uint8Array<ArrayBuffer>, k = keys) =>
  encodeBytes(bytes, 'e2ee', async () => k.keys.cek, {contentHash: await hashOf(bytes), workspaceId: WS})

/** Put `bytes` in the folder at their raw name; optionally as a media block's. */
const putRaw = async (store: FakeAttachmentStorage, bytes: Uint8Array<ArrayBuffer>, blockId?: string) => {
  store.objects.set(await rawName(bytes), bytes)
  if (blockId) store.media.push({blockId, contentHash: await hashOf(bytes)})
}

const clean = (store: FakeAttachmentStorage, bundle: ConversionBundle | null = null, k = keys) =>
  cleanAttachments({workspaceId: WS, io: store.io, ...k, bundle})

/** Does the folder hold `bytes`, sealed and verifiable, at their keyed name? */
const holdsKeyed = async (store: FakeAttachmentStorage, bytes: Uint8Array<ArrayBuffer>) => {
  const stored = store.objects.get(await keyedName(bytes))
  if (!stored) return false
  const verified = await verifyObjectBytes(stored, 'e2ee', async () => keys.keys.cek, {
    contentHash: await hashOf(bytes),
    workspaceId: WS,
  })
  return verified.ok
}

describe('cleanAttachments: raw objects', () => {
  it('converts a media block\'s raw object: keyed copy verified, raw deleted, proof passed', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    await putRaw(store, photo, 'block-1')
    const report = await clean(store)
    expect(report.converted).toEqual([await rawName(photo)])
    expect(await holdsKeyed(store, photo)).toBe(true)
    expect(store.objects.has(await rawName(photo))).toBe(false)
    expect(report.proof).toEqual({kind: 'passed', unrecoverable: []})
  })

  it('a raw object with no media block is converted, and its keyed copy survives the next pass', async () => {
    const store = createFakeAttachmentStorage()
    const orphan = utf8('an orphan upload')
    await putRaw(store, orphan)
    expect((await clean(store)).converted).toEqual([await rawName(orphan)])
    const again = await clean(store, createFakeBundle())
    expect(store.deletes).toEqual([await rawName(orphan)])
    expect(await holdsKeyed(store, orphan)).toBe(true)
    // Its hash is known to nothing now, so the rule can't open it: it stays, reported.
    expect(again.left).toEqual([{path: await keyedName(orphan), reason: 'not-archived'}])
  })

  it('a plaintext file that begins with encb:v1: is still raw, and is converted', async () => {
    const store = createFakeAttachmentStorage()
    const looksSealed = new Uint8Array([...BINARY_ENVELOPE_MAGIC, ...new Uint8Array(40).fill(9)])
    await putRaw(store, looksSealed, 'block-1')
    const report = await clean(store)
    expect(report.converted).toEqual([await rawName(looksSealed)])
    expect(await holdsKeyed(store, looksSealed)).toBe(true)
  })

  // Seals and hashes two ~50 MiB buffers: ~0.5 s alone, so 60 s covers a loaded gate.
  it('an object of exactly the limit less the envelope overhead seals and uploads; one byte more is refused and kept', async () => {
    const store = createFakeAttachmentStorage()
    const fits = new Uint8Array(MAX_OBJECT_BYTES - BINARY_ENVELOPE_OVERHEAD_BYTES).fill(1)
    const tooBig = new Uint8Array(MAX_OBJECT_BYTES - BINARY_ENVELOPE_OVERHEAD_BYTES + 1).fill(2)
    await putRaw(store, fits, 'fits')
    await putRaw(store, tooBig, 'too-big')
    const report = await clean(store)
    expect(report.converted).toEqual([await rawName(fits)])
    expect(store.objects.get(await keyedName(fits))?.length).toBe(MAX_OBJECT_BYTES)
    // The report names the sealed size the upload limits must reach.
    expect(report.refused).toEqual([{path: await rawName(tooBig), status: 413, sealedBytes: MAX_OBJECT_BYTES + 1}])
    expect(store.objects.has(await rawName(tooBig))).toBe(true)
    // Its bytes still exist in the raw object, so it is waiting, not unrecoverable.
    expect(report.proof).toEqual({
      kind: 'not-passed',
      rawRemaining: [await rawName(tooBig)],
      archivedRemaining: [],
      unverified: [await hashOf(tooBig)],
      unsettled: false,
    })
  }, 60_000)

  it('a corrupt object already at the keyed path is replaced, then the raw object is converted and deleted', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    await putRaw(store, photo, 'block-1')
    store.objects.set(await keyedName(photo), utf8('junk at the keyed name'))
    const report = await clean(store)
    expect(store.deletes).toEqual([await keyedName(photo), await rawName(photo)])
    expect(await holdsKeyed(store, photo)).toBe(true)
    expect(report.proof).toEqual({kind: 'passed', unrecoverable: []})
  })

  it('a genuine occupant at the keyed path is kept as it is', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    await putRaw(store, photo, 'block-1')
    const genuine = await seal(photo)
    store.objects.set(await keyedName(photo), genuine)
    await clean(store)
    expect(store.deletes).toEqual([await rawName(photo)])
    expect(store.objects.get(await keyedName(photo))).toEqual(genuine)
  })

  it('a keyed copy that reads back empty once is written again, never deleted', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    await putRaw(store, photo, 'block-1')
    const read = store.io.readObject
    let flaked = false
    vi.spyOn(store.io, 'readObject').mockImplementation(async path => {
      if (!flaked && path === (await keyedName(photo))) {
        flaked = true
        return null
      }
      return read(path)
    })
    await clean(store)
    expect(store.deletes).toEqual([await rawName(photo)])
    expect(await holdsKeyed(store, photo)).toBe(true)
  })

  it('never deletes the raw object when its keyed copy does not verify after upload', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    await putRaw(store, photo, 'block-1')
    // A store that accepts the upload but serves other bytes back.
    vi.spyOn(store.io, 'readObject').mockImplementation(async path =>
      path === (await keyedName(photo)) ? utf8('not what was uploaded') : (store.objects.get(path) ?? null),
    )
    const report = await clean(store)
    expect(store.objects.has(await rawName(photo))).toBe(true)
    expect(store.deletes).not.toContain(await rawName(photo))
    expect(report.proof).toMatchObject({kind: 'not-passed', rawRemaining: [await rawName(photo)]})
  })

  it('a neither object listed before a raw one never stops the raw one being converted', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    await putRaw(store, photo, 'block-1')
    const first = '0'.repeat(64) // sorts before the raw name
    store.objects.set(first, utf8('unidentified'))
    const failing = '1'.repeat(64)
    store.objects.set(failing, utf8('unreadable for now'))
    const read = store.io.readObject
    vi.spyOn(store.io, 'readObject').mockImplementation(async path => {
      if (path === failing) throw new Error('network')
      return read(path)
    })
    const report = await clean(store)
    expect(report.converted).toEqual([await rawName(photo)])
    expect(report.left).toEqual([{path: first, reason: 'not-archived'}])
    expect(report.errors).toEqual([{path: failing, message: 'network'}])
    // An object it could not read may be raw, so the proof waits for it.
    expect(report.proof).toMatchObject({kind: 'not-passed', rawRemaining: [failing]})
  })
})

describe('cleanAttachments: neither objects', () => {
  const nested = 'imports/0123'
  const bytes = utf8('a file someone put in a subfolder')

  it('a nested object is deleted, by its full path, only when the bundle archived those bytes', async () => {
    const store = createFakeAttachmentStorage()
    store.objects.set(nested, bytes)
    const report = await clean(store, createFakeBundle(new Map([[nested, bytes]])))
    expect(report.deleted).toEqual([nested])
    expect(store.deletes).toEqual([nested])
  })

  it('is left when no bundle archived it: a standalone run deletes no neither object', async () => {
    for (const bundle of [null, createFakeBundle()]) {
      const store = createFakeAttachmentStorage()
      store.objects.set(nested, bytes)
      const report = await clean(store, bundle)
      expect(report.left).toEqual([{path: nested, reason: 'not-archived'}])
      expect(store.deletes).toEqual([])
    }
  })

  it('is left when the archived entry holds other bytes, is missing, or the folder is unreadable', async () => {
    const mismatch = createFakeBundle(new Map([[nested, utf8('other bytes')]]))
    const missing: ConversionBundle = {...createFakeBundle(), archivedPaths: new Set([nested])}
    const unreadable = createFakeBundle(new Map([[nested, bytes]]))
    unreadable.readable = false
    const cases = [
      [mismatch, 'archive-mismatch'],
      [missing, 'archive-mismatch'],
      [unreadable, 'bundle-unreadable'],
    ] as const
    for (const [bundle, reason] of cases) {
      const store = createFakeAttachmentStorage()
      store.objects.set(nested, bytes)
      const report = await clean(store, bundle)
      expect(report.left).toEqual([{path: nested, reason}])
      expect(store.deletes).toEqual([])
    }
  })

  it('an archived object left in place, or whose delete did not take, holds the proof back', async () => {
    const unreadable = createFakeBundle(new Map([[nested, bytes]]))
    unreadable.readable = false
    const store = createFakeAttachmentStorage()
    store.objects.set(nested, bytes)
    expect((await clean(store, unreadable)).proof).toMatchObject({kind: 'not-passed', archivedRemaining: [nested]})

    const denied = createFakeAttachmentStorage()
    denied.objects.set(nested, bytes)
    vi.spyOn(denied.io, 'deleteObject').mockResolvedValue()
    const report = await clean(denied, createFakeBundle(new Map([[nested, bytes]])))
    expect(report.deleted).toEqual([])
    expect(report.proof).toMatchObject({kind: 'not-passed', archivedRemaining: [nested]})
  })

  it('a keyed object is kept even where a bundle archived the same bytes', async () => {
    // Its raw object listed AFTER it, so the keyed copy is classified, not placed.
    let orphan = utf8('orphan 0')
    for (let i = 1; (await keyedName(orphan)) > (await rawName(orphan)); i++) orphan = utf8(`orphan ${i}`)
    const store = createFakeAttachmentStorage()
    await putRaw(store, orphan)
    const sealed = await seal(orphan)
    store.objects.set(await keyedName(orphan), sealed)
    const report = await clean(store, createFakeBundle(new Map([[await keyedName(orphan), sealed]])))
    expect(store.deletes).toEqual([await rawName(orphan)])
    expect(report.left).toEqual([])
  })

  it('keeps the genuine keyed copy listed beside a raw orphan', async () => {
    const store = createFakeAttachmentStorage()
    const orphan = utf8('an orphan with its copy already up')
    await putRaw(store, orphan)
    store.objects.set(await keyedName(orphan), await seal(orphan))
    const report = await clean(store, createFakeBundle())
    expect(store.deletes).toEqual([await rawName(orphan)])
    expect(report.left).toEqual([])
    expect(await holdsKeyed(store, orphan)).toBe(true)
  })
})

describe('cleanAttachments: the proof', () => {
  it('rebuilds a corrupt object at an expected keyed name from this device\'s copy', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    store.media.push({blockId: 'block-1', contentHash: await hashOf(photo)})
    store.objects.set(await keyedName(photo), utf8('corrupt'))
    store.local.set(await rawName(photo), photo) // a pre-conversion local copy
    const report = await clean(store)
    expect(report.rebuilt).toEqual([await hashOf(photo)])
    expect(await holdsKeyed(store, photo)).toBe(true)
    expect(report.proof).toEqual({kind: 'passed', unrecoverable: []})
  })

  it('tries every local name: a damaged copy under the keyed name does not hide a good one under the raw name', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    store.media.push({blockId: 'block-1', contentHash: await hashOf(photo)})
    store.local.set(await keyedName(photo), utf8('truncat'))
    store.local.set(await rawName(photo), photo)
    const report = await clean(store)
    expect(report.rebuilt).toEqual([await hashOf(photo)])
    expect(await holdsKeyed(store, photo)).toBe(true)
  })

  it('the block\'s own plaintext, unsealed at its keyed name and nowhere else, is sealed in its place', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    store.media.push({blockId: 'block-1', contentHash: await hashOf(photo)})
    store.objects.set(await keyedName(photo), photo)
    const report = await clean(store)
    expect(report.rebuilt).toEqual([await hashOf(photo)])
    expect(await holdsKeyed(store, photo)).toBe(true)
    expect(store.objects.has(await rawName(photo))).toBe(false) // the staged copy is converted away
    expect(report.proof).toEqual({kind: 'passed', unrecoverable: []})
  })

  it('an only copy at the keyed name is written to its raw name before anything deletes it', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    store.media.push({blockId: 'block-1', contentHash: await hashOf(photo)})
    store.objects.set(await keyedName(photo), photo)
    // The sealed upload fails once the occupant is gone (tab closed, network).
    const write = store.io.writeObject
    vi.spyOn(store.io, 'writeObject').mockImplementation(async (path, bytes) => {
      if (path === (await keyedName(photo)) && !store.objects.has(path)) throw new Error('network')
      return write(path, bytes)
    })
    const report = await clean(store)
    expect(report.proof).toMatchObject({kind: 'not-passed', unverified: [await hashOf(photo)]})
    expect(store.objects.get(await rawName(photo))).toEqual(photo) // the bytes survive
  })

  it('a refused staging write is reported with the size the limits must reach, and nothing is deleted', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    store.media.push({blockId: 'block-1', contentHash: await hashOf(photo)})
    store.objects.set(await keyedName(photo), photo)
    const write = store.io.writeObject
    vi.spyOn(store.io, 'writeObject').mockImplementation(async (path, bytes) =>
      path === (await rawName(photo)) ? {kind: 'refused', status: 413} : write(path, bytes),
    )
    const report = await clean(store)
    expect(report.refused).toEqual([
      {path: await keyedName(photo), status: 413, sealedBytes: photo.length + BINARY_ENVELOPE_OVERHEAD_BYTES},
    ])
    expect(store.deletes).toEqual([])
    expect(report.proof).toMatchObject({kind: 'not-passed', unverified: [await hashOf(photo)]})
  })

  it('an only copy is never deleted when its raw name already holds other bytes', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    store.media.push({blockId: 'block-1', contentHash: await hashOf(photo)})
    store.objects.set(await keyedName(photo), photo)
    store.objects.set(await rawName(photo), utf8('a corrupt upload at the raw name'))
    const report = await clean(store)
    expect(store.objects.get(await keyedName(photo))).toEqual(photo)
    expect(report.proof).toMatchObject({kind: 'not-passed', unverified: [await hashOf(photo)]})
  })

  it('with a copy outside Storage, a plaintext occupant is replaced from that copy', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    store.media.push({blockId: 'block-1', contentHash: await hashOf(photo)})
    store.objects.set(await keyedName(photo), photo)
    store.local.set(await rawName(photo), photo)
    const write = vi.spyOn(store.io, 'writeObject')
    const report = await clean(store)
    expect(report.rebuilt).toEqual([await hashOf(photo)])
    expect(write.mock.calls.map(([path]) => path)).not.toContain(await rawName(photo))
  })

  it('an unverifiable object at a keyed name with no copy anywhere is kept and reported, never silently passed over', async () => {
    const store = createFakeAttachmentStorage()
    const lost = utf8('lost')
    store.media.push({blockId: 'block-1', contentHash: await hashOf(lost)})
    store.objects.set(await keyedName(lost), utf8('not this block\'s bytes, sealed or not'))
    const report = await clean(store)
    expect(store.deletes).toEqual([])
    expect(report.left).toEqual([{path: await keyedName(lost), reason: 'unverifiable'}])
    expect(report.proof).toEqual({kind: 'passed', unrecoverable: [{contentHash: await hashOf(lost), blockIds: ['block-1']}]})
  })

  it('a media object the final listing shows but a read finds nothing at is unverified, not unrecoverable', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    store.media.push({blockId: 'block-1', contentHash: await hashOf(photo)})
    store.objects.set(await keyedName(photo), await seal(photo))
    const read = store.io.readObject
    vi.spyOn(store.io, 'readObject').mockImplementation(async path => (path === (await keyedName(photo)) ? null : read(path)))
    const report = await clean(store)
    expect(report.proof).toMatchObject({kind: 'not-passed', unverified: [await hashOf(photo)]})
  })

  it('a rebuild Storage refuses is reported with the size the limits must reach', async () => {
    const store = createFakeAttachmentStorage({limit: 80})
    const big = new Uint8Array(64).fill(5) // seals to 100
    store.media.push({blockId: 'block-1', contentHash: await hashOf(big)})
    store.local.set(await rawName(big), big)
    const report = await clean(store)
    expect(report.refused).toEqual([{path: await keyedName(big), status: 413, sealedBytes: 100}])
    expect(report.proof).toMatchObject({kind: 'not-passed', unverified: [await hashOf(big)]})
  })

  it('a path the bundle archived counts as remaining only while it may still hold the archived bytes', async () => {
    // The bundle archived a corrupt occupant at what becomes a media block's keyed
    // name; converting the raw object replaces it with a verified copy.
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    await putRaw(store, photo, 'block-1')
    const corrupt = utf8('corrupt occupant')
    store.objects.set(await keyedName(photo), corrupt)
    const report = await clean(store, createFakeBundle(new Map([[await keyedName(photo), corrupt]])))
    expect(await holdsKeyed(store, photo)).toBe(true)
    expect(report.proof).toEqual({kind: 'passed', unrecoverable: []})
  })

  it('rebuilds a missing keyed object from the bundle', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    store.media.push({blockId: 'block-1', contentHash: await hashOf(photo)})
    const report = await clean(store, createFakeBundle(new Map(), new Map([[await hashOf(photo), photo]])))
    expect(report.rebuilt).toEqual([await hashOf(photo)])
    expect(await holdsKeyed(store, photo)).toBe(true)
  })

  it('a media block whose bytes exist nowhere: passed, with that block unrecoverable', async () => {
    const store = createFakeAttachmentStorage()
    const lost = utf8('lost')
    const hash = await hashOf(lost)
    store.media.push({blockId: 'block-a', contentHash: hash}, {blockId: 'block-b', contentHash: hash})
    // A local copy that doesn't hash to the block's hash is not a source.
    store.local.set(await rawName(lost), utf8('a different file'))
    for (const bundle of [null, createFakeBundle(new Map(), new Map(), new Set([hash]))]) {
      const report = await clean(store, bundle)
      expect(report.proof).toEqual({kind: 'passed', unrecoverable: [{contentHash: hash, blockIds: ['block-a', 'block-b']}]})
    }
    expect(store.objects.size).toBe(0)
  })

  it('a source that could not be read never makes a block unrecoverable: the proof waits', async () => {
    const lost = utf8('lost')
    const hash = await hashOf(lost)
    const unreadableLocal = createFakeAttachmentStorage()
    vi.spyOn(unreadableLocal.io, 'readLocal').mockRejectedValue(new Error('OPFS unavailable'))
    const unreadableBundle = createFakeBundle(new Map(), new Map(), new Set([hash]))
    unreadableBundle.readable = false
    // The manifest says the bundle holds it, but the entry is gone or corrupt.
    const missingEntry = createFakeBundle()
    const corruptEntry = createFakeBundle(new Map(), new Map([[hash, utf8('not it')]]))
    const cases: [FakeAttachmentStorage, ConversionBundle | null][] = [
      [unreadableLocal, null],
      [createFakeAttachmentStorage(), unreadableBundle],
      [createFakeAttachmentStorage(), missingEntry],
      [createFakeAttachmentStorage(), corruptEntry],
    ]
    for (const [store, bundle] of cases) {
      store.media.push({blockId: 'block-a', contentHash: hash})
      const report = await clean(store, bundle)
      expect(report.proof).toMatchObject({kind: 'not-passed', unverified: [hash]})
      expect(store.objects.size).toBe(0) // nothing is uploaded from a copy that didn't verify
    }
  })

  it('a keyed object sealed under another key is not proof: it is replaced from a verified copy', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    store.media.push({blockId: 'block-1', contentHash: await hashOf(photo)})
    store.objects.set(await keyedName(photo), await seal(photo, otherKeys))
    store.local.set(await rawName(photo), photo) // a pre-conversion local copy
    const report = await clean(store)
    expect(report.rebuilt).toEqual([await hashOf(photo)])
    expect(await holdsKeyed(store, photo)).toBe(true)
  })
})

describe('cleanAttachments: runs', () => {
  it('resumes after a crash between the upload and the raw delete', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    await putRaw(store, photo, 'block-1')
    const remove = store.io.deleteObject
    const crash = vi.spyOn(store.io, 'deleteObject').mockRejectedValueOnce(new Error('tab closed'))
    const first = await clean(store)
    expect(first.proof).toMatchObject({kind: 'not-passed', rawRemaining: [await rawName(photo)]})
    expect(await holdsKeyed(store, photo)).toBe(true)
    crash.mockImplementation(remove)
    const second = await clean(store)
    expect(second.converted).toEqual([await rawName(photo)])
    expect(second.proof).toEqual({kind: 'passed', unrecoverable: []})
  })

  it('a standalone run after the conversion converts a late raw object and deletes nothing else', async () => {
    const store = createFakeAttachmentStorage()
    const old = utf8('converted long ago')
    const late = utf8('uploaded by an older client')
    store.media.push({blockId: 'old', contentHash: await hashOf(old)})
    store.objects.set(await keyedName(old), await seal(old))
    await putRaw(store, late, 'late')
    const stray = 'f'.repeat(64)
    store.objects.set(stray, utf8('kept from an old key'))
    const report = await clean(store, null)
    expect(store.deletes).toEqual([await rawName(late)])
    expect(report.left).toEqual([{path: stray, reason: 'not-archived'}])
    expect(report.proof).toEqual({kind: 'passed', unrecoverable: []})
  })

  it('a folder another writer keeps adding to is unsettled, and its report is taken after its own deletes', async () => {
    const store = createFakeAttachmentStorage()
    const list = store.io.listObjects
    let n = 0
    vi.spyOn(store.io, 'listObjects').mockImplementation(async () => {
      await putRaw(store, utf8(`late upload ${n++}`)) // a new raw object before every listing
      return list()
    })
    const report = await clean(store)
    expect(report.proof).toMatchObject({kind: 'not-passed', unsettled: true})
    expect(report.converted.length).toBeGreaterThan(1)
    expect(report.errors).toEqual([])
  })

  it('a listing that loses objects the run saw (RLS filtering it after a session lapse) fails the proof', async () => {
    const store = createFakeAttachmentStorage({limit: 80})
    const photo = utf8('a photo') // seals to 43 bytes
    const tooBig = new Uint8Array(64).fill(2) // seals to 100: refused
    await putRaw(store, photo, 'block-1')
    await putRaw(store, tooBig)
    const list = store.io.listObjects
    let calls = 0
    vi.spyOn(store.io, 'listObjects').mockImplementation(async signal => (calls++ === 0 ? list(signal) : []))
    const report = await clean(store)
    expect(store.objects.has(await rawName(tooBig))).toBe(true)
    expect(report.proof).toMatchObject({kind: 'not-passed', unsettled: true})
  })

  it('a copy this run placed counts only if the final listing still holds it', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    await putRaw(store, photo, 'block-1')
    store.local.set(await rawName(photo), photo)
    const list = store.io.listObjects
    let calls = 0
    vi.spyOn(store.io, 'listObjects').mockImplementation(async signal => {
      if (calls++ === 2) store.objects.delete(await keyedName(photo)) // gone before the final listing
      return list(signal)
    })
    const report = await clean(store)
    expect(report.proof).toMatchObject({kind: 'not-passed', unsettled: true})
    // Not taken as kept on the run's word: rebuilt from this device's copy.
    expect(report.rebuilt).toEqual([await hashOf(photo)])
    expect(await holdsKeyed(store, photo)).toBe(true)
  })

  it('an object that appears after the last pass may be raw: the proof waits for it', async () => {
    const store = createFakeAttachmentStorage()
    const late = utf8('arrived during the proof')
    const list = store.io.listObjects
    let calls = 0
    vi.spyOn(store.io, 'listObjects').mockImplementation(async signal => {
      if (calls++ === 1) await putRaw(store, late) // just before the final listing
      return list(signal)
    })
    const report = await clean(store)
    expect(report.proof).toMatchObject({kind: 'not-passed', rawRemaining: [await rawName(late)]})
  })

  it('never reads or deletes a name a read and a delete would address differently', async () => {
    const store = createFakeAttachmentStorage()
    const odd = ['x?y', 'dir/a b', 'a//b', 'dir/../elsewhere', './x']
    for (const path of odd) store.objects.set(path, utf8(path))
    const read = vi.spyOn(store.io, 'readObject')
    const report = await clean(store, createFakeBundle(new Map(odd.map(path => [path, utf8(path)]))))
    expect(read).not.toHaveBeenCalled()
    expect(store.deletes).toEqual([])
    expect(report.left).toEqual(expect.arrayContaining(odd.map(path => ({path, reason: 'unaddressable'}))))
  })

  it('refuses to start under a key that does not open the canary, touching nothing', async () => {
    const store = createFakeAttachmentStorage()
    await putRaw(store, utf8('a photo'), 'block-1')
    const write = vi.spyOn(store.io, 'writeObject')
    await expect(clean(store, null, {...otherKeys, canary: keys.canary})).rejects.toBeInstanceOf(ConversionRefusal)
    expect(write).not.toHaveBeenCalled()
    expect(store.deletes).toEqual([])
  })

  it('an object listed but read as absent is not known to be clean: the proof waits for it', async () => {
    const store = createFakeAttachmentStorage()
    const hidden = 'a'.repeat(64)
    store.objects.set(hidden, utf8('a raw object a denied read hides'))
    const read = store.io.readObject
    vi.spyOn(store.io, 'readObject').mockImplementation(async path => (path === hidden ? null : read(path)))
    const report = await clean(store)
    expect(report.proof).toMatchObject({kind: 'not-passed', rawRemaining: [hidden]})
    expect(store.deletes).toEqual([])
  })

  it('reports a delete that did not take, and the proof waits for it', async () => {
    const store = createFakeAttachmentStorage()
    const photo = utf8('a photo')
    await putRaw(store, photo, 'block-1')
    // Storage answers a denied delete as success with nothing removed.
    vi.spyOn(store.io, 'deleteObject').mockResolvedValue()
    const report = await clean(store)
    expect(report.converted).toEqual([])
    expect(report.errors).toEqual([{path: await rawName(photo), message: 'deleted, but still listed'}])
    expect(report.proof).toMatchObject({kind: 'not-passed', rawRemaining: [await rawName(photo)]})
  })
})
