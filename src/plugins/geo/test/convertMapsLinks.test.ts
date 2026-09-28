// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { geoDataExtension } from '../dataExtension'
import { convertMapsLinksInBlock } from '../convertMapsLinks'
import { createOrFindPlace, placeMachineAlias, type PlaceCandidate } from '../createOrFindPlace'
import { MapsLinkError } from '../resolveMapsLink'
import { placeGooglePlaceIdProp } from '../properties'

const WS = 'ws-maps-link-1'
const SHORT = 'https://maps.app.goo.gl/kUHBzJWS8mqdFY2a8'

const craftsman: PlaceCandidate = {
  name: 'Craftsman and Wolves Valencia',
  lat: 37.7609056,
  lng: -122.4216833,
  googlePlaceId: 'ChIJcraftsman',
}

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, extensions: [geoDataExtension], user: {id: 'user-1'}}).repo
  repo.setActiveWorkspaceId(WS)
})

const blockWith = async (content: string): Promise<string> => {
  const id = crypto.randomUUID()
  await repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content})
  }, {scope: ChangeScope.BlockDefault, description: 'seed'})
  return id
}

const contentOf = async (id: string): Promise<string | undefined> => (await repo.load(id))?.content

describe('convertMapsLinksInBlock', () => {
  it('replaces the link with a wikilink to a new Place', async () => {
    const id = await blockWith(`coffee at ${SHORT}.`)

    const result = await convertMapsLinksInBlock({repo, blockId: id}, async () => craftsman)

    expect(result).toEqual({converted: 1, failures: []})
    expect(await contentOf(id)).toBe('coffee at [[Craftsman and Wolves Valencia]].')
    const place = await repo.query.aliasLookup({workspaceId: WS, alias: placeMachineAlias(craftsman)}).load()
    expect(place?.properties[placeGooglePlaceIdProp.name]).toBe('ChIJcraftsman')
  })

  it('links to the Place that already exists for the same POI', async () => {
    const existing = await createOrFindPlace(repo, WS, {...craftsman, name: 'Craftsman & Wolves'})
    if (existing.kind !== 'ok') throw new Error('seed place collided')
    const id = await blockWith(SHORT)

    await convertMapsLinksInBlock({repo, blockId: id}, async () => craftsman)

    expect(await contentOf(id)).toBe('[[Craftsman & Wolves]]')
  })

  it('leaves a link it cannot resolve in place and reports why', async () => {
    const id = await blockWith(`a ${SHORT} and b https://www.google.com/maps/@37.7,-122.4,15z`)
    const resolveLink = vi.fn(async (url: string) => {
      if (url === SHORT) return craftsman
      throw new MapsLinkError('no place here')
    })

    const result = await convertMapsLinksInBlock({repo, blockId: id}, resolveLink)

    expect(result).toEqual({converted: 1, failures: ['no place here']})
    expect(await contentOf(id)).toBe(
      'a [[Craftsman and Wolves Valencia]] and b https://www.google.com/maps/@37.7,-122.4,15z',
    )
  })
})
