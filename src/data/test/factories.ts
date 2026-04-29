/** Test factories for the data layer. Concrete `createTestRepo` lands
 *  alongside the new `Repo` in stage 1.3 of the data-layer redesign;
 *  this file currently exports tiny shape helpers used by 1.1 / 1.2
 *  unit tests. */

import type { BlockData, BlockReference } from '@/data/api'

interface BlockDataOverrides extends Partial<BlockData> {
  id: string
  workspaceId: string
}

/** Build a domain-shape `BlockData` with sensible defaults. Pass any
 *  override to set a specific field; the helper is used by snapshot
 *  tests, cache tests, and the migration-shape unit tests. */
export const makeBlockData = (overrides: BlockDataOverrides): BlockData => ({
  parentId: null,
  orderKey: 'a0',
  content: '',
  properties: {},
  references: [],
  createdAt: 0,
  updatedAt: 0,
  createdBy: 'test-user',
  updatedBy: 'test-user',
  deleted: false,
  ...overrides,
})

export const makeReference = (id: string, alias?: string): BlockReference => ({
  id,
  alias: alias ?? id,
})
