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
})

describe('listWorkspaceObjects', () => {
  type Page = {objects: {name: string}[]; folders: never[]; hasNext: boolean; nextCursor?: string}
  /** Storage's v2 listing over `objects`: every full name under the prefix,
   *  bytewise, at most `cap` a page, resuming after the cursor's name. With a
   *  delimiter a nested object comes back only as its folder. A listing that
   *  keeps asking would never yield to the test's timeout, so it is cut off. */
  const fakeClient = (objects: readonly string[], {cap = Infinity, sessionUser = 'user-1' as string | null} = {}) => {
    const calls: {prefix: string; cursor?: string}[] = []
    const headers: Record<string, string>[] = []
    const listV2 = async (
      {prefix, cursor, limit, with_delimiter}: {prefix: string; cursor?: string; limit: number; with_delimiter?: boolean},
    ) => {
      if (calls.push({prefix, cursor}) > 10) throw new Error('listed the folder over again')
      const listed = (name: string) => name.startsWith(prefix) && !(with_delimiter && name.slice(prefix.length).includes('/'))
      const under = objects.filter(listed).sort()
      const start = cursor === undefined ? 0 : under.indexOf(cursor) + 1
      const page = under.slice(start, start + Math.min(limit, cap))
      const hasNext = start + page.length < under.length
      const data: Page = {objects: page.map(name => ({name})), folders: [], hasNext, nextCursor: hasNext ? page.at(-1) : undefined}
      return {data, error: null}
    }
    const from = () => {
      const api = {
        listV2,
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
  /** A client whose every page is `page`, for a few pages: a listing that
   *  keeps asking would otherwise never yield to the test's timeout. */
  const clientServing = (page: Page | Error) => {
    let served = 0
    const listV2 = async () => {
      if (++served > 3) throw new Error('listed the folder over again')
      return page instanceof Error ? {data: null, error: page} : {data: page, error: null}
    }
    return {
      auth: {getSession: async () => ({data: {session: {user: {id: 'user-1'}, access_token: 't'}}})},
      storage: {from: () => ({listV2, setHeader: () => ({listV2})})},
    } as unknown as SupabaseClient
  }
  const list = (client: SupabaseClient, over: {isRemoteSyncActive?: () => boolean} = {}) =>
    listWorkspaceObjects({client, userId: 'user-1', workspaceId: WS, isRemoteSyncActive: () => true, ...over})

  it('lists every object, nested ones included, relative to the workspace folder', async () => {
    const {client, calls, headers} = fakeClient([`${WS}/dir/deeper/cc`, `${WS}/aa`, `${WS}/dir/bb`, 'other-ws/dd'])
    expect(await list(client)).toEqual(['aa', 'dir/bb', 'dir/deeper/cc'])
    expect(calls).toEqual([{prefix: `${WS}/`, cursor: undefined}])
    // The session's own token rides the request, so it can't fall back to the anon key.
    expect(headers).toEqual([{Authorization: 'Bearer token-of-user-1'}])
  })

  it("pages by Storage's cursor until it reports no next page", async () => {
    const names = Array.from({length: 1200}, (_, i) => `${WS}/${String(i).padStart(6, '0')}`)
    const {client, calls} = fakeClient(names, {cap: 500})
    expect(await list(client)).toHaveLength(1200)
    expect(calls.map(c => c.cursor)).toEqual([undefined, `${WS}/000499`, `${WS}/000999`])
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

  it('throws on a failed page rather than acting on a partial listing', async () => {
    await expect(list(clientServing(new Error('503')))).rejects.toThrow('503')
  })

  // Defence in depth: Storage v1.80.2 does neither.
  it('refuses a next page with no cursor, which would start the listing over', async () => {
    await expect(list(clientServing({objects: [{name: `${WS}/aa`}], folders: [], hasNext: true}))).rejects.toThrow(/no cursor/)
  })

  it('refuses a name outside the folder rather than cut a path out of it', async () => {
    await expect(list(clientServing({objects: [{name: 'aa'}], folders: [], hasNext: false}))).rejects.toThrow(/listed aa under/)
  })
})

describe('createAttachmentCleanerIO mediaBlocks', () => {
  it('refuses while this device has synced rows not yet applied to blocks', async () => {
    const repo = {workspaceViewGap: async () => ({reason: 'synced rows are still draining into `blocks`', transient: true})}
    const io = createAttachmentCleanerIO({
      client: {} as SupabaseClient,
      blobStore: {} as BlobStore,
      byteStore: new InMemoryByteStore(),
      repo: repo as unknown as Repo,
      userId: 'user-1',
      workspaceId: WS,
      isRemoteSyncActive: () => true,
    })
    await expect(io.mediaBlocks()).rejects.toThrow(/incomplete: synced rows are still draining/)
  })
})
