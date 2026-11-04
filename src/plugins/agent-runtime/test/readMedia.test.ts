// @vitest-environment happy-dom
import {base64} from '@scure/base'
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {MEDIA_READ_MAX_BYTES} from '@knowledge-medium/agent-cli/protocol'
import {ChangeScope} from '@/data/api'
import {PAGE_TYPE} from '@/data/blockTypes'
import {aliasesProp, typesProp} from '@/data/properties'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import type {BlobStore} from '@/plugins/attachments/blobStore'
import {InMemoryByteStore} from '@/plugins/attachments/byteStore'
import {
  MEDIA_TYPE,
  mediaFilenameProp,
  mediaHashProp,
  mediaMimeProp,
  mediaSizeProp,
} from '@/plugins/attachments/mediaBlock'
import {createAssetResolver, type AssetResolver} from '@/plugins/attachments/resolver'
import {computeContentHash} from '@/sync/crypto/contentHash'
import {createAgentRuntimeContext, executeCommand} from '../commands'
import type {AgentRuntimeContext} from '../protocol'
import {readMedia} from '../readMedia'

const WS = 'ws'
const PAGE = '3f2a9c1d-0000-4000-8000-0000000000a1'
const MEDIA = 'b10c4e7a-0000-4000-8000-0000000000b1'
const PLAIN = 'c20d5f8b-0000-4000-8000-0000000000c1'
const NO_HASH = 'd30e6a9c-0000-4000-8000-0000000000d1'
const opts = {scope: ChangeScope.BlockDefault}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
const TEXT_BYTES = new TextEncoder().encode('not an image at all')

let db: TestDb
let context: AgentRuntimeContext
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

/** The real resolver over in-memory stores, so hash verification runs for real. */
const resolverServing = (bytes: Uint8Array<ArrayBuffer>): AssetResolver => createAssetResolver({
  getUserId: () => 'vlad',
  byteStore: new InMemoryByteStore(),
  blobStore: {get: async () => bytes} as unknown as BlobStore,
  getMaterializability: async () => 'copy' as const,
  getCek: async () => null,
  getContentKeyHmac: async () => null,
})

const createMedia = async (over: {hash: string, mime?: string, filename?: string, id?: string}) => {
  await context.repo.tx(async tx => {
    await tx.create({
      id: over.id ?? MEDIA,
      workspaceId: WS,
      parentId: PAGE,
      orderKey: 'a1',
      content: 'image.png',
      properties: {
        [typesProp.name]: [MEDIA_TYPE],
        [mediaHashProp.name]: over.hash,
        [mediaMimeProp.name]: over.mime ?? 'image/png',
        // Cosmetic and writable by any member: a result reports the bytes, not this.
        [mediaSizeProp.name]: 999_999,
        ...(over.filename !== undefined ? {[mediaFilenameProp.name]: over.filename} : {}),
      },
    })
  }, opts)
}

beforeEach(async () => {
  await resetTestDb(db.db)
  const {repo} = createTestRepo({db: db.db, user: {id: 'vlad', name: 'Vlad'}})
  const runtime = resolveFacetRuntimeSync(staticDataExtensions, {repo, workspaceId: WS, safeMode: false})
  repo.setFacetRuntime(runtime)
  repo.setActiveWorkspaceId(WS)
  context = createAgentRuntimeContext({repo, runtime, safeMode: false})
  await context.repo.tx(async tx => {
    await tx.create({id: PAGE, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Notes',
      properties: {[typesProp.name]: [PAGE_TYPE], [aliasesProp.name]: ['Notes']}})
    await tx.create({id: PLAIN, workspaceId: WS, parentId: PAGE, orderKey: 'a0', content: 'just text'})
    await tx.create({id: NO_HASH, workspaceId: WS, parentId: PAGE, orderKey: 'a2', content: 'not captured yet',
      properties: {[typesProp.name]: [MEDIA_TYPE]}})
  }, opts)
})

