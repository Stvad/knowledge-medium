/** `createOrFindPlace` — alias-based dedup + Place block creation.
 *  Single entry point used by the `@` autocomplete (Phase C), the
 *  property editor (Phase E), and the current-location flow (Phase F).
 *
 *  Dedup rules:
 *    - Google POI: aliases = [name, `place:<googlePlaceId>`]. The
 *      machine-form alias is what we look up by — names drift, ids
 *      don't.
 *    - Ad-hoc coordinate pin: aliases = [`geo:<lat>,<lng>`] with lat/lng
 *      rounded to 5 decimals (~1m precision). Two pins dropped at the
 *      same spot dedup; exact-float dedup is brittle and an unwanted
 *      strictness.
 *
 *  Locations page is bootstrapped lazily on first call. */

import { v4 as uuidv4 } from 'uuid'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { PAGE_TYPE } from '@/data/blockTypes'
import { aliasesProp } from '@/data/internals/coreProperties'
import { keyAtEnd } from '@/data/orderKey'
import { PLACE_TYPE } from './blockTypes'
import {
  placeAddressProp,
  placeCategoriesProp,
  placeGoogleMapsUrlProp,
  placeGooglePlaceIdProp,
  placeLatProp,
  placeLngProp,
  placePhoneProp,
  placeWebsiteProp,
} from './properties'
import { getOrCreateLocationsPage } from './locationsPage'

/** Normalised candidate shape. `lat` / `lng` are always present —
 *  callers without coords have no business invoking this. */
export interface PlaceCandidate {
  /** Display name. For ad-hoc pins this may be empty — caller-supplied
   *  label if any, otherwise we fall back to the geo: alias as content
   *  so the block still renders. */
  name: string
  lat: number
  lng: number
  address?: string
  googlePlaceId?: string
  googleMapsUrl?: string
  website?: string
  phone?: string
  categories?: readonly string[]
}

const COORD_DEDUP_DECIMALS = 5

const roundCoord = (n: number): string => n.toFixed(COORD_DEDUP_DECIMALS)

/** Public for test access — same machine alias the lookup uses. */
export const placeMachineAlias = (candidate: Pick<PlaceCandidate, 'googlePlaceId' | 'lat' | 'lng'>): string =>
  candidate.googlePlaceId
    ? `place:${candidate.googlePlaceId}`
    : `geo:${roundCoord(candidate.lat)},${roundCoord(candidate.lng)}`

const aliasesFor = (candidate: PlaceCandidate, machineAlias: string): readonly string[] => {
  const name = candidate.name.trim()
  if (name.length === 0 || name === machineAlias) return [machineAlias]
  return [name, machineAlias]
}

const contentFor = (candidate: PlaceCandidate, machineAlias: string): string => {
  const name = candidate.name.trim()
  return name.length > 0 ? name : machineAlias
}

export const createOrFindPlace = async (
  repo: Repo,
  workspaceId: string,
  candidate: PlaceCandidate,
): Promise<Block> => {
  const machineAlias = placeMachineAlias(candidate)

  // Fast-path: existing block claiming this machine alias.
  const existing = await repo.query.aliasLookup({workspaceId, alias: machineAlias}).load()
  if (existing) return repo.block(existing.id)

  // Lazy-bootstrap the Locations page (separate tx — safe to interleave).
  const locationsPage = await getOrCreateLocationsPage(repo, workspaceId)
  const aliases = aliasesFor(candidate, machineAlias)
  const content = contentFor(candidate, machineAlias)
  const id = uuidv4()
  const typeSnapshot = repo.snapshotTypeRegistries()

  let resolvedId = id

  await repo.tx(async tx => {
    // Double-check inside tx: a concurrent createOrFindPlace might have
    // landed between our query and our write. Cheaper than catching the
    // `block_aliases_workspace_alias_unique` trigger throw.
    const raced = await tx.aliasLookup(machineAlias, workspaceId)
    if (raced) {
      resolvedId = raced.id
      return
    }

    await tx.create({
      id,
      workspaceId,
      parentId: locationsPage.id,
      orderKey: keyAtEnd(),
      content,
    })
    await tx.setProperty(id, aliasesProp, [...aliases])
    await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: [...aliases]}, typeSnapshot)
    await repo.addTypeInTx(tx, id, PLACE_TYPE, {[aliasesProp.name]: [...aliases]}, typeSnapshot)

    await tx.setProperty(id, placeLatProp, candidate.lat)
    await tx.setProperty(id, placeLngProp, candidate.lng)
    if (candidate.address !== undefined) await tx.setProperty(id, placeAddressProp, candidate.address)
    if (candidate.googlePlaceId !== undefined) {
      await tx.setProperty(id, placeGooglePlaceIdProp, candidate.googlePlaceId)
    }
    if (candidate.googleMapsUrl !== undefined) {
      await tx.setProperty(id, placeGoogleMapsUrlProp, candidate.googleMapsUrl)
    }
    if (candidate.website !== undefined) await tx.setProperty(id, placeWebsiteProp, candidate.website)
    if (candidate.phone !== undefined) await tx.setProperty(id, placePhoneProp, candidate.phone)
    if (candidate.categories !== undefined && candidate.categories.length > 0) {
      await tx.setProperty(id, placeCategoriesProp, [...candidate.categories])
    }
  }, {scope: ChangeScope.BlockDefault, description: 'create place'})

  return repo.block(resolvedId)
}
