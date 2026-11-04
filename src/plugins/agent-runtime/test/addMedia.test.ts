// @vitest-environment happy-dom
import {base64} from '@scure/base'
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets'
import {kernelPageBlockId} from '@/data/kernelPage'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {blockRenderersFacet} from '@/extensions/core'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {resolveFacetRuntimeSync, type AppExtension} from '@/facets/facet'
import type {BlobStore} from '@/plugins/attachments/blobStore'
import {getByteStore} from '@/plugins/attachments/byteStore'
import {
  ASSETS_NS,
  ASSETS_TYPE_CONTRIBUTION,
  MEDIA_PROPERTY_SCHEMAS,
  MEDIA_TYPE_CONTRIBUTION,
  mediaFilenameProp,
  mediaHashProp,
  mediaMimeProp,
  mediaSizeProp,
} from '@/plugins/attachments/mediaBlock'
import {createAssetResolver} from '@/plugins/attachments/resolver'
import {attributionCreatorsProp} from '@/plugins/contributors/schema'
import {computeContentHash} from '@/sync/crypto/contentHash'
import type {Materializability} from '@/sync/transform'
import {createAgentRuntimeContext, executeCommand} from '../commands'
import type {AgentRuntimeContext} from '../protocol'
import {readMedia} from '../readMedia'

// The real captureMediaFromFiles, over in-memory stores and a settable decode mode.
const mode = vi.hoisted(() => ({current: 'copy' as Materializability}))
vi.mock('@/plugins/attachments/byteStore', async original => {
  const actual = await original<typeof import('@/plugins/attachments/byteStore')>()
  const store = new actual.InMemoryByteStore()
  return {...actual, getByteStore: () => store}
})
vi.mock('@/plugins/attachments/uploadStore', async original => {
  const actual = await original<typeof import('@/plugins/attachments/uploadStore')>()
  const store = new actual.InMemoryByteUploadStore(() => 1000)
  return {...actual, getByteUploadStore: () => store}
})
vi.mock('@/data/repoProvider', async original => ({
  ...await original<typeof import('@/data/repoProvider')>(),
  syncResolverForUser: () => ({
    getMaterializability: async () => mode.current,
    getCek: async () => null,
    getContentKeyHmac: async () => null,
  }),
}))

const WS = 'ws'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const PDF = new TextEncoder().encode('%PDF-1.4 hello')
const MISSING_ID = '11111111-1111-4111-8111-111111111111'

let db: TestDb
let context: AgentRuntimeContext
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

const contextWith = (extensions: AppExtension[]) => {
  const {repo} = createTestRepo({db: db.db, user: {id: 'vlad', name: 'Vlad'}})
  const runtime = resolveFacetRuntimeSync([
    staticDataExtensions,
    typeSeedsFacet.of(MEDIA_TYPE_CONTRIBUTION, {source: 'test'}),
    typeSeedsFacet.of(ASSETS_TYPE_CONTRIBUTION, {source: 'test'}),
    MEDIA_PROPERTY_SCHEMAS.map(schema => definitionSeedsFacet.of(schema, {source: 'test'})),
    ...extensions,
  ], {repo, workspaceId: WS, safeMode: false})
  repo.setFacetRuntime(runtime)
  repo.setActiveWorkspaceId(WS)
  return createAgentRuntimeContext({repo, runtime, safeMode: false})
}

const attachmentsOn = blockRenderersFacet.of({id: 'media', renderer: (() => null) as never}, {source: 'test'})

beforeEach(async () => {
  await resetTestDb(db.db)
  mode.current = 'copy'
  context = contextWith([attachmentsOn])
})

interface Added { id: string, workspaceId: string, deduped: boolean, reference: string }

const send = (command: Record<string, unknown>, on = context) =>
  executeCommand({type: 'add-media', commandId: 'c', contributorId: null, ...command} as never, on) as Promise<Added>
const add = (bytes: Uint8Array, over: Record<string, unknown> = {}) => send({base64: base64.encode(bytes), ...over})
const countRows = async () => (await db.db.getAll('SELECT id FROM blocks')).length

