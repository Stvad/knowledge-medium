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
 *  Friendly-name collisions are preflighted, not attempted: when the
 *  candidate's name is already an alias on a different block, the
 *  doomed create (the alias-uniqueness trigger would roll the whole tx
 *  back) is skipped and a `name-collision` result returned instead, so
 *  callers can resolve the conflict with intent — enrich the existing
 *  block via `addPlaceToExistingBlock`, or retry under another name.
 *
 *  Locations page is bootstrapped lazily on first call. */

import { v4 as uuidv4 } from 'uuid'
import { ChangeScope, type BlockData, type Tx } from '@/data/api'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { PAGE_TYPE } from '@/data/blockTypes'
import { aliasesProp, typesProp } from '@/data/properties'
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

/** The candidate's friendly name is already an alias on another block.
 *  Nothing was created — `existing` is the claimant, so the caller can
 *  offer to enrich it (`addPlaceToExistingBlock`) or retry under a
 *  different name. */
export interface PlaceNameCollision {
  kind: 'name-collision'
  /** The colliding friendly name. */
  name: string
  machineAlias: string
  existing: {
    id: string
    content: string
    /** True when the claimant is itself a Place — enriching it with
     *  these coords would overwrite a different physical location, so
     *  the UI should steer toward create-under-another-name. */
    isPlace: boolean
  }
}

export type CreateOrFindPlaceResult =
  | {kind: 'ok'; block: Block}
  | PlaceNameCollision

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

/** Query-hydrated `BlockData` carries decoded property values. */
const isPlaceData = (block: BlockData): boolean => {
  const raw = block.properties[typesProp.name]
  return Array.isArray(raw) && raw.includes(PLACE_TYPE)
}

/** Tx-level `BlockData` carries encoded property values. */
const txAliases = (block: BlockData): string[] => {
  const encoded = block.properties[aliasesProp.name]
  if (encoded === undefined) return []
  try {
    return [...aliasesProp.codec.decode(encoded)]
  } catch {
    return []
  }
}

const collisionResult = (
  name: string,
  machineAlias: string,
  claimant: BlockData,
): PlaceNameCollision => ({
  kind: 'name-collision',
  name,
  machineAlias,
  existing: {
    id: claimant.id,
    content: claimant.content,
    isPlace: isPlaceData(claimant),
  },
})

const writePlaceProps = async (tx: Tx, id: string, candidate: PlaceCandidate): Promise<void> => {
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
}

export const createOrFindPlace = async (
  repo: Repo,
  workspaceId: string,
  candidate: PlaceCandidate,
): Promise<CreateOrFindPlaceResult> => {
  const machineAlias = placeMachineAlias(candidate)

  // Fast-path: existing block claiming this machine alias. Checked
  // before the name so re-picking the same POI never reads as a
  // collision with itself.
  const existing = await repo.query.aliasLookup({workspaceId, alias: machineAlias}).load()
  if (existing) return {kind: 'ok', block: repo.block(existing.id)}

  const aliases = aliasesFor(candidate, machineAlias)
  const friendlyName = aliases.find(a => a !== machineAlias)
  if (friendlyName !== undefined) {
    const claimant = await repo.query.aliasLookup({workspaceId, alias: friendlyName}).load()
    if (claimant) return collisionResult(friendlyName, machineAlias, claimant)
  }

  const content = contentFor(candidate, machineAlias)
  const id = uuidv4()

  let resolvedId = id
  let racedNameClaim = false

  // One undo entry for Locations-page bootstrap + place creation.
  await repo.undoGroup(async repo => {
    const locationsPage = await getOrCreateLocationsPage(repo, workspaceId)
    const typeSnapshot = repo.snapshotTypeRegistries()

    await repo.tx(async tx => {
      // Double-check inside tx: a concurrent createOrFindPlace might have
      // landed between our query and our write. Cheaper than catching the
      // `block_aliases_workspace_alias_unique` trigger throw.
      const raced = await tx.aliasLookup(machineAlias, workspaceId)
      if (raced) {
        resolvedId = raced.id
        return
      }
      if (friendlyName !== undefined) {
        const racedName = await tx.aliasLookup(friendlyName, workspaceId)
        if (racedName) {
          racedNameClaim = true
          return
        }
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

      await writePlaceProps(tx, id, candidate)
    }, {scope: ChangeScope.BlockDefault, description: 'create place'})
  })

  if (racedNameClaim && friendlyName !== undefined) {
    // Re-read outside the tx for the claimant's display info; if it
    // vanished in the meantime the name is free again — retry.
    const claimant = await repo.query.aliasLookup({workspaceId, alias: friendlyName}).load()
    if (claimant === null) return createOrFindPlace(repo, workspaceId, candidate)
    return collisionResult(friendlyName, machineAlias, claimant)
  }

  return {kind: 'ok', block: repo.block(resolvedId)}
}

/** Resolve a `name-collision` by enriching the claimant in place: tag
 *  it as a Place (and page), write the coords/Google props, and append
 *  the machine alias so future `createOrFindPlace` calls for the same
 *  POI dedup onto it. Content and existing aliases are preserved —
 *  the block keeps being whatever the user made it, it just gains a
 *  location. */
export const addPlaceToExistingBlock = async (
  repo: Repo,
  blockId: string,
  candidate: PlaceCandidate,
): Promise<Block> => {
  const machineAlias = placeMachineAlias(candidate)
  const typeSnapshot = repo.snapshotTypeRegistries()

  await repo.tx(async tx => {
    const block = await tx.get(blockId)
    if (!block || block.deleted) {
      throw new Error(`addPlaceToExistingBlock: block ${blockId} not found`)
    }
    const aliases = txAliases(block)
    if (!aliases.includes(machineAlias)) {
      await tx.setProperty(blockId, aliasesProp, [...aliases, machineAlias])
    }
    await repo.addTypeInTx(tx, blockId, PAGE_TYPE, {}, typeSnapshot)
    await repo.addTypeInTx(tx, blockId, PLACE_TYPE, {}, typeSnapshot)
    await writePlaceProps(tx, blockId, candidate)
  }, {scope: ChangeScope.BlockDefault, description: 'add place to existing block'})

  return repo.block(blockId)
}
