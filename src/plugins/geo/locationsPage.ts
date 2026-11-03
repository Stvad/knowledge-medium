/** Locations-page bootstrap. Eagerly created before workspace landing so
 *  wiki-links resolve to its canonical id. Place blocks live under it. */

import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import {
  getOrCreateKernelPage,
  kernelPageBlockId,
  type KernelPageSpec,
} from '@/data/kernelPage'
import { MAP_TYPE } from './blockTypes'

const LOCATIONS_PAGE_NS = 'f9c4e2a8-3b71-4d6e-9f8a-2c5b8e1d4a7f'
const LOCATIONS_ALIAS = 'Locations'

export const locationsPageSpec: KernelPageSpec = {
  namespace: LOCATIONS_PAGE_NS,
  alias: LOCATIONS_ALIAS,
  markerType: MAP_TYPE,
}

export const locationsPageBlockId = (workspaceId: string): string =>
  kernelPageBlockId(workspaceId, LOCATIONS_PAGE_NS)

export const getOrCreateLocationsPage = (repo: Repo, workspaceId: string): Promise<Block> =>
  // A container of places, so its create never joins an undo step (see
  // `getOrCreateKernelPage`).
  getOrCreateKernelPage(repo, workspaceId, locationsPageSpec, {skipUndo: true})
