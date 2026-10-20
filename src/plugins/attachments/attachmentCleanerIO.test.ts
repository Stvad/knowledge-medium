// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { trackTestRepo } from '@/data/test/testRepoScope'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import type { BlobStore } from './blobStore.js'
import { InMemoryByteStore } from './byteStore.js'
import { InMemoryByteUploadStore } from './uploadStore.js'
import { createAttachmentCleanerIO, listMediaBlocks, listWorkspaceObjects } from './attachmentCleanerIO.js'
import { ASSETS_TYPE_CONTRIBUTION, MEDIA_PROPERTY_SCHEMAS, MEDIA_TYPE, MEDIA_TYPE_CONTRIBUTION, mediaHashProp } from './mediaBlock.js'

const WS = 'ws-1'

describe('listMediaBlocks', () => {
  let sharedDb: TestDb
  let repo: Repo

  beforeAll(async () => {
    sharedDb = await createTestDb()
  })
  afterAll(async () => {
    await sharedDb.cleanup()
  })
  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    repo = trackTestRepo(new Repo({db: sharedDb.db, cache: new BlockCache(), user: {id: 'user-1'}, blockIdPolicy: 'any'}))
    repo.setFacetRuntime(
      resolveFacetRuntimeSync([
        kernelDataExtension,
        typeSeedsFacet.of(MEDIA_TYPE_CONTRIBUTION, {source: 'test'}),
        typeSeedsFacet.of(ASSETS_TYPE_CONTRIBUTION, {source: 'test'}),
        ...MEDIA_PROPERTY_SCHEMAS.map(s => definitionSeedsFacet.of(s, {source: 'test'})),
      ]),
    )
    repo.setActiveWorkspaceId(WS)
  })
  afterEach(() => {
    repo.stopSyncObserver()
  })

  const addMedia = async (id: string, orderKey: string, hash: string) => {
    const snap = repo.snapshotTypeRegistries()
    await repo.tx(
      async tx => {
        await tx.create({id, workspaceId: WS, parentId: null, orderKey, content: ''})
        await tx.setProperty(id, mediaHashProp, hash)
        await repo.addTypeInTx(tx, id, MEDIA_TYPE, {}, snap)
      },
      {scope: ChangeScope.BlockDefault},
    )
  }

  it('includes soft-deleted media blocks, whose attachments must still be converted and kept', async () => {
    await addMedia('live', 'a0', 'sha256:aaaa')
    await addMedia('gone', 'a1', 'sha256:bbbb')
    await repo.tx(tx => tx.delete('gone'), {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.create({id: 'note', workspaceId: WS, parentId: null, orderKey: 'a2', content: 'not media'}), {
      scope: ChangeScope.BlockDefault,
    })
    // Precondition: the typed query, which the down-lane uses, skips the deleted one.
    expect((await repo.queryBlocks({workspaceId: WS, types: [MEDIA_TYPE]})).map(b => b.id)).toEqual(['live'])
    expect(await listMediaBlocks(repo, WS)).toEqual(
      expect.arrayContaining([
        {blockId: 'live', contentHash: 'sha256:aaaa'},
        {blockId: 'gone', contentHash: 'sha256:bbbb'},
      ]),
    )
    expect(await listMediaBlocks(repo, WS)).toHaveLength(2)
  })

  it('reads a media block\'s hash from its stored row, as the bundle reads the server\'s', async () => {
    await addMedia('photo', 'a0', 'sha256:aaaa')
    await repo.tx(async tx => {
      await tx.create({id: 'note', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'not media'})
      // A hash-shaped value on a block that isn't media.
      await tx.setProperty('note', mediaHashProp, 'sha256:bbbb')
    }, {scope: ChangeScope.BlockDefault})
    const stored = async (id: string) =>
      (await sharedDb.db.get<{properties_json: string}>('SELECT properties_json FROM blocks WHERE id = ?', [id])).properties_json
    const io = cleanerIO(repo)

    expect(io.mediaHashOf(await stored('photo'))).toBe('sha256:aaaa')
    expect(io.mediaHashOf(await stored('note'))).toBeNull()
    expect(io.mediaHashOf('enc:v1:not-json')).toBeNull()
    expect(io.mediaHashOf('null')).toBeNull()
  })
})

const cleanerIO = (repo: Repo, uploadStore = new InMemoryByteUploadStore()) => createAttachmentCleanerIO({
  client: {} as SupabaseClient,
  blobStore: {} as BlobStore,
  byteStore: new InMemoryByteStore(),
  uploadStore,
  repo,
  userId: 'user-1',
  workspaceId: WS,
  isRemoteSyncActive: () => true,
})

describe('createAttachmentCleanerIO pendingUploads', () => {
  it('counts this workspace\'s staged, pending and failed uploads, and no stage whose block never committed', async () => {
    const uploads = new InMemoryByteUploadStore()
    const stage = (assetBlockId: string, workspaceId = WS, userId = 'user-1') =>
      uploads.stage({userId, assetBlockId, workspaceId, contentHash: 'sha256:aaaa', contentKey: assetBlockId})
    await stage('staged')
    await stage('pending')
    await uploads.promote('user-1', 'pending')
    await stage('failed')
    await uploads.markFailed('user-1', 'failed')
    await stage('other-workspace', 'ws-2')
    await stage('other-user', WS, 'user-2')
    // A capture that crashed or threw between its stage and its block: it never uploads.
    await stage('orphan')
    const repo = {load: async (id: string) => (id === 'orphan' ? null : {id})} as unknown as Repo

    expect(await cleanerIO(repo, uploads).pendingUploads()).toBe(3)
  })
})

