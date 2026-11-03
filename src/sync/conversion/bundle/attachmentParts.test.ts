import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BINARY_ENVELOPE_OVERHEAD_BYTES } from '../../crypto/binaryEnvelope.js'
import { computeContentHash } from '../../crypto/contentHash.js'
import { mediaPropertiesJson } from '../test/conversionFixtures.js'
import { createFakeAttachmentStorage, fakeMediaHashOf, type FakeAttachmentStorage } from '../test/fakeAttachmentStorage.js'
import { MemoryBundleFolder } from '../test/memoryBundleFolder.js'
import {
  MediaBlocks,
  ListedObjectUnreadable,
  otherObjectNameOf,
  rawNameOf,
  surveyAttachments,
  verifiedCopy,
  writeAttachmentParts,
} from './attachmentParts.js'
import { sha256Hex } from './bundleParts.js'

const noSleep = async () => {}
const listedOf = (...names: string[]) => new Set<string>(names)

const bytesOf = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)
const text = (bytes: Uint8Array | null | undefined) => (bytes ? new TextDecoder().decode(bytes) : null)

let storage: FakeAttachmentStorage

beforeEach(() => {
  storage = createFakeAttachmentStorage()
})

describe('MediaBlocks', () => {
  it('collects the ids of every block carrying a hash, ignoring rows that are not media', () => {
    const blocks = new MediaBlocks(fakeMediaHashOf)
    blocks.add({id: 'a', properties_json: mediaPropertiesJson('sha256:aa')})
    blocks.add({id: 'b', properties_json: mediaPropertiesJson('sha256:bb')})
    blocks.add({id: 'c', properties_json: mediaPropertiesJson('sha256:aa')})
    blocks.add({id: 'plain', properties_json: JSON.stringify({types: ['page']})})
    blocks.add({id: 'broken', properties_json: 'not json {'})

    expect([...blocks.hashes()].sort()).toEqual(['sha256:aa', 'sha256:bb'])
    expect(blocks.blocksOf(['sha256:aa', 'sha256:bb'])).toEqual([
      {contentHash: 'sha256:aa', blockIds: ['a', 'c']},
      {contentHash: 'sha256:bb', blockIds: ['b']},
    ])
  })
})

