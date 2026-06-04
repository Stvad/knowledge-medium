// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BlockCache } from '@/data/blockCache'
import { PAGE_TYPE, TYPES_PAGE_TYPE } from '@/data/blockTypes'
import { aliasesProp, typesProp } from '@/data/properties'
import { getOrCreateTypesPage, typesPageBlockId } from '@/data/typesPage'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'

const WS = 'ws-types-page'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: {id: 'user-1'},
    registerKernelProcessors: false,
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
// Dispose the per-test Repo's sync observer so its db.onChange subscription
// doesn't leak onto the shared DB (closed once in afterAll).
afterEach(() => { env.repo.stopSyncObserver() })

describe('getOrCreateTypesPage', () => {
  it('creates the singleton as both a page and a Types page', async () => {
    const block = await getOrCreateTypesPage(env.repo, WS)

    expect(block.id).toBe(typesPageBlockId(WS))
    expect(block.peek()?.content).toBe('Types')
    expect(block.peekProperty(aliasesProp)).toEqual(['Types'])
    expect(block.peekProperty(typesProp)).toEqual([PAGE_TYPE, TYPES_PAGE_TYPE])
  })

  it('typesPageId on Repo matches the helper id once a workspace is active', async () => {
    await getOrCreateTypesPage(env.repo, WS)
    expect(env.repo.typesPageId).toBe(typesPageBlockId(WS))
  })
})
