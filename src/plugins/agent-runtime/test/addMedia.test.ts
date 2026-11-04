// @vitest-environment happy-dom
import {base64} from '@scure/base'
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import type {Repo} from '@/data/repo'
import type {BlobStore} from '@/plugins/attachments/blobStore'
import {InMemoryByteStore} from '@/plugins/attachments/byteStore'
import {kernelPageBlockId} from '@/data/kernelPage'
import {
  ASSETS_NS,
  ASSETS_TYPE_CONTRIBUTION,
  MEDIA_PROPERTY_SCHEMAS,
  MEDIA_TYPE_CONTRIBUTION,
  mediaHashProp,
  mediaMimeProp,
  mediaSizeProp,
  resolveCaptureMime,
} from '@/plugins/attachments/mediaBlock'
import {captureMedia} from '@/plugins/attachments/mediaCapture'
import {createAssetResolver} from '@/plugins/attachments/resolver'
import {InMemoryByteUploadStore} from '@/plugins/attachments/uploadStore'
import {computeContentHash} from '@/sync/crypto/contentHash'
import {addMedia, type MediaCapture} from '../addMedia'
import {createAgentRuntimeContext, executeCommand} from '../commands'
import type {AgentRuntimeContext} from '../protocol'
import {readMedia} from '../readMedia'


const WS = 'ws'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
const PDF = new TextEncoder().encode('%PDF-1.4 hello')
const SECRET = new TextEncoder().encode('-----BEGIN OPENSSH PRIVATE KEY-----')

let db: TestDb
let repo: Repo
let context: AgentRuntimeContext
let byteStore: InMemoryByteStore
let capture: MediaCapture
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

beforeEach(async () => {
  await resetTestDb(db.db)
  const created = createTestRepo({db: db.db, user: {id: 'vlad', name: 'Vlad'}})
  repo = created.repo
  const runtime = resolveFacetRuntimeSync([
    staticDataExtensions,
    typeSeedsFacet.of(MEDIA_TYPE_CONTRIBUTION, {source: 'test'}),
    typeSeedsFacet.of(ASSETS_TYPE_CONTRIBUTION, {source: 'test'}),
    MEDIA_PROPERTY_SCHEMAS.map(schema => definitionSeedsFacet.of(schema, {source: 'test'})),
  ], {repo, workspaceId: WS, safeMode: false})
  repo.setFacetRuntime(runtime)
  repo.setActiveWorkspaceId(WS)
  context = createAgentRuntimeContext({repo, runtime, safeMode: false})
  byteStore = new InMemoryByteStore()
  // The real capture, over in-memory stores: what the block and byte store end up holding is the point.
  const deps = {
    repo,
    byteStore,
    uploadStore: new InMemoryByteUploadStore(() => 1000),
    getUserId: () => 'vlad',
    getMaterializability: async () => 'copy' as const,
    getContentKeyHmac: async () => null,
    drain: () => {},
  }
  capture = async file => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    return captureMedia({
      workspaceId: WS,
      source: {bytes, mime: resolveCaptureMime(file.type, bytes), filename: file.name || undefined},
    }, deps)
  }
})

const input = (bytes: Uint8Array, over: Record<string, unknown> = {}) => ({base64: base64.encode(bytes), ...over})

describe('addMedia', () => {
  it('stores the bytes as a media block under Assets, and hands back how to place it', async () => {
    const added = await addMedia(WS, input(PNG, {filename: 'shot.png'}), capture)

    expect(added).toEqual({id: added.id, deduped: false, reference: `((${added.id}))`})
    const block = await repo.load(added.id)
    expect(block).toMatchObject({
      content: 'shot.png',
      workspaceId: WS,
      parentId: kernelPageBlockId(WS, ASSETS_NS),
    })
    expect(block?.properties).toMatchObject({
      [mediaHashProp.name]: await computeContentHash(PNG),
      [mediaMimeProp.name]: 'image/png',
      [mediaSizeProp.name]: PNG.length,
    })
  })

  it('round-trips: what was added reads back byte for byte', async () => {
    const added = await addMedia(WS, input(PDF, {filename: 'a.pdf'}), capture)
    const resolver = createAssetResolver({
      getUserId: () => 'vlad',
      byteStore,
      blobStore: {get: async () => { throw new Error('should be a local hit') }} as unknown as BlobStore,
      getMaterializability: async () => 'copy' as const,
      getCek: async () => null,
      getContentKeyHmac: async () => null,
    })
    const read = await readMedia(repo, WS, added.id, resolver)
    expect(base64.decode(read.base64)).toEqual(PDF)
    expect(read.mime).toBe('application/pdf')
  })

  it('adding the same bytes again finds the same block', async () => {
    const first = await addMedia(WS, input(PNG), capture)
    const second = await addMedia(WS, input(PNG), capture)
    expect(second).toEqual({...first, deduped: true})
  })

  it('takes a declared mime only for bytes it cannot recognise', async () => {
    const audio = new Uint8Array([1, 2, 3])
    const added = await addMedia(WS, input(audio, {mime: 'audio/mpeg'}), capture)
    expect((await repo.load(added.id))?.properties[mediaMimeProp.name]).toBe('audio/mpeg')
    const mislabelled = await addMedia(WS, input(PNG, {mime: 'text/plain'}), capture)
    expect((await repo.load(mislabelled.id))?.properties[mediaMimeProp.name]).toBe('image/png')
  })

  it('under recognizedOnly, refuses bytes that are no image or PDF, before capturing anything', async () => {
    const spy = vi.fn(capture)
    await expect(addMedia(WS, input(SECRET, {recognizedOnly: true}), spy)).rejects.toThrow(/not a recognised image or PDF/)
    expect(spy).not.toHaveBeenCalled()
  })

  it.each([['image', PNG], ['PDF', PDF]])('under recognizedOnly, accepts a %s', async (_, bytes) => {
    await expect(addMedia(WS, input(bytes, {recognizedOnly: true}), capture)).resolves.toMatchObject({deduped: false})
  })

  it('without recognizedOnly, any bytes are a file', async () => {
    await expect(addMedia(WS, input(SECRET), capture)).resolves.toMatchObject({deduped: false})
  })

  it('reports a failed capture in words', async () => {
    await expect(addMedia(WS, input(new Uint8Array()), capture)).rejects.toThrow(/empty/)
    await expect(addMedia(WS, input(PNG), async () => ({ok: false, reason: 'workspace-locked'}))).rejects.toThrow(/[Uu]nlock/)
  })

  it('refuses input that is not base64', async () => {
    await expect(addMedia(WS, {base64: '!!! not base64'}, capture)).rejects.toThrow(/base64/)
  })
})

describe('the add-media command', () => {
  it('refuses a workspace other than the open one', async () => {
    await expect(executeCommand({type: 'add-media', base64: 'AQID', workspaceId: 'other', commandId: 'c'} as never, context))
      .rejects.toThrow(/other/)
  })

  it('refuses while the Attachments plugin is off', async () => {
    // This runtime has no media renderer: the same state as the toggle being off.
    await expect(executeCommand({type: 'add-media', base64: 'AQID', commandId: 'c'} as never, context))
      .rejects.toThrow(/Enable the Attachments plugin/)
  })
})