describe('verifiedCopy', () => {
  const setup = async (content: string) => {
    const bytes = bytesOf(content)
    const hash = await computeContentHash(bytes)
    return {bytes, hash, name: rawNameOf(hash)}
  }
  const copyOf = (hash: string, listed: ReadonlySet<string>) => verifiedCopy(storage.io, hash, listed, {sleep: noSleep})

  it('prefers a local copy that verifies, without reading Storage', async () => {
    const {bytes, hash, name} = await setup('the bytes')
    storage.local.set(name, bytes)
    storage.objects.set(name, bytes)
    const readObject = vi.spyOn(storage.io, 'readObject')

    const copy = await copyOf(hash, listedOf(name))

    expect(text(copy?.bytes)).toBe('the bytes')
    expect(copy?.from).toBe('local')
    expect(readObject).not.toHaveBeenCalled()
  })

  it('falls back to a listed Storage object when there is no local copy', async () => {
    const {bytes, hash, name} = await setup('remote bytes')
    storage.objects.set(name, bytes)

    const copy = await copyOf(hash, listedOf(name))

    expect(text(copy?.bytes)).toBe('remote bytes')
    expect(copy?.from).toBe('storage')
  })

  it('falls through to Storage when the local copy does not verify', async () => {
    const {bytes, hash, name} = await setup('good bytes')
    storage.local.set(name, bytesOf('corrupt local'))
    storage.objects.set(name, bytes)

    const copy = await copyOf(hash, listedOf(name))

    expect(text(copy?.bytes)).toBe('good bytes')
    expect(copy?.from).toBe('storage')
  })

  it('returns null without reading Storage when the raw name is not listed', async () => {
    const {bytes, hash, name} = await setup('unlisted')
    storage.objects.set(name, bytes)
    const readObject = vi.spyOn(storage.io, 'readObject')

    expect(await copyOf(hash, listedOf())).toBeNull()
    expect(readObject).not.toHaveBeenCalled()
  })

  it('returns null when neither copy verifies, and keeps nothing', async () => {
    const {hash, name} = await setup('wanted')
    storage.local.set(name, bytesOf('wrong local'))
    storage.objects.set(name, bytesOf('wrong remote'))

    expect(await copyOf(hash, listedOf(name))).toBeNull()
    expect(text(storage.local.get(name))).toBe('wrong local')
  })

  it('throws ListedObjectUnreadable for a listed name that reads as absent', async () => {
    const {hash, name} = await setup('vanished')

    await expect(copyOf(hash, listedOf(name))).rejects.toEqual(new ListedObjectUnreadable(name))
  })

  it('reads neither store for a malformed hash', async () => {
    const malformed = `sha256:${'a'.repeat(300)}`
    const readLocal = vi.spyOn(storage.io, 'readLocal')
    const readObject = vi.spyOn(storage.io, 'readObject')

    expect(await copyOf(malformed, listedOf(rawNameOf(malformed)))).toBeNull()
    expect(readLocal).not.toHaveBeenCalled()
    expect(readObject).not.toHaveBeenCalled()
  })

  it('retries a transient read failure', async () => {
    const {bytes, hash, name} = await setup('flaky')
    storage.objects.set(name, bytes)
    const readObject = vi.spyOn(storage.io, 'readObject')
    readObject.mockRejectedValueOnce(new Error('blip')).mockRejectedValueOnce(new Error('blip'))

    expect(text((await copyOf(hash, listedOf(name)))?.bytes)).toBe('flaky')
    expect(readObject).toHaveBeenCalledTimes(3)
  })

  it('rethrows after three failed reads', async () => {
    const {hash, name} = await setup('down')
    const readObject = vi.spyOn(storage.io, 'readObject').mockRejectedValue(new Error('storage down'))

    await expect(copyOf(hash, listedOf(name))).rejects.toThrow('storage down')
    expect(readObject).toHaveBeenCalledTimes(3)
  })
})

