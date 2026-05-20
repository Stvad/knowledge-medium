import type { Block } from '@/data/block'
import { useHandle } from '@/hooks/block.ts'
import {
  BACKLINKS_FOR_BLOCK_QUERY,
  hasBacklinksFilter,
  type BacklinksFilter,
} from './query.ts'

const EMPTY_STRING_ARRAY: readonly string[] = Object.freeze([])

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
      selector: data => (data ?? EMPTY_STRING_ARRAY).map(id => repo.block(id)),
    },
  )
}
