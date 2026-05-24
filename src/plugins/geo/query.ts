/** Queries for the geo plugin.
 *
 *  `placesUnderBlock` — drives the map view. Given a root block id,
 *  returns one pin per block in the subtree that has a location:
 *    - Place blocks (PLACE_TYPE) pin at their own lat/lng — so a map
 *      rooted at the Locations page shows every Place.
 *    - Non-Place blocks with `location` set pin at their referenced
 *      Place's lat/lng — so a map rooted at a trip block shows every
 *      activity that has a location.
 *
 *  Dependencies are declared per-row + per-referenced-Place so the
 *  query re-resolves whenever a descendant changes, a referenced Place
 *  moves, or a block's `location` property is added/removed. */

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
      if (isPlace(block)) {
        const pin = pinFromPlace(block, block)
        if (pin) pins.push(pin)
        continue
      }
      const ref = refProp(block, locationProp.name)
      if (ref === undefined) continue
      const place = await loadPlace(ref)
      if (!place || place.deleted) continue
      const pin = pinFromPlace(block, place)
      if (pin) pins.push(pin)
    }

    return pins
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [PLACES_UNDER_BLOCK_QUERY]: typeof placesUnderBlockQuery
  }
}
