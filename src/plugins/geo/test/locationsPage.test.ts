// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { PAGE_TYPE } from '@/data/blockTypes'
import { aliasesProp, typesProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { MAP_TYPE } from '../blockTypes'
import { geoDataExtension } from '../dataExtension'
import { getOrCreateLocationsPage, locationsPageBlockId } from '../locationsPage'

const WS = 'ws-geo-1'

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
    extensions: [geoDataExtension],
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

describe('getOrCreateLocationsPage', () => {
  it('creates the Locations page with PAGE_TYPE + MAP_TYPE on first call', async () => {
    const page = await getOrCreateLocationsPage(env.repo, WS)

    expect(page.id).toBe(locationsPageBlockId(WS))
    expect(page.peek()?.content).toBe('Locations')
    expect(page.peekProperty(aliasesProp)).toEqual(['Locations'])
    expect(page.peekProperty(typesProp)).toEqual([PAGE_TYPE, MAP_TYPE])
  })

  it('repairs an existing Locations page by adding MAP_TYPE if it has only PAGE_TYPE', async () => {
    // Simulates pre-rename state: Locations page exists with a stale
    // type list missing MAP_TYPE. Next bootstrap call should heal it.
    const first = await getOrCreateLocationsPage(env.repo, WS)
    await env.repo.tx(async tx => {
      await tx.update(first.id, {properties: {types: [PAGE_TYPE]}})
    }, {scope: ChangeScope.BlockDefault})

    const repaired = await getOrCreateLocationsPage(env.repo, WS)
    expect(repaired.peekProperty(typesProp)).toContain(MAP_TYPE)
  })

  it('returns the same block id on subsequent calls without re-creating', async () => {
    const first = await getOrCreateLocationsPage(env.repo, WS)
    const firstUpdatedAt = first.peek()?.updatedAt

    const second = await getOrCreateLocationsPage(env.repo, WS)

    expect(second.id).toBe(first.id)
    expect(second.peek()?.updatedAt).toBe(firstUpdatedAt)
  })

  it('derives distinct page ids per workspace', () => {
    expect(locationsPageBlockId('ws-a')).not.toBe(locationsPageBlockId('ws-b'))
  })
})
