import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_OBJECT_BYTES } from '../../byteTransform.js'
import { BINARY_ENVELOPE_OVERHEAD_BYTES } from '../../crypto/binaryEnvelope.js'
import { computeContentHash } from '../../crypto/contentHash.js'
import { mediaPropertiesJson } from '../test/conversionFixtures.js'
import { createFakeAttachmentStorage, fakeMediaHashOf, type FakeAttachmentStorage } from '../test/fakeAttachmentStorage.js'
import { MemoryBundleFolder } from '../test/memoryBundleFolder.js'
import {
  MediaBlocks,
  MissingAttachment,
  rawNameOf,
  surveyAttachments,
  verifiedCopy,
  writeAttachmentParts,
} from './attachmentParts.js'
import { sha256Hex } from './bundleParts.js'

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

  it('reports no block ids for a hash it never saw', () => {
    expect(new MediaBlocks(fakeMediaHashOf).blocksOf(['sha256:zz'])).toEqual([{contentHash: 'sha256:zz', blockIds: []}])
  })
})

describe('verifiedCopy', () => {
  const setup = async (content: string) => {
    const bytes = bytesOf(content)
    const hash = await computeContentHash(bytes)
    return {bytes, hash, name: rawNameOf(hash)}
  }

  it('prefers a local copy that verifies', async () => {
    const {bytes, hash, name} = await setup('the bytes')
    storage.local.set(name, bytes)
    const readObject = vi.spyOn(storage.io, 'readObject')

    expect(text(await verifiedCopy(storage.io, hash))).toBe('the bytes')
    expect(readObject).not.toHaveBeenCalled()
  })

  it('falls back to Storage when there is no local copy', async () => {
    const {bytes, hash, name} = await setup('remote bytes')
    storage.objects.set(name, bytes)

    expect(text(await verifiedCopy(storage.io, hash))).toBe('remote bytes')
  })

  it('falls through to Storage when the local copy does not verify', async () => {
    const {bytes, hash, name} = await setup('good bytes')
    storage.local.set(name, bytesOf('corrupt local'))
    storage.objects.set(name, bytes)

    expect(text(await verifiedCopy(storage.io, hash))).toBe('good bytes')
  })

  it('returns null when neither copy verifies', async () => {
    const {hash, name} = await setup('wanted')
    storage.local.set(name, bytesOf('wrong local'))
    storage.objects.set(name, bytesOf('wrong remote'))

    expect(await verifiedCopy(storage.io, hash)).toBeNull()
  })

  it('keeps a verified Storage copy locally only when asked', async () => {
    const {bytes, hash, name} = await setup('keep me')
    storage.objects.set(name, bytes)

    await verifiedCopy(storage.io, hash)
    expect(storage.local.has(name)).toBe(false)

    await verifiedCopy(storage.io, hash, {keep: true})
    expect(text(storage.local.get(name))).toBe('keep me')
  })

  it('never keeps an unverified Storage copy', async () => {
    const {hash, name} = await setup('wanted')
    storage.objects.set(name, bytesOf('swapped'))

    expect(await verifiedCopy(storage.io, hash, {keep: true})).toBeNull()
    expect(storage.local.has(name)).toBe(false)
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

  it('with preflight, keeps verified Storage copies locally and reports sizes and the missing', async () => {
    const remoteOnly = await media('remote only!', {remote: true})
    const local = await media('local', {local: true})
    const lost = await media('lost', {})
    storage.objects.set(rawNameOf(lost.hash), bytesOf('swapped'))
    storage.objects.set('nested/other', bytesOf('12345'))

    const survey = await surveyAttachments({
      source: storage.io,
      mediaHashes: new Set([remoteOnly.hash, local.hash, lost.hash]),
      preflight: true,
    })

    expect(text(storage.local.get(rawNameOf(remoteOnly.hash)))).toBe('remote only!')
    expect(survey.verified).toEqual(new Map([[remoteOnly.hash, 12], [local.hash, 5]]))
    expect(survey.noVerifiedSource).toEqual([lost.hash])
    expect(survey.otherObjects).toEqual(['nested/other'])
    expect(survey.mediaBytes).toBe(17)
    expect(survey.otherBytes).toBe(5)
    expect(survey.oversized).toEqual([])
  })

  it('without preflight, writes nothing locally and never reads the other objects', async () => {
    const remoteOnly = await media('remote only', {remote: true})
    storage.objects.set('nested/other', bytesOf('12345'))
    const readObject = vi.spyOn(storage.io, 'readObject')

    const survey = await surveyAttachments({source: storage.io, mediaHashes: new Set([remoteOnly.hash]), preflight: false})

    expect(storage.local.size).toBe(0)
    expect(readObject.mock.calls.map(([path]) => path)).toEqual([rawNameOf(remoteOnly.hash)])
    expect(survey.otherObjects).toEqual(['nested/other'])
    expect(survey.otherBytes).toBe(0)
    expect(survey.mediaBytes).toBe(11)
  })

  // One 50 MiB buffer is hashed (about 0.3 s alone, several times that under load).
  it('lists a media hash whose plaintext cannot be sealed within the limit', async () => {
    const big = new Uint8Array(MAX_OBJECT_BYTES - BINARY_ENVELOPE_OVERHEAD_BYTES + 1).fill(7)
    const hash = await computeContentHash(big)
    storage.local.set(rawNameOf(hash), big)

    const survey = await surveyAttachments({source: storage.io, mediaHashes: new Set([hash]), preflight: false})

    expect(survey.oversized).toEqual([{what: hash, sealedBytes: big.length + BINARY_ENVELOPE_OVERHEAD_BYTES}])
    expect(survey.verified.get(hash)).toBe(big.length)
  }, 30_000)

  it('does not list a media hash that exactly fits', async () => {
    const fits = new Uint8Array(MAX_OBJECT_BYTES - BINARY_ENVELOPE_OVERHEAD_BYTES).fill(3)
    const hash = await computeContentHash(fits)
    storage.local.set(rawNameOf(hash), fits)

    const survey = await surveyAttachments({source: storage.io, mediaHashes: new Set([hash]), preflight: false})

    expect(survey.oversized).toEqual([])
  }, 30_000)

  // One 50 MiB buffer stored under two names, hashed once per read (several seconds under load).
  it('lists a too-big raw orphan but not a too-big object with another name', async () => {
    const big = new Uint8Array(MAX_OBJECT_BYTES - BINARY_ENVELOPE_OVERHEAD_BYTES + 1).fill(9)
    const orphanName = sha256Hex(big)
    storage.objects.set(orphanName, big)
    storage.objects.set('backups/big.bin', big)

    const survey = await surveyAttachments({source: storage.io, mediaHashes: new Set(), preflight: true})

    expect(survey.oversized).toEqual([{what: orphanName, sealedBytes: big.length + BINARY_ENVELOPE_OVERHEAD_BYTES}])
    expect([...survey.otherObjects].sort()).toEqual(['backups/big.bin', orphanName].sort())
    expect(survey.otherBytes).toBe(big.length * 2)
  }, 30_000)

  it('does not read a raw orphan\'s size without preflight', async () => {
    storage.objects.set('x', bytesOf('x'))
    const readObject = vi.spyOn(storage.io, 'readObject')

    await surveyAttachments({source: storage.io, mediaHashes: new Set(), preflight: false})

    expect(readObject).not.toHaveBeenCalled()
  })
})

describe('writeAttachmentParts', () => {
  const write = (options: Partial<Parameters<typeof writeAttachmentParts>[0]> = {}) =>
    writeAttachmentParts({
      folder: new MemoryBundleFolder(),
      source: storage.io,
      mediaHashes: new Set(),
      noVerifiedSource: new Set(),
      otherObjects: [],
      ...options,
    })

  it('throws MissingAttachment for a media hash that lost its verified copy', async () => {
    const hash = await computeContentHash(bytesOf('vanished'))

    await expect(write({mediaHashes: new Set([hash])})).rejects.toEqual(new MissingAttachment(hash))
    await expect(write({mediaHashes: new Set([hash])})).rejects.toMatchObject({name: 'MissingAttachment', contentHash: hash})
  })

  it('skips a hash the user confirmed has no source', async () => {
    const hash = await computeContentHash(bytesOf('vanished'))
    const folder = new MemoryBundleFolder()

    expect(await write({folder, mediaHashes: new Set([hash]), noVerifiedSource: new Set([hash])})).toEqual([])
    expect([...folder.folders.get('attachments')!.files.keys()]).toEqual([])
  })

  it('skips an other object that vanished since it was listed', async () => {
    storage.objects.set('here', bytesOf('still here'))
    const folder = new MemoryBundleFolder()

    const entries = await write({folder, otherObjects: ['gone', 'here']})

    expect(entries).toEqual([
      {name: sha256Hex(bytesOf('here')), path: 'here', sha256: sha256Hex(bytesOf('still here')), bytes: 10},
    ])
    expect(folder.folders.get('other-objects')!.files.size).toBe(1)
  })
})
