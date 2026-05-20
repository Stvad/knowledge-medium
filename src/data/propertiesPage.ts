/** Properties-page bootstrap. Thin wrapper around `getOrCreateKernelPage`
 *  with Properties-specific args. Each workspace has one Properties page;
 *  user-defined property-schema blocks live as its children. */

import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { PROPERTIES_PAGE_TYPE } from '@/data/blockTypes'
import { getOrCreateKernelPage, kernelPageBlockId } from './kernelPage'

const PROPERTIES_PAGE_NS = '94f9a6d9-c651-4b75-aef3-a5c1bbef0e1a'
const PROPERTIES_ALIAS = 'Properties'

export const propertiesPageBlockId = (workspaceId: string): string =>
  kernelPageBlockId(workspaceId, PROPERTIES_PAGE_NS)

export const getOrCreatePropertiesPage = (repo: Repo, workspaceId: string): Promise<Block> =>
  getOrCreateKernelPage(repo, workspaceId, {
    namespace: PROPERTIES_PAGE_NS,
    alias: PROPERTIES_ALIAS,
    markerType: PROPERTIES_PAGE_TYPE,
  })
