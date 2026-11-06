// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { EXTENSION_TYPE } from '@/data/blockTypes'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { geoDataExtension } from '../dataExtension'
import { convertMapsLinksInBlock } from '../convertMapsLinks'
import { createOrFindPlace, placeMachineAlias, type PlaceCandidate } from '../createOrFindPlace'
import { GooglePlacesError } from '../googlePlacesClient'
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
  it('asks for a retry when Google Places is unreachable, keeping the link', async () => {
    const id = await blockWith(SHORT)
    const resolveLink = async (): Promise<PlaceCandidate> => {
      throw new GooglePlacesError('network', null, 'offline')
    }

    const result = await convertMapsLinksInBlock({repo, blockId: id}, resolveLink)

    expect(result.failures).toEqual([expect.stringMatching(/Google Places.*try again/)])
    expect(await contentOf(id)).toBe(SHORT)
  })

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

  it('creates no Place when the link was removed while it was being looked up', async () => {
    const id = await blockWith(`coffee at ${SHORT}`)
    const resolveLink = async () => {
      await repo.tx(async tx => { await tx.update(id, {content: 'coffee at home'}) },
        {scope: ChangeScope.BlockDefault, description: 'user edit'})
      return craftsman
    }

    const result = await convertMapsLinksInBlock({repo, blockId: id}, resolveLink)

    expect(result).toEqual({converted: 0, failures: []})
    expect(await contentOf(id)).toBe('coffee at home')
    expect(await repo.query.aliasLookup({workspaceId: WS, alias: placeMachineAlias(craftsman)}).load()).toBeNull()
  })

  it('does not look up a later link the user removed while an earlier one resolved', async () => {
    const second = 'https://maps.app.goo.gl/second'
    const id = await blockWith(`${SHORT} and ${second}`)
    const resolveLink = vi.fn(async () => {
      await repo.tx(async tx => { await tx.update(id, {content: `${SHORT} and nothing`}) },
        {scope: ChangeScope.BlockDefault, description: 'user edit'})
      return craftsman
    })

    await convertMapsLinksInBlock({repo, blockId: id}, resolveLink)

    expect(resolveLink.mock.calls).toEqual([[SHORT]])
    expect(await contentOf(id)).toBe('[[Craftsman and Wolves Valencia]] and nothing')
  })

  it('stops, before the next lookup or any Place, once the workspace turned read-only', async () => {
    const id = await blockWith(`${SHORT} and https://maps.app.goo.gl/second`)
    const resolveLink = vi.fn(async () => {
      repo.setReadOnly(true)
      return craftsman
    })

    const result = await convertMapsLinksInBlock({repo, blockId: id}, resolveLink)

    expect(resolveLink).toHaveBeenCalledTimes(1)
    expect(result).toEqual({converted: 0, failures: []})
    expect(await repo.query.aliasLookup({workspaceId: WS, alias: placeMachineAlias(craftsman)}).load()).toBeNull()
  })

  it('checks read-only after reading the block, right before the lookup', async () => {
    const id = await blockWith(SHORT)
    const load = repo.load.bind(repo)
    let loads = 0
    // The role changes while the eligibility check reads the block.
    vi.spyOn(repo, 'load').mockImplementation(async (...args) => {
      const row = await load(...args)
      if (++loads === 2) repo.setReadOnly(true)
      return row
    })
    const resolveLink = vi.fn(async () => craftsman)

    await convertMapsLinksInBlock({repo, blockId: id}, resolveLink)

    expect(loads).toBeGreaterThanOrEqual(2)
    expect(resolveLink).not.toHaveBeenCalled()
  })

  it('mints no Place once the block was retyped as an extension during the lookup', async () => {
    const id = await blockWith(`coffee at ${SHORT}`)
    const resolveLink = async () => {
      await repo.tx(async tx => { await repo.addTypeInTx(tx, id, EXTENSION_TYPE, {}, repo.snapshotTypeRegistries()) },
        {scope: ChangeScope.BlockDefault, description: 'retype as extension'})
      return craftsman
    }

    const result = await convertMapsLinksInBlock({repo, blockId: id}, resolveLink)

    expect(result).toEqual({converted: 0, failures: []})
    expect(await contentOf(id)).toBe(`coffee at ${SHORT}`)
    expect(await repo.query.aliasLookup({workspaceId: WS, alias: placeMachineAlias(craftsman)}).load()).toBeNull()
  })

  it('re-finds the link, not a copy of it in code, after the text moved', async () => {
    const id = await blockWith(`\`${SHORT}\` is where we had ${SHORT}`)
    const resolveLink = async () => {
      // Typing ahead of the link shifts it off its recorded span.
      await repo.tx(async tx => {
        await tx.update(id, {content: `note: \`${SHORT}\` is where we had ${SHORT}`})
      }, {scope: ChangeScope.BlockDefault, description: 'user edit'})
      return craftsman
    }

    await convertMapsLinksInBlock({repo, blockId: id}, resolveLink)

    expect(await contentOf(id)).toBe(`note: \`${SHORT}\` is where we had [[Craftsman and Wolves Valencia]]`)
  })

  it("leaves an extension block's source alone, without looking anything up", async () => {
    const source = `const url = "${SHORT}"`
    const id = await blockWith(source)
    await repo.tx(async tx => { await repo.addTypeInTx(tx, id, EXTENSION_TYPE, {}, repo.snapshotTypeRegistries()) },
      {scope: ChangeScope.BlockDefault, description: 'make it an extension'})
    const resolveLink = vi.fn(async () => craftsman)

    const result = await convertMapsLinksInBlock({repo, blockId: id}, resolveLink)

    expect(result).toEqual({converted: 0, failures: []})
    expect(resolveLink).not.toHaveBeenCalled()
    expect(await contentOf(id)).toBe(source)
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
