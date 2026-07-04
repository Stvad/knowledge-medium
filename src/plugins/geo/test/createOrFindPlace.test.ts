// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { PAGE_TYPE } from '@/data/blockTypes'
import { aliasesProp, typesProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { PLACE_TYPE } from '../blockTypes'
import { geoDataExtension } from '../dataExtension'
import {
  addPlaceToExistingBlock,
  createOrFindPlace,
  placeMachineAlias,
  type PlaceCandidate,
} from '../createOrFindPlace'
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
  const { repo } = createTestRepo({
    db: h.db,
    extensions: [geoDataExtension],
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

/** Unwrap the ok-arm — most tests expect creation to succeed. */
const create = async (candidate: PlaceCandidate): Promise<Block> => {
  const result = await createOrFindPlace(env.repo, WS, candidate)
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`)
  return result.block
}

/** Seed a plain (non-place) block claiming `alias`. */
const seedAliasedPage = async (id: string, alias: string): Promise<void> => {
  await env.repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content: alias})
    await tx.setProperty(id, aliasesProp, [alias])
  }, {scope: ChangeScope.BlockDefault})
}

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
    const place = await create(DANDELION)

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
    const first = await create(DANDELION)
    const second = await create(DANDELION)
    expect(second.id).toBe(first.id)
  })

  it('dedups by rounded coord alias for ad-hoc pins', async () => {
    const adHocA = {name: '', lat: 37.7613128929, lng: -122.4216972888}
    const adHocB = {name: '', lat: 37.7613133333, lng: -122.4216975555}

    const first = await create(adHocA)
    const second = await create(adHocB)

    expect(second.id).toBe(first.id)
    expect(first.peekProperty(aliasesProp)).toEqual(['geo:37.76131,-122.42170'])
  })

  it('falls back to the geo: alias as content when the name is empty', async () => {
    const adHoc = {name: '', lat: 40, lng: -74}
    const place = await create(adHoc)
    expect(place.peek()?.content).toBe('geo:40.00000,-74.00000')
  })

  it('omits absent optional fields without writing them', async () => {
    const minimal = {name: 'Skeleton', lat: 1, lng: 2, googlePlaceId: 'ChIJSkel'}
    const place = await create(minimal)
    expect(place.peekProperty(placeAddressProp)).toBeUndefined()
    expect(place.peekProperty(placeWebsiteProp)).toBeUndefined()
    expect(place.peekProperty(placePhoneProp)).toBeUndefined()
    expect(place.peekProperty(placeCategoriesProp)).toBeUndefined()
  })
})

describe('createOrFindPlace — friendly-name collision', () => {
  it('returns name-collision (creating nothing) when the name is claimed by a non-place block', async () => {
    await seedAliasedPage('page-1', 'Dandelion Chocolate')

    const result = await createOrFindPlace(env.repo, WS, DANDELION)

    expect(result.kind).toBe('name-collision')
    if (result.kind !== 'name-collision') return
    expect(result.name).toBe('Dandelion Chocolate')
    expect(result.machineAlias).toBe('place:ChIJDandelion')
    expect(result.existing).toEqual({
      id: 'page-1',
      content: 'Dandelion Chocolate',
      isPlace: false,
    })
    // Nothing was created — the machine alias is still unclaimed.
    const machineClaim = await env.repo.query
      .aliasLookup({workspaceId: WS, alias: 'place:ChIJDandelion'}).load()
    expect(machineClaim).toBeNull()
  })

  it('flags isPlace when the claimant is a different place with the same name', async () => {
    const first = await create(DANDELION)
    const sameNameElsewhere = {...DANDELION, googlePlaceId: 'ChIJOther', lat: 40, lng: -74}

    const result = await createOrFindPlace(env.repo, WS, sameNameElsewhere)

    expect(result.kind).toBe('name-collision')
    if (result.kind !== 'name-collision') return
    expect(result.existing.id).toBe(first.id)
    expect(result.existing.isPlace).toBe(true)
  })

  it('machine-alias match wins over the name check (same POI is found, not a collision)', async () => {
    const first = await create(DANDELION)
    const second = await createOrFindPlace(env.repo, WS, DANDELION)
    expect(second.kind).toBe('ok')
    if (second.kind !== 'ok') return
    expect(second.block.id).toBe(first.id)
  })
})

describe('addPlaceToExistingBlock', () => {
  it('turns the colliding page into a place: types, props, machine alias appended', async () => {
    await seedAliasedPage('page-1', 'Dandelion Chocolate')

    const block = await addPlaceToExistingBlock(env.repo, 'page-1', DANDELION)

    expect(block.id).toBe('page-1')
    expect(block.peek()?.content).toBe('Dandelion Chocolate')
    expect(block.peekProperty(typesProp)).toEqual([PAGE_TYPE, PLACE_TYPE])
    expect(block.peekProperty(aliasesProp)).toEqual([
      'Dandelion Chocolate',
      'place:ChIJDandelion',
    ])
    expect(block.peekProperty(placeLatProp)).toBe(DANDELION.lat)
    expect(block.peekProperty(placeLngProp)).toBe(DANDELION.lng)
    expect(block.peekProperty(placeAddressProp)).toBe(DANDELION.address)

    // The enriched block now satisfies the machine-alias fast path.
    const again = await createOrFindPlace(env.repo, WS, DANDELION)
    expect(again.kind).toBe('ok')
    if (again.kind !== 'ok') return
    expect(again.block.id).toBe('page-1')
  })

  it('is idempotent on the machine alias and existing types', async () => {
    await seedAliasedPage('page-1', 'Dandelion Chocolate')
    await addPlaceToExistingBlock(env.repo, 'page-1', DANDELION)
    const block = await addPlaceToExistingBlock(env.repo, 'page-1', DANDELION)
    expect(block.peekProperty(aliasesProp)).toEqual([
      'Dandelion Chocolate',
      'place:ChIJDandelion',
    ])
    expect(block.peekProperty(typesProp)).toEqual([PAGE_TYPE, PLACE_TYPE])
  })

  it('rejects a missing block', async () => {
    await expect(addPlaceToExistingBlock(env.repo, 'nope', DANDELION)).rejects.toThrow()
  })
})

describe('undo grouping (issue #306)', () => {
  it('Locations-page bootstrap + place creation record ONE undo entry', async () => {
    const block = await create(DANDELION)
    expect(env.repo.undoManager.depths(ChangeScope.BlockDefault)).toEqual({undo: 1, redo: 0})

    const isDeleted = async (id: string) =>
      (await env.repo.db.getOptional<{deleted: number}>('SELECT deleted FROM blocks WHERE id = ?', [id]))?.deleted === 1
    expect(await env.repo.undo()).toBe(true)
    expect(await isDeleted(block.id)).toBe(true)
    expect(await isDeleted(locationsPageBlockId(WS))).toBe(true)
  })
})
