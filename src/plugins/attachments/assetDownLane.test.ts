// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Control the gating providers + the per-user resolver the down-lane wiring reads.
const h = vi.hoisted(() => ({
  remoteActive: true,
  replicate: vi.fn(async () => ({ ok: true, status: 'present' as const })),
  // Every userId `getAssetResolverForUser` was called with, in call order — lets a
  // test pin WHICH user the pass bound its resolver to (review #424 P2).
  resolverForUserCalls: [] as string[],
}))
vi.mock('@/data/repoProvider.js', async (orig) => ({
  ...(await orig<typeof import('@/data/repoProvider.js')>()),
  isRemoteSyncActive: () => h.remoteActive,
}))
vi.mock('./assetResolver.js', () => ({
  getAssetResolverForUser: (userId: string) => {
    h.resolverForUserCalls.push(userId)
    return { resolve: vi.fn(), replicate: h.replicate }
  },
}))

import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import {
  ASSETS_TYPE_CONTRIBUTION,
  MEDIA_PROPERTY_SCHEMAS,
  MEDIA_TYPE,
  MEDIA_TYPE_CONTRIBUTION,
  mediaHashProp,
} from './mediaBlock.js'
import { collectReplicationRequests, runDownLaneReconcile } from './assetDownLane.js'

const WS = 'ws-1'
const USER = 'user-1'

let sharedDb: TestDb
let repo: Repo

const buildRepo = (userId: string = USER): Repo => {
  const r = new Repo({ db: sharedDb.db, cache: new BlockCache(), user: { id: userId } })
  r.setFacetRuntime(
    resolveFacetRuntimeSync([
      kernelDataExtension,
      typeSeedsFacet.of(MEDIA_TYPE_CONTRIBUTION, { source: 'test' }),
      typeSeedsFacet.of(ASSETS_TYPE_CONTRIBUTION, { source: 'test' }),
      ...MEDIA_PROPERTY_SCHEMAS.map((s) => definitionSeedsFacet.of(s, { source: 'test' })),
    ]),
  )
  r.setActiveWorkspaceId(WS)
  return r
}

/** Create a `media`-typed block with the given hash (omit `hash` for the empty
 *  default — capture hasn't populated it yet). */
const addMediaBlock = async (id: string, orderKey: string, hash?: string): Promise<void> => {
  const snap = repo.snapshotTypeRegistries()
  await repo.tx(
    async (tx) => {
      await tx.create({ id, workspaceId: WS, parentId: null, orderKey, content: '' })
      if (hash !== undefined) await tx.setProperty(id, mediaHashProp, hash)
      await repo.addTypeInTx(tx, id, MEDIA_TYPE, {}, snap)
    },
    { scope: ChangeScope.BlockDefault },
  )
}

/** Create a media block carrying a RAW (un-encoded) `media:hash` value — models a
 *  legacy / imported / hand-edited row the cache boundary admitted (it validates JSON
 *  syntax, not codec shape), so `mediaHashProp.codec.decode` would THROW on read. */
const addMediaBlockRawHash = async (id: string, orderKey: string, rawHash: unknown): Promise<void> => {
  const snap = repo.snapshotTypeRegistries()
  await repo.tx(
    async (tx) => {
      await tx.create({
        id,
        workspaceId: WS,
        parentId: null,
        orderKey,
        content: '',
        properties: { [mediaHashProp.name]: rawHash },
      })
      await repo.addTypeInTx(tx, id, MEDIA_TYPE, {}, snap)
    },
    { scope: ChangeScope.BlockDefault },
  )
}

beforeAll(async () => {
  sharedDb = await createTestDb()
})
afterAll(async () => {
  await sharedDb.cleanup()
})
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = buildRepo()
  h.remoteActive = true
  h.replicate.mockClear()
  h.resolverForUserCalls.length = 0
})
afterEach(() => {
  repo.stopSyncObserver()
})

