// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PAGE_TYPE, TYPES_PAGE_TYPE } from '@/data/blockTypes'
import { aliasesProp, typesProp } from '@/data/properties'
import { getOrCreateTypesPage, typesPageBlockId } from '@/data/typesPage'
import { Repo } from '@/data/repo'
import { createTestRepo } from '@/data/test/createTestRepo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'

const WS = 'ws-types-page'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

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