describe('surveyAttachments', () => {
  const media = async (content: string, at: {local?: boolean; remote?: boolean}) => {
    const bytes = bytesOf(content)
    const hash = await computeContentHash(bytes)
    if (at.local) storage.local.set(rawNameOf(hash), bytes)
    if (at.remote) storage.objects.set(rawNameOf(hash), bytes)
    return {bytes, hash}
  }
  const survey = (mediaHashes: string[], extra: Partial<Parameters<typeof surveyAttachments>[0]> = {}) =>
    surveyAttachments({source: storage.io, mediaHashes: new Set(mediaHashes), keepBudget: null, sleep: noSleep, ...extra})

  it('keeps Storage-only copies locally, leaves local copies alone, and reports sizes and the missing', async () => {
    const remoteOnly = await media('remote only!', {remote: true})
    const local = await media('local', {local: true})
    const lost = await media('lost', {})
    storage.objects.set(rawNameOf(lost.hash), bytesOf('swapped'))
    storage.objects.set('nested/other', bytesOf('12345'))
    const writeLocal = vi.spyOn(storage.io, 'writeLocal')

    const result = await survey([remoteOnly.hash, local.hash, lost.hash])

    expect(text(storage.local.get(rawNameOf(remoteOnly.hash)))).toBe('remote only!')
    expect(writeLocal.mock.calls.map(([name]) => name)).toEqual([rawNameOf(remoteOnly.hash)])
    expect(result.noVerifiedSource).toEqual([lost.hash])
    // 12 + 5 media bytes, 5 for the other object; the swapped object keeps its media name and is not counted.
    expect(result.bundleBytes).toBe(22)
    expect(result.unkeptBytes).toBe(0)
    expect(result.oversized).toEqual([])
  })

  it('stops keeping when the budget runs out but still measures the rest', async () => {
    const a = await media('aaaaaaaa', {remote: true}) // 8 bytes
    const b = await media('bbbbbbbbbb', {remote: true}) // 10
    const c = await media('cc', {remote: true}) // 2: would fit the remaining budget but keeping already stopped
    const [first, second, third] = [a, b, c].sort((x, y) => (x.hash < y.hash ? -1 : 1))

    const result = await survey([a.hash, b.hash, c.hash], {keepBudget: first.bytes.length + second.bytes.length - 1})

    expect(storage.local.has(rawNameOf(first.hash))).toBe(true)
    expect(storage.local.has(rawNameOf(second.hash))).toBe(false)
    expect(storage.local.has(rawNameOf(third.hash))).toBe(false)
    expect(result.unkeptBytes).toBe(second.bytes.length + third.bytes.length)
    // What was left when keeping stopped: the shortfall is the rest.
    expect(result.spareBytes).toBe(second.bytes.length - 1)
    expect(result.bundleBytes).toBe(20)
    expect(result.noVerifiedSource).toEqual([])
  })

  it('counts a copy as unkept when the store is full, and goes on', async () => {
    const a = await media('first!', {remote: true})
    const b = await media('second', {remote: true})
    const writeLocal = vi.spyOn(storage.io, 'writeLocal').mockRejectedValue(new DOMException('full', 'QuotaExceededError'))

    const result = await survey([a.hash, b.hash])

    expect(result.unkeptBytes).toBe(12)
    expect(result.bundleBytes).toBe(12)
    // The first refusal ends the keeping.
    expect(writeLocal).toHaveBeenCalledTimes(1)
  })

  it('propagates any other writeLocal error', async () => {
    const a = await media('first!', {remote: true})
    vi.spyOn(storage.io, 'writeLocal').mockRejectedValue(new Error('disk on fire'))

    await expect(survey([a.hash])).rejects.toThrow('disk on fire')
  })

  it('lists a media hash and a raw orphan whose sealed size passes the limit, but not a differently named object', async () => {
    const limit = 100
    const big = await media('x'.repeat(limit), {local: true})
    const orphan = bytesOf('o'.repeat(limit))
    storage.objects.set(sha256Hex(orphan), orphan)
    storage.objects.set('backups/big.bin', bytesOf('b'.repeat(limit)))

    const result = await survey([big.hash], {limit})

    expect(result.oversized).toEqual(expect.arrayContaining([
      {what: big.hash, sealedBytes: limit + BINARY_ENVELOPE_OVERHEAD_BYTES},
      {what: sha256Hex(orphan), sealedBytes: limit + BINARY_ENVELOPE_OVERHEAD_BYTES},
    ]))
    expect(result.oversized).toHaveLength(2)
    expect(result.bundleBytes).toBe(limit * 3)
  })

  it('does not list a media hash that exactly fits', async () => {
    const limit = 100
    const fits = await media('y'.repeat(limit - BINARY_ENVELOPE_OVERHEAD_BYTES), {local: true})

    expect((await survey([fits.hash], {limit})).oversized).toEqual([])
  })

  it('neither reads nor counts an unaddressable path', async () => {
    storage.objects.set('dir/a b', bytesOf('spaced'))
    storage.objects.set('dir/../up', bytesOf('dots'))
    storage.objects.set('fine', bytesOf('ok'))
    const readObject = vi.spyOn(storage.io, 'readObject')

    const result = await survey([])

    expect(readObject.mock.calls.map(([path]) => path)).toEqual(['fine'])
    expect(result.bundleBytes).toBe(2)
  })

  it('counts an object whose name only a malformed media hash ends in', async () => {
    storage.objects.set('orphan', bytesOf('12345'))

    const result = await survey(['notsha:orphan'])

    expect(result.noVerifiedSource).toEqual(['notsha:orphan'])
    expect(result.bundleBytes).toBe(5)
  })

  it('throws ListedObjectUnreadable when a listed other object reads as absent', async () => {
    storage.objects.set('ghost', bytesOf('x'))
    vi.spyOn(storage.io, 'readObject').mockResolvedValue(null)

    await expect(survey([])).rejects.toEqual(new ListedObjectUnreadable('ghost'))
  })

  it('ticks progress once per media hash and per other object, ending at the total', async () => {
    const a = await media('one', {local: true})
    const b = await media('two', {remote: true})
    storage.objects.set('other/x', bytesOf('x'))
    const ticks: {checked: number; total: number}[] = []

    await survey([a.hash, b.hash], {onProgress: progress => ticks.push(progress)})

    expect(ticks).toEqual([{checked: 1, total: 3}, {checked: 2, total: 3}, {checked: 3, total: 3}])
  })
})

