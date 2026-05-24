/** Locations-page bootstrap — singleton per workspace, lazy. Each Place
 *  block lives as a child of this page. Created on demand by
 *  `createOrFindPlace` (Phase C), never at workspace init — mirrors the
 *  daily-notes lazy pattern rather than the kernel's
 *  PROPERTIES_PAGE/TYPES_PAGE which are bootstrapped from the data
 *  extension. */

import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import {
  getOrCreateKernelPage,
  kernelPageBlockId,
} from '@/data/kernelPage'
import { MAP_TYPE } from './blockTypes'

const LOCATIONS_PAGE_NS = 'f9c4e2a8-3b71-4d6e-9f8a-2c5b8e1d4a7f'
const LOCATIONS_ALIAS = 'Locations'

export const locationsPageBlockId = (workspaceId: string): string =>
  kernelPageBlockId(workspaceId, LOCATIONS_PAGE_NS)

export const getOrCreateLocationsPage = (repo: Repo, workspaceId: string): Promise<Block> =>
  getOrCreateKernelPage(repo, workspaceId, {
    namespace: LOCATIONS_PAGE_NS,
    alias: LOCATIONS_ALIAS,
    // Just a generic Map-typed block — there's nothing special about
    // the Locations page besides its alias and being the default
    // parent for Place blocks. Renaming this type to `MAP_TYPE`
    // automatically heals existing pages: kernelPage's repair path
    // sees the missing marker on next createOrFindPlace and adds it.
    markerType: MAP_TYPE,
  })