describe('listWorkspaceObjects', () => {
  /** A Storage list over `objects`: the entries directly under a prefix, a
   *  nested folder as an entry with a null id, by name; at most `cap` a page. */
  const fakeClient = (objects: readonly string[], {cap = Infinity, sessionUser = 'user-1' as string | null} = {}) => {
    const calls: {prefix: string; offset: number}[] = []
    const headers: Record<string, string>[] = []
    const list = async (prefix: string, {limit, offset}: {limit: number; offset: number}) => {
      calls.push({prefix, offset})
      const under = objects.filter(o => o.startsWith(`${prefix}/`)).map(o => o.slice(prefix.length + 1))
      const entries = [...new Set(under.map(rest => rest.split('/')[0]))].sort().map(name => ({
        name,
        id: under.includes(name) ? `id-${name}` : null,
      }))
      return {data: entries.slice(offset, offset + Math.min(limit, cap)), error: null}
    }
    const from = () => {
      const api = {
        list,
        setHeader: (name: string, value: string) => {
          headers.push({[name]: value})
          return api
        },
      }
      return api
    }
    const session = sessionUser === null ? null : {user: {id: sessionUser}, access_token: `token-of-${sessionUser}`}
    const client = {
      auth: {getSession: async () => ({data: {session}})},
      storage: {from},
    } as unknown as SupabaseClient
    return {client, calls, headers}
  }
  const list = (client: SupabaseClient, over: {isRemoteSyncActive?: () => boolean} = {}) =>
    listWorkspaceObjects({client, userId: 'user-1', workspaceId: WS, isRemoteSyncActive: () => true, ...over})

  it('lists every object, recursing into nested folders, relative to the workspace folder', async () => {
    const {client, headers} = fakeClient([`${WS}/aa`, `${WS}/dir/bb`, `${WS}/dir/deeper/cc`, 'other-ws/dd'])
    expect(await list(client)).toEqual(['aa', 'dir/bb', 'dir/deeper/cc'])
    // The session's own token rides the request, so it can't fall back to the anon key.
    expect(headers).toEqual([{Authorization: 'Bearer token-of-user-1'}])
  })

  it('pages by the length each page actually had, until an empty page', async () => {
    const names = Array.from({length: 1200}, (_, i) => `${WS}/${String(i).padStart(6, '0')}`)
    const {client, calls} = fakeClient(names, {cap: 500}) // a server capping pages below the 1000 asked for
    expect(await list(client)).toHaveLength(1200)
    expect(calls.map(c => c.offset)).toEqual([0, 500, 1000, 1200])
  })

  it('refuses rather than list under no session or another account: RLS would show an empty folder', async () => {
    for (const sessionUser of [null, 'someone-else']) {
      const {client, calls} = fakeClient([`${WS}/aa`], {sessionUser})
      await expect(list(client)).rejects.toThrow(/session/)
      expect(calls).toEqual([])
    }
  })

  it('refuses while remote sync is off', async () => {
    const {client, calls} = fakeClient([`${WS}/aa`])
    await expect(list(client, {isRemoteSyncActive: () => false})).rejects.toThrow(/remote sync/)
    expect(calls).toEqual([])
  })

  it('stops at the next request once remote sync goes off mid-listing', async () => {
    const names = Array.from({length: 1500}, (_, i) => `${WS}/${String(i).padStart(6, '0')}`)
    const {client, calls} = fakeClient(names)
    let remote = true
    const listing = list(client, {
      isRemoteSyncActive: () => {
        if (calls.length === 1) remote = false // switched off after the first page
        return remote
      },
    })
    await expect(listing).rejects.toThrow(/remote sync/)
    expect(calls).toHaveLength(1)
  })

  it('refuses an empty name segment, which would list its folder again forever', async () => {
    const {client} = fakeClient([`${WS}//x`])
    await expect(list(client)).rejects.toThrow(/empty name/)
  })

  it('throws on a failed page rather than acting on a partial listing', async () => {
    const failing = {list: async () => ({data: null, error: new Error('503')})}
    const client = {
      auth: {getSession: async () => ({data: {session: {user: {id: 'user-1'}, access_token: 't'}}})},
      storage: {from: () => ({...failing, setHeader: () => failing})},
    } as unknown as SupabaseClient
    await expect(list(client)).rejects.toThrow('503')
  })
})

describe('createAttachmentCleanerIO mediaBlocks', () => {
  it('refuses while this device has synced rows not yet applied to blocks', async () => {
    const repo = {workspaceViewGap: async () => ({reason: 'synced rows are still draining into `blocks`', transient: true})}
    await expect(cleanerIO(repo as unknown as Repo).mediaBlocks()).rejects.toThrow(/incomplete: synced rows are still draining/)
  })
})