describe('writeAttachmentParts', () => {
  const write = (options: Partial<Parameters<typeof writeAttachmentParts>[0]> = {}) =>
    writeAttachmentParts({
      folder: new MemoryBundleFolder(),
      source: storage.io,
      mediaHashes: new Set(),
      sleep: noSleep,
      ...options,
    })

  it('collects a media hash with no verified copy as missing and writes the others', async () => {
    const lost = await computeContentHash(bytesOf('vanished'))
    const kept = bytesOf('kept bytes')
    const keptHash = await computeContentHash(kept)
    storage.local.set(rawNameOf(keptHash), kept)
    const folder = new MemoryBundleFolder()

    const parts = await write({folder, mediaHashes: new Set([lost, keptHash])})

    expect(parts.missing).toEqual([lost])
    expect([...folder.folders.get('attachments')!.files.keys()]).toEqual([rawNameOf(keptHash)])
    expect(text(folder.folders.get('attachments')!.files.get(rawNameOf(keptHash)))).toBe('kept bytes')
  })

  it('archives an object whose name only a malformed media hash ends in', async () => {
    storage.objects.set('orphan', bytesOf('orphan bytes'))

    const parts = await write({mediaHashes: new Set(['notsha:orphan'])})

    expect(parts.missing).toEqual(['notsha:orphan'])
    expect(parts.otherObjects.map(entry => entry.path)).toEqual(['orphan'])
  })

  it('writes Storage-only media and other objects with their digests', async () => {
    const remote = bytesOf('remote media')
    const remoteHash = await computeContentHash(remote)
    storage.objects.set(rawNameOf(remoteHash), remote)
    storage.objects.set('nested/thing', bytesOf('nested bytes'))
    const folder = new MemoryBundleFolder()

    const parts = await write({folder, mediaHashes: new Set([remoteHash])})

    expect(parts.missing).toEqual([])
    expect(text(folder.folders.get('attachments')!.files.get(rawNameOf(remoteHash)))).toBe('remote media')
    expect(parts.otherObjects).toEqual([
      {name: otherObjectNameOf('nested/thing'), path: 'nested/thing', sha256: sha256Hex(bytesOf('nested bytes')), bytes: 12},
    ])
    expect(otherObjectNameOf('nested/thing')).toBe(sha256Hex(bytesOf('nested/thing')))
    expect(text(folder.folders.get('other-objects')!.files.get(otherObjectNameOf('nested/thing')))).toBe('nested bytes')
  })

  it('skips an unaddressable path', async () => {
    storage.objects.set('dir/a b', bytesOf('spaced'))
    const folder = new MemoryBundleFolder()

    const parts = await write({folder})

    expect(parts.otherObjects).toEqual([])
    expect(folder.folders.get('other-objects')!.files.size).toBe(0)
  })

  it('throws when a listed other object reads as absent', async () => {
    storage.objects.set('here', bytesOf('x'))
    vi.spyOn(storage.io, 'readObject').mockResolvedValue(null)

    await expect(write()).rejects.toEqual(new ListedObjectUnreadable('here'))
  })

  it('throws when a listed media object reads as absent', async () => {
    const hash = await computeContentHash(bytesOf('vanishing'))
    storage.objects.set(rawNameOf(hash), bytesOf('vanishing'))
    vi.spyOn(storage.io, 'readObject').mockResolvedValue(null)

    await expect(write({mediaHashes: new Set([hash])})).rejects.toEqual(new ListedObjectUnreadable(rawNameOf(hash)))
  })
})
