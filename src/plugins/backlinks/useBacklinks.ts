import type { Block } from '@/data/block'
import type { BlockData } from '@/data/api'
import { useHandle } from '@/hooks/block.ts'
import {
  BACKLINKS_FOR_BLOCK_QUERY,
  hasBacklinksFilter,
  type BacklinksFilter,
} from './query.ts'

const EMPTY_BLOCK_DATA_ARRAY: readonly BlockData[] = Object.freeze([])

/** Reactive backlinks for a block in its workspace. */
export const useBacklinks = (
  block: Block,
  workspaceId: string,
  filter?: BacklinksFilter,
): Block[] => {
  const repo = block.repo
  const args = hasBacklinksFilter(filter)
    ? {workspaceId, id: block.id, filter}
    : {workspaceId, id: block.id}
  return useHandle(
    repo.query[BACKLINKS_FOR_BLOCK_QUERY](args),
    {
      selector: data => (data ?? EMPTY_BLOCK_DATA_ARRAY).map(d => repo.block(d.id)),
    },
  )
}
