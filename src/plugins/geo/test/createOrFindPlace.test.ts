// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { BlockCache } from '@/data/blockCache'
import { PAGE_TYPE } from '@/data/blockTypes'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { aliasesProp, typesProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { PLACE_TYPE } from '../blockTypes'
import { geoDataExtension } from '../dataExtension'
import { createOrFindPlace, placeMachineAlias } from '../createOrFindPlace'
import { locationsPageBlockId } from '../locationsPage'
import {
  placeAddressProp,
  placeCategoriesProp,
  placeGoogleMapsUrlProp,
  placeGooglePlaceIdProp,
  placeLatProp,
  placeLngProp,
  placePhoneProp,
  placeWebsiteProp,
} from '../properties'

const WS = 'ws-place-1'

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
  repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension, geoDataExtension]))
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

const DANDELION = {
  name: 'Dandelion Chocolate',
  lat: 37.761013,
  lng: -122.4216972,
  address: '740 Valencia St, San Francisco, CA 94110, USA',
  googlePlaceId: 'ChIJDandelion',
  googleMapsUrl: 'https://maps.google.com/?cid=3693608739776694163',
  website: 'https://dandelionchocolate.com',
  phone: '+1 415-349-0942',
  categories: ['cafe', 'restaurant'] as readonly string[],
} as const

describe('placeMachineAlias', () => {
  it('uses place:<id> form for Google POIs', () => {
    expect(placeMachineAlias({googlePlaceId: 'ChIJabc', lat: 0, lng: 0})).toBe('place:ChIJabc')
  })

  it('rounds coords to 5 decimals for ad-hoc pins', () => {
    expect(placeMachineAlias({lat: 37.7613128929, lng: -122.4216972888}))
      .toBe('geo:37.76131,-122.42170')
  })

  it('produces the same alias for coords within ~1m', () => {
    expect(placeMachineAlias({lat: 37.761011, lng: -122.421697}))
      .toBe(placeMachineAlias({lat: 37.761014, lng: -122.421697}))
  })
})

describe('createOrFindPlace', () => {
  it('creates a Place block under the Locations page on first call', async () => {
    const place = await createOrFindPlace(env.repo, WS, DANDELION)

    expect(place.peek()?.parentId).toBe(locationsPageBlockId(WS))
    expect(place.peek()?.content).toBe('Dandelion Chocolate')
    expect(place.peekProperty(typesProp)).toEqual([PAGE_TYPE, PLACE_TYPE])
    expect(place.peekProperty(aliasesProp)).toEqual([
      'Dandelion Chocolate',
      'place:ChIJDandelion',
    ])
    expect(place.peekProperty(placeLatProp)).toBe(37.761013)
    expect(place.peekProperty(placeLngProp)).toBe(-122.4216972)
    expect(place.peekProperty(placeAddressProp)).toBe(DANDELION.address)
    expect(place.peekProperty(placeGooglePlaceIdProp)).toBe('ChIJDandelion')
    expect(place.peekProperty(placeGoogleMapsUrlProp)).toBe(DANDELION.googleMapsUrl)
    expect(place.peekProperty(placeWebsiteProp)).toBe(DANDELION.website)
    expect(place.peekProperty(placePhoneProp)).toBe(DANDELION.phone)
    expect(place.peekProperty(placeCategoriesProp)).toEqual(['cafe', 'restaurant'])
  })

  it('returns the existing block when called twice with the same Google id', async () => {
    const first = await createOrFindPlace(env.repo, WS, DANDELION)
    const second = await createOrFindPlace(env.repo, WS, DANDELION)
    expect(second.id).toBe(first.id)
  })

  it('dedups by rounded coord alias for ad-hoc pins', async () => {
    const adHocA = {name: '', lat: 37.7613128929, lng: -122.4216972888}
    const adHocB = {name: '', lat: 37.7613133333, lng: -122.4216975555}

    const first = await createOrFindPlace(env.repo, WS, adHocA)
    const second = await createOrFindPlace(env.repo, WS, adHocB)

    expect(second.id).toBe(first.id)
    expect(first.peekProperty(aliasesProp)).toEqual(['geo:37.76131,-122.42170'])
  })

  it('falls back to the geo: alias as content when the name is empty', async () => {
    const adHoc = {name: '', lat: 40, lng: -74}
    const place = await createOrFindPlace(env.repo, WS, adHoc)
    expect(place.peek()?.content).toBe('geo:40.00000,-74.00000')
  })

  it('omits absent optional fields without writing them', async () => {
    const minimal = {name: 'Skeleton', lat: 1, lng: 2, googlePlaceId: 'ChIJSkel'}
    const place = await createOrFindPlace(env.repo, WS, minimal)
    expect(place.peekProperty(placeAddressProp)).toBeUndefined()
    expect(place.peekProperty(placeWebsiteProp)).toBeUndefined()
    expect(place.peekProperty(placePhoneProp)).toBeUndefined()
    expect(place.peekProperty(placeCategoriesProp)).toBeUndefined()
  })
})
