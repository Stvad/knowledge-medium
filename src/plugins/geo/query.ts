/** Queries for the geo plugin.
 *
 *  `placesUnderBlock` — drives the map view. Given a root block id,
 *  returns one pin per "block → Place" pairing found in the subtree:
 *    - Place blocks (PLACE_TYPE) pin at their own lat/lng — so a map
 *      rooted at the Locations page shows every Place.
 *    - Non-Place blocks with `location` set pin at their referenced
 *      Place's lat/lng — so a map rooted at a trip block shows every
 *      activity that has a location.
 *    - Non-Place blocks whose body content references a Place via a
 *      wikilink or block-ref (`[[Dandelion]]`, `((uuid))`) pin at
 *      that Place's lat/lng — so a casual mention of a place in a note
 *      surfaces on the map without having to set the `location` prop.
 *      Only body refs (`sourceField === ''`) participate; refs
 *      projected from typed properties go through their own path.
 *
 *  A block that mentions the same place via both its `location` prop
 *  and a body wikilink yields one pin (dedupped by target Place id).
 *
 *  Dependencies are declared per-row (catches descendant content,
 *  property, and reference changes) + per-referenced-Place so the
 *  query re-resolves whenever a descendant changes, a referenced Place
 *  moves, or a block's `location` / body refs change. */

import { z } from 'zod'
import type { BlockData, Schema } from '@/data/api'
import { defineQuery } from '@/data/api'
import type { BlockRow } from '@/data/blockSchema'
import { SUBTREE_SQL } from '@/data/internals/treeQueries'
import { SELECT_BLOCK_BY_ID_SQL } from '@/data/internals/kernelQueries'
import { typesProp } from '@/data/properties'
import { PLACE_TYPE } from './blockTypes'
import {
  locationProp,
  placeAddressProp,
  placeLatProp,
  placeLngProp,
} from './properties'

export const PLACES_UNDER_BLOCK_QUERY = 'geo.placesUnderBlock'

export interface MapPin {
  /** Source block (the thing being pinned — may be a Place or any
   *  block that has a `location` ref). */
  blockId: string
  /** The Place block whose coords we used. Same as `blockId` for
   *  Place-typed sources, the referenced Place otherwise. */
  placeId: string
  /** Display name — the Place's content, used as the marker label. */
  name: string
  lat: number
  lng: number
  /** Formatted address from the referenced Place — used in marker
   *  callouts. Undefined for ad-hoc coord pins. */
  address?: string
}

const pinArraySchema: Schema<MapPin[]> = {
  parse: (input) => input as MapPin[],
}

const asBlockRows = (rows: ReadonlyArray<BlockRow>): ReadonlyArray<Record<string, unknown>> =>
  rows as unknown as ReadonlyArray<Record<string, unknown>>

const isPlace = (block: BlockData): boolean => {
  const raw = block.properties[typesProp.name]
  return Array.isArray(raw) && (raw as unknown[]).includes(PLACE_TYPE)
}

const numProp = (block: BlockData, name: string): number | undefined => {
  const raw = block.properties[name]
  return typeof raw === 'number' ? raw : undefined
}

const refProp = (block: BlockData, name: string): string | undefined => {
  const raw = block.properties[name]
  return typeof raw === 'string' ? raw : undefined
}

const strProp = (block: BlockData, name: string): string | undefined => {
  const raw = block.properties[name]
  return typeof raw === 'string' ? raw : undefined
}

const pinFromPlace = (source: BlockData, place: BlockData): MapPin | null => {
  const lat = numProp(place, placeLatProp.name)
  const lng = numProp(place, placeLngProp.name)
  if (lat === undefined || lng === undefined) return null
  return {
    blockId: source.id,
    placeId: place.id,
    name: place.content,
    lat,
    lng,
    address: strProp(place, placeAddressProp.name),
  }
}

export const placesUnderBlockQuery = defineQuery<{rootBlockId: string}, MapPin[]>({
  name: PLACES_UNDER_BLOCK_QUERY,
  argsSchema: z.object({rootBlockId: z.string()}),
  resultSchema: pinArraySchema,
  resolve: async ({rootBlockId}, ctx) => {
    if (!rootBlockId) return []
    ctx.depend({kind: 'row', id: rootBlockId})
    ctx.depend({kind: 'parent-edge', parentId: rootBlockId})

    const rows = await ctx.db.getAll<BlockRow & {depth: number}>(SUBTREE_SQL, [rootBlockId])
    const blocks = ctx.hydrateBlocks(asBlockRows(rows))

    // Cache resolved Places so a hundred notes pointing at the same
    // Place hit SQL once.
    const placeCache = new Map<string, BlockData | null>()
    const loadPlace = async (id: string): Promise<BlockData | null> => {
      if (placeCache.has(id)) return placeCache.get(id) ?? null
      ctx.depend({kind: 'row', id})
      const row = await ctx.db.getOptional<BlockRow>(SELECT_BLOCK_BY_ID_SQL, [id])
      if (!row) {
        placeCache.set(id, null)
        return null
      }
      const [hydrated] = ctx.hydrateBlocks(asBlockRows([row]))
      placeCache.set(id, hydrated ?? null)
      return hydrated ?? null
    }

    const pins: MapPin[] = []
    for (const block of blocks) {
      ctx.depend({kind: 'parent-edge', parentId: block.id})
      // Row dep so the query re-resolves when any descendant's
      // content / properties / references change — adding `[[Dandelion]]`
      // to a body, removing a `location` prop, etc.
      ctx.depend({kind: 'row', id: block.id})

      if (isPlace(block)) {
        const pin = pinFromPlace(block, block)
        if (pin) pins.push(pin)
        continue
      }

      // Track which Place ids we've already pinned for this source so a
      // block that both `location`-points-at X and body-wikilinks to X
      // doesn't yield two overlapping pins.
      const seen = new Set<string>()
      const tryPin = async (targetId: string): Promise<void> => {
        if (seen.has(targetId)) return
        const place = await loadPlace(targetId)
        if (!place || place.deleted || !isPlace(place)) return
        const pin = pinFromPlace(block, place)
        if (!pin) return
        pins.push(pin)
        seen.add(targetId)
      }

      const locationRef = refProp(block, locationProp.name)
      if (locationRef !== undefined) await tryPin(locationRef)

      for (const ref of block.references) {
        // Body refs only — property-derived refs (sourceField set) are
        // handled by the per-prop path above (today, just `location`).
        if (ref.sourceField !== undefined && ref.sourceField !== '') continue
        await tryPin(ref.id)
      }
    }

    return pins
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [PLACES_UNDER_BLOCK_QUERY]: typeof placesUnderBlockQuery
  }
}