describe('the add-media command', () => {
  it('stores the bytes as a media block under Assets, and says how to place it and where it went', async () => {
    const added = await add(PNG, {filename: 'shot.png'})

    expect(added).toEqual({id: added.id, workspaceId: WS, deduped: false, reference: `((${added.id}))`})
    const block = await context.repo.load(added.id)
    expect(block).toMatchObject({content: 'shot.png', workspaceId: WS, parentId: kernelPageBlockId(WS, ASSETS_NS)})
    expect(block?.properties).toMatchObject({
      [mediaHashProp.name]: await computeContentHash(PNG),
      [mediaMimeProp.name]: 'image/png',
      [mediaSizeProp.name]: PNG.length,
      [mediaFilenameProp.name]: 'shot.png',
    })
  })

  it('round-trips: what was added reads back byte for byte', async () => {
    const added = await add(PDF, {filename: 'a.pdf'})
    const resolver = createAssetResolver({
      getUserId: () => 'vlad',
      byteStore: getByteStore(),
      blobStore: {get: async () => { throw new Error('should be a local hit') }} as unknown as BlobStore,
      getMaterializability: async () => 'copy' as const,
      getCek: async () => null,
      getContentKeyHmac: async () => null,
    })
    const read = await readMedia(context.repo, WS, added.id, resolver)
    expect(base64.decode(read.base64)).toEqual(PDF)
    expect(read.mime).toBe('application/pdf')
  })

  it('finds the same block for the same bytes, leaving what it holds alone', async () => {
    const first = await add(PNG, {filename: 'first.png'})
    const second = await add(PNG, {filename: 'second.png'})
    expect(second).toEqual({...first, deduped: true})
    expect((await context.repo.load(first.id))?.content).toBe('first.png')
  })

  it('takes a declared mime for bytes it cannot recognise', async () => {
    const added = await add(new Uint8Array([1, 2, 3]), {mime: 'audio/mpeg'})
    expect((await context.repo.load(added.id))?.properties[mediaMimeProp.name]).toBe('audio/mpeg')
  })

  it('keeps a text file that starts like an image typed as text', async () => {
    const added = await add(new TextEncoder().encode('BMW service history\n'), {mime: 'text/plain'})
    expect((await context.repo.load(added.id))?.properties[mediaMimeProp.name]).toBe('text/plain')
  })

  it('is listed as an agent write by recent-changes', async () => {
    const added = await add(PNG)
    const changes = await executeCommand({type: 'recent-changes', since: 0, commandId: 'c2'} as never, context)
    expect(JSON.stringify(changes)).toContain(added.id)
    expect(JSON.stringify(changes)).toContain('agent runtime add-media')
  })

  it('credits the agent on the block, which stays pristine', async () => {
    const {id: agent} = await executeCommand({type: 'create-contributor', name: 'Atlas', commandId: 'k'} as never, context) as {id: string}
    const added = await add(PNG, {contributorId: agent})
    const block = await context.repo.load(added.id)
    expect(block?.properties[attributionCreatorsProp.name]).toEqual([agent])
    expect(block?.updatedAt).toBe(0)
  })

  it('leaves the first contributor in place when another agent adds the same bytes', async () => {
    const contributor = async (name: string) =>
      (await executeCommand({type: 'create-contributor', name, commandId: 'k'} as never, context) as {id: string}).id
    const first = await contributor('Atlas')
    const added = await add(PNG, {contributorId: first})
    await add(PNG, {contributorId: await contributor('Scout')})
    expect((await context.repo.load(added.id))?.properties[attributionCreatorsProp.name]).toEqual([first])
  })

  it('takes one undo to remove the upload', async () => {
    const {id: agent} = await executeCommand({type: 'create-contributor', name: 'Atlas', commandId: 'k'} as never, context) as {id: string}
    const added = await add(PNG, {contributorId: agent})
    await context.repo.undo()
    expect(await context.repo.load(added.id)).toBeNull()
  })

  it('refuses a filename linking a block that does not exist, writing nothing', async () => {
    const before = await countRows()
    await expect(add(PNG, {filename: `((${MISSING_ID})).png`})).rejects.toThrow(MISSING_ID)
    expect(await countRows()).toBe(before)
  })

  it('refuses with no contributor chosen, whether or not Assets exists yet', async () => {
    const before = await countRows()
    await expect(add(PNG, {contributorId: undefined})).rejects.toThrow(/Choose a contributor/)
    expect(await countRows()).toBe(before)

    await add(PDF)
    await expect(add(PNG, {contributorId: undefined})).rejects.toThrow(/Choose a contributor/)
  })

  it('reports a failed capture in words', async () => {
    await expect(add(new Uint8Array())).rejects.toThrow(/empty/)
    mode.current = 'defer'
    await expect(add(PNG)).rejects.toThrow(/[Uu]nlock/)
  })

  it('refuses input that is not base64', async () => {
    await expect(send({base64: '!!! not base64'})).rejects.toThrow(/not valid base64/)
  })

  it('refuses a workspace other than the open one', async () => {
    await expect(add(PNG, {workspaceId: 'other'})).rejects.toThrow(/other/)
  })

  it('refuses while the Attachments plugin is off', async () => {
    await expect(send({base64: base64.encode(PNG)}, contextWith([]))).rejects.toThrow(/Enable the Attachments plugin/)
  })
})
