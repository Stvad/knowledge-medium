// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { geoDataExtension } from '../dataExtension'
import { createOrFindPlace } from '../createOrFindPlace'
import { locationProp, placeLatProp } from '../properties'
import { placesUnderBlockQuery, type MapPin } from '../query'

const WS = 'ws-query-1'

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
  repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension, geoDataExtension]))
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

const createBlock = async (
  id: string,
  args: {parentId: string | null; content?: string; orderKey?: string},
): Promise<void> => {
  await env.repo.tx(async tx => {
    await tx.create({
      id,
      workspaceId: WS,
      parentId: args.parentId,
      orderKey: args.orderKey ?? `key-${id}`,
      content: args.content ?? '',
    })
  }, {scope: ChangeScope.BlockDefault})
}

const setLocation = async (sourceId: string, placeId: string): Promise<void> => {
  await env.repo.tx(async tx => {
    await tx.setProperty(sourceId, locationProp, placeId)
  }, {scope: ChangeScope.BlockDefault})
}

const PIN_KEY = (p: MapPin): string => `${p.blockId}|${p.placeId}|${p.lat}|${p.lng}`

describe('placesUnderBlockQuery', () => {
  it('pins Place blocks at their own coords when scoped to the Locations page', async () => {
    const dandelion = await createOrFindPlace(env.repo, WS, {
      name: 'Dandelion', lat: 37.76, lng: -122.42, googlePlaceId: 'ChIJD',
    })
    const blue = await createOrFindPlace(env.repo, WS, {
      name: 'Blue Bottle', lat: 37.80, lng: -122.43, googlePlaceId: 'ChIJB',
    })

    const locationsPageId = dandelion.peek()!.parentId!
    const pins = await env.repo
      .query[placesUnderBlockQuery.name]({rootBlockId: locationsPageId})
      .load()

    const pinByPlaceId = new Map<string, MapPin>(pins.map((p: MapPin) => [p.placeId, p]))
    expect(pinByPlaceId.get(dandelion.id)).toMatchObject({
      blockId: dandelion.id,
      placeId: dandelion.id,
      lat: 37.76,
      lng: -122.42,
    })
    expect(pinByPlaceId.get(blue.id)).toMatchObject({
      blockId: blue.id,
      placeId: blue.id,
      lat: 37.80,
      lng: -122.43,
    })
  })

  it('surfaces the referenced Place address on the pin (for marker callouts)', async () => {
    const dandelion = await createOrFindPlace(env.repo, WS, {
      name: 'Dandelion',
      lat: 37.76,
      lng: -122.42,
      googlePlaceId: 'ChIJD',
      address: '740 Valencia St, San Francisco, CA',
    })
    await createBlock('note', {parentId: null, content: 'Coffee with K'})
    await setLocation('note', dandelion.id)

    const pins = await env.repo
      .query[placesUnderBlockQuery.name]({rootBlockId: 'note'})
      .load()

    expect(pins).toHaveLength(1)
    expect(pins[0].address).toBe('740 Valencia St, San Francisco, CA')
  })

  it('pins activity blocks at the coords of their referenced Place', async () => {
    const dandelion = await createOrFindPlace(env.repo, WS, {
      name: 'Dandelion', lat: 37.76, lng: -122.42, googlePlaceId: 'ChIJD',
    })
    await createBlock('trip', {parentId: null, content: 'SF trip'})
    await createBlock('meeting', {parentId: 'trip', content: 'Met Sarah'})
    await setLocation('meeting', dandelion.id)

    const pins = await env.repo
      .query[placesUnderBlockQuery.name]({rootBlockId: 'trip'})
      .load()

    expect(pins.map(PIN_KEY)).toEqual([
      `meeting|${dandelion.id}|37.76|-122.42`,
    ])
  })

  it('excludes blocks with no location and no PLACE_TYPE membership', async () => {
    await createBlock('trip', {parentId: null, content: 'SF trip'})
    await createBlock('plain-note', {parentId: 'trip', content: 'no location here'})

    const pins = await env.repo
      .query[placesUnderBlockQuery.name]({rootBlockId: 'trip'})
      .load()

    expect(pins).toEqual([])
  })

  it('excludes pins when the referenced Place has no lat/lng', async () => {
    // A degenerate Place created directly (no createOrFindPlace) with
    // location omitted — defends against partial migrations.
    await createBlock('orphan-place', {parentId: null, content: 'Orphan'})
    await env.repo.tx(async tx => {
      await tx.update('orphan-place', {properties: {types: ['page', 'place']}})
    }, {scope: ChangeScope.BlockDefault})

    await createBlock('note', {parentId: null, content: 'Visited Orphan'})
    await setLocation('note', 'orphan-place')

    const pins = await env.repo
      .query[placesUnderBlockQuery.name]({rootBlockId: 'note'})
      .load()

    expect(pins).toEqual([])
  })

  it('re-resolves when a referenced Place’s lat changes', async () => {
    const dandelion = await createOrFindPlace(env.repo, WS, {
      name: 'Dandelion', lat: 37.76, lng: -122.42, googlePlaceId: 'ChIJD',
    })
    await createBlock('meeting', {parentId: null, content: 'Coffee'})
    await setLocation('meeting', dandelion.id)

    const handle = env.repo.query[placesUnderBlockQuery.name]({rootBlockId: 'meeting'})
    const first = await handle.load()
    expect(first[0].lat).toBe(37.76)

    await env.repo.tx(async tx => {
      await tx.setProperty(dandelion.id, placeLatProp, 40.00)
    }, {scope: ChangeScope.BlockDefault})

    const second = await handle.load()
    expect(second[0].lat).toBe(40.00)
  })
})
