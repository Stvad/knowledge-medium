// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { BlockCache } from '@/data/blockCache'
import { PAGE_TYPE } from '@/data/blockTypes'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { aliasesProp, typesProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { LOCATIONS_PAGE_TYPE } from '../blockTypes'
import { geoDataExtension } from '../dataExtension'
import { getOrCreateLocationsPage, locationsPageBlockId } from '../locationsPage'

const WS = 'ws-geo-1'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: {id: 'user-1'},
    registerKernelProcessors: false,
  })
  repo.setActiveWorkspaceId(WS)
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    geoDataExtension,
  ]))
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

describe('getOrCreateLocationsPage', () => {
  it('creates the Locations page with PAGE_TYPE + LOCATIONS_PAGE_TYPE on first call', async () => {
    const page = await getOrCreateLocationsPage(env.repo, WS)

    expect(page.id).toBe(locationsPageBlockId(WS))
    expect(page.peek()?.content).toBe('Locations')
    expect(page.peekProperty(aliasesProp)).toEqual(['Locations'])
    expect(page.peekProperty(typesProp)).toEqual([PAGE_TYPE, LOCATIONS_PAGE_TYPE])
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
