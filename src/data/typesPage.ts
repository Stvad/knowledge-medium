/** Types-page bootstrap. Thin wrapper around `getOrCreateKernelPage`
 *  with Types-specific args. Each workspace has one Types page;
 *  user-defined block-type blocks live as its children. */

import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { TYPES_PAGE_TYPE } from '@/data/blockTypes'
import {
  getOrCreateKernelPage,
  kernelPageBlockId,
  predictKernelPageId,
  type KernelPageSpec,
} from './kernelPage'

const TYPES_PAGE_NS = 'fd2c1ba0-7c4e-49f7-8a6b-4d56b3e3a5c7'
const TYPES_ALIAS = 'Types'

const TYPES_PAGE_SPEC: KernelPageSpec = {
  namespace: TYPES_PAGE_NS,
  alias: TYPES_ALIAS,
  markerType: TYPES_PAGE_TYPE,
}

export const typesPageBlockId = (workspaceId: string): string =>
  kernelPageBlockId(workspaceId, TYPES_PAGE_NS)

export const getOrCreateTypesPage = (repo: Repo, workspaceId: string): Promise<Block> =>
  getOrCreateKernelPage(repo, workspaceId, TYPES_PAGE_SPEC)

/** Which block currently IS the workspace's Types page, resolved alias-first
 *  and WITHOUT writing anything — see `predictKernelPageId`. Use over
 *  `typesPageBlockId` whenever the answer feeds a write or an existence check:
 *  the live page can sit at an adopted user block's id while the deterministic
 *  row is a tombstone. */
export const resolveTypesPageId = (repo: Repo, workspaceId: string): Promise<string> =>
  predictKernelPageId(repo, workspaceId, TYPES_PAGE_SPEC)
