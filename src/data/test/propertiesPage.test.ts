// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { PAGE_TYPE, PROPERTIES_PAGE_TYPE } from '@/data/blockTypes'
import { aliasesProp, typesProp } from '@/data/properties'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'

const WS = 'ws-properties-page'

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

describe('getOrCreatePropertiesPage', () => {
  it('creates the singleton as both a page and properties page', async () => {
    const block = await getOrCreatePropertiesPage(env.repo, WS)

    expect(block.peek()?.content).toBe('Properties')
    expect(block.peekProperty(aliasesProp)).toEqual(['Properties'])
    expect(block.peekProperty(typesProp)).toEqual([PAGE_TYPE, PROPERTIES_PAGE_TYPE])
  })

  it('repairs a live properties page missing the base page type', async () => {
    const block = await getOrCreatePropertiesPage(env.repo, WS)
    await env.repo.tx(async tx => {
      await tx.setProperty(block.id, typesProp, [PROPERTIES_PAGE_TYPE])
    }, {scope: ChangeScope.BlockDefault})

    const repaired = await getOrCreatePropertiesPage(env.repo, WS)

    expect(repaired.peekProperty(typesProp)).toEqual([PROPERTIES_PAGE_TYPE, PAGE_TYPE])
  })
})