describe('readMedia', () => {
  it('returns the verified bytes with what the block says about them', async () => {
    const hash = await computeContentHash(PNG_BYTES)
    await createMedia({hash, filename: 'shot.png'})

    const result = await readMedia(context.repo, WS, MEDIA, resolverServing(PNG_BYTES))

    expect(result).toEqual({
      id: MEDIA,
      hash,
      mime: 'image/png',
      size: PNG_BYTES.length,
      filename: 'shot.png',
      imageMime: 'image/png',
      base64: base64.encode(PNG_BYTES),
    })
  })

  it('takes the image format from the bytes, since media:mime is a synced, member-writable value', async () => {
    const hash = await computeContentHash(TEXT_BYTES)
    await createMedia({hash, mime: 'image/png'})

    const claimedImage = await readMedia(context.repo, WS, MEDIA, resolverServing(TEXT_BYTES))
    expect(claimedImage).toMatchObject({mime: 'image/png', imageMime: null})

    const pngHash = await computeContentHash(PNG_BYTES)
    await createMedia({id: '0a0a0a0a-0000-4000-8000-000000000001', hash: pngHash, mime: 'application/octet-stream'})
    const unlabelledImage = await readMedia(
      context.repo, WS, '0a0a0a0a-0000-4000-8000-000000000001', resolverServing(PNG_BYTES),
    )
    expect(unlabelledImage).toMatchObject({mime: 'application/octet-stream', imageMime: 'image/png'})
  })

  it('reports no filename as null', async () => {
    await createMedia({hash: await computeContentHash(PNG_BYTES)})
    const result = await readMedia(context.repo, WS, MEDIA, resolverServing(PNG_BYTES))
    expect(result.filename).toBeNull()
  })

  it('refuses a block that is not a media block before touching the resolver', async () => {
    const resolve = vi.fn<AssetResolver['resolve']>()
    await expect(readMedia(context.repo, WS, PLAIN, {resolve})).rejects.toThrow(`Block ${PLAIN} is not a media block`)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a media block with no content hash before touching the resolver', async () => {
    const resolve = vi.fn<AssetResolver['resolve']>()
    await expect(readMedia(context.repo, WS, NO_HASH, {resolve})).rejects.toThrow(`Media block ${NO_HASH} has no content hash`)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('serves nothing when the bytes do not match the block hash', async () => {
    await createMedia({hash: await computeContentHash(PNG_BYTES)})
    await expect(readMedia(context.repo, WS, MEDIA, resolverServing(TEXT_BYTES)))
      .rejects.toThrow(/do not match its media:hash/)
  })

  it('says why when the workspace cannot be decoded', async () => {
    await createMedia({hash: await computeContentHash(PNG_BYTES)})
    await expect(readMedia(context.repo, WS, MEDIA, {resolve: async () => ({ok: false, reason: 'deferred'})}))
      .rejects.toThrow(/locked, or the app tab is signed out/)
  })

  it('refuses bytes past what the bridge can carry, naming both sizes', async () => {
    await createMedia({hash: await computeContentHash(PNG_BYTES)})
    const tooBig = new Uint8Array(MEDIA_READ_MAX_BYTES + 1)
    await expect(readMedia(context.repo, WS, MEDIA, {resolve: async () => ({ok: true, bytes: tooBig})}))
      .rejects.toThrow(new RegExp(`${tooBig.length} bytes.*${MEDIA_READ_MAX_BYTES}`))
  })

  it('carries bytes exactly at the limit', async () => {
    await createMedia({hash: await computeContentHash(PNG_BYTES)})
    const atLimit = new Uint8Array(MEDIA_READ_MAX_BYTES)
    const result = await readMedia(context.repo, WS, MEDIA, {resolve: async () => ({ok: true, bytes: atLimit})})
    expect(result.size).toBe(MEDIA_READ_MAX_BYTES)
  })

  it('resolves the block through the same refs the views take', async () => {
    const hash = await computeContentHash(PNG_BYTES)
    await createMedia({hash})
    const result = await readMedia(context.repo, WS, `^${MEDIA}`, resolverServing(PNG_BYTES))
    expect(result.id).toBe(MEDIA)
  })
})

describe('the read-media command', () => {
  it('reaches the app resolver, which fails closed while signed out', async () => {
    await createMedia({hash: await computeContentHash(PNG_BYTES)})
    await expect(executeCommand({type: 'read-media', ref: MEDIA, commandId: 'c1'} as never, context))
      .rejects.toThrow(/locked, or the app tab is signed out/)
  })

  it('binds the workspace named in the call', async () => {
    await createMedia({hash: await computeContentHash(PNG_BYTES)})
    await expect(executeCommand({type: 'read-media', ref: MEDIA, workspaceId: 'other', commandId: 'c1'} as never, context))
      .rejects.toThrow(/other/)
  })
})
