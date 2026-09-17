/** Shape helpers for data-layer unit tests. For a wired `Repo` over a
 *  real db, use `createTestRepo`. */

import type { BlockData, BlockReference } from '@/data/api'

interface BlockDataOverrides extends Partial<BlockData> {
  id: string
  workspaceId: string
}

/** Build a domain-shape `BlockData` with sensible defaults. Pass any
 *  override to set a specific field. */
export const makeBlockData = (overrides: BlockDataOverrides): BlockData => ({
  parentId: null,
  orderKey: 'a0',
  content: '',
  properties: {},
  references: [],
  createdAt: 0,
  updatedAt: 0,
  userUpdatedAt: 0,
  createdBy: 'test-user',
  updatedBy: 'test-user',
  deleted: false,
  ...overrides,
})

export const makeReference = (id: string, alias?: string): BlockReference => ({
  id,
  alias: alias ?? id,
})