describe('collectReplicationRequests', () => {
  it('returns one request per DISTINCT content hash, skipping empty-hash blocks', async () => {
    await addMediaBlock('m1', 'a0', 'sha256:aaaa')
    await addMediaBlock('m2', 'a1', 'sha256:bbbb')
    await addMediaBlock('m3', 'a2', 'sha256:aaaa') // a copy/import — same content as m1
    await addMediaBlock('m4', 'a3') // capture hasn't set a hash → not replicable yet

    const requests = await collectReplicationRequests(repo, WS)

    expect(requests).toEqual([
      { workspaceId: WS, contentHash: 'sha256:aaaa' },
      { workspaceId: WS, contentHash: 'sha256:bbbb' },
    ])
  })

  it('skips a block whose media:hash is an explicit empty string, not just an omitted default', async () => {
    // Distinct from the omitted-hash case above (m4: property never set → `encoded ===
    // undefined`): here the property IS present but decodes to '' (a cleared / half-
    // captured value). The `!contentHash` guard must still skip it — without it the block
    // would emit `{contentHash:''}`, wasted work the resolver only fails closed on
    // (`invalid-hash`). The good blocks on either side must still be collected.
    await addMediaBlock('m1', 'a0', 'sha256:aaaa')
    await addMediaBlock('m-empty', 'a1', '') // property set, but to the empty string
    await addMediaBlock('m2', 'a2', 'sha256:bbbb')

    const requests = await collectReplicationRequests(repo, WS)
    expect(requests).toEqual([
      { workspaceId: WS, contentHash: 'sha256:aaaa' },
      { workspaceId: WS, contentHash: 'sha256:bbbb' },
    ])
  })

  it('skips a malformed (non-string) media:hash instead of throwing and stalling the walk', async () => {
    await addMediaBlock('m1', 'a0', 'sha256:aaaa')
    await addMediaBlockRawHash('m-bad', 'a1', 12345) // a number where a string is expected
    await addMediaBlock('m2', 'a2', 'sha256:bbbb')

    // The bad row is skipped; the whole workspace must NOT lose its down-lane to one
    // corrupt block (the renderer's throw-free canRender stance).
    const requests = await collectReplicationRequests(repo, WS)
    expect(requests).toEqual([
      { workspaceId: WS, contentHash: 'sha256:aaaa' },
      { workspaceId: WS, contentHash: 'sha256:bbbb' },
    ])
  })

  it('is empty when the workspace has no media blocks', async () => {
    await repo.tx(
      async (tx) => {
        await tx.create({ id: 'note', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'plain' })
      },
      { scope: ChangeScope.BlockDefault },
    )
    expect(await collectReplicationRequests(repo, WS)).toEqual([])
  })
})

describe('runDownLaneReconcile — gating', () => {
  it('replicates every distinct media block when active + online', async () => {
    await addMediaBlock('m1', 'a0', 'sha256:aaaa')
    await addMediaBlock('m2', 'a1', 'sha256:bbbb')

    await runDownLaneReconcile(repo, WS)

    expect(h.replicate).toHaveBeenCalledTimes(2)
    // Each replicate gets the request + the one-shot presence set (a single dir scan up
    // front; empty here since the in-memory byte store holds nothing).
    expect(h.replicate).toHaveBeenCalledWith({ workspaceId: WS, contentHash: 'sha256:aaaa' }, expect.any(Set))
    expect(h.replicate).toHaveBeenCalledWith({ workspaceId: WS, contentHash: 'sha256:bbbb' }, expect.any(Set))
    expect(h.resolverForUserCalls).toEqual([USER]) // bound to repo.user.id, once for the whole pass
  })

  it('is a no-op in local-only mode (nothing to fetch from) — never walks or replicates', async () => {
    await addMediaBlock('m1', 'a0', 'sha256:aaaa')
    h.remoteActive = false
    await runDownLaneReconcile(repo, WS)
    expect(h.replicate).not.toHaveBeenCalled()
  })

  // The "signed out" no-op used to be exercised here by nulling a global
  // `getActiveUserId()` independent of `repo`. Now that the user id comes from
  // `repo.user.id`, that state is unreachable through this call site: a live
  // `Repo` always carries a concrete user (RepoProvider throws before
  // constructing one without a signed-in user), so there's no "signed out but
  // holding a repo" case left to model at the unit level.

  it('binds the resolver to the CALLED-WITH repo.user.id, not a value shared across calls (review #424 P2 — the account-switch race)', async () => {
    // Models a down-lane pass for one user's repo, then a second pass for a
    // DIFFERENT user's repo against the same workspace/db — standing in for a
    // stale in-flight pass (started under the old user) outliving an account
    // switch, whose live ambient reads (had it used the shared `getAssetResolver()`
    // singleton instead) would have drifted to the NEW active user mid-pass. Every
    // user-scoped read `runDownLaneReconcile` makes — including which resolver it
    // asks for — must come from the `Repo` it was invoked with, not any shared/
    // ambient value, so two back-to-back calls for two different repos resolve
    // two DIFFERENT users, in call order, never mixing scope.
    const otherRepo = buildRepo('user-2')
    await addMediaBlock('m1', 'a0', 'sha256:aaaa')

    await runDownLaneReconcile(repo, WS) // repo.user.id === USER ('user-1')
    await runDownLaneReconcile(otherRepo, WS) // otherRepo.user.id === 'user-2'

    expect(h.resolverForUserCalls).toEqual([USER, 'user-2'])
    otherRepo.stopSyncObserver()
  })
})
