import type { Block } from '@/data/block'
import { useData, useHandle } from '@/hooks/block.ts'
import {
  hasBacklinksFilter,
  type BacklinksFilter,
} from '@/plugins/backlinks/query.ts'
import {
  GROUPED_BACKLINKS_FOR_BLOCK_QUERY,
  type GroupedBacklinksResult,
} from './query.ts'

const EMPTY_GROUPED_BACKLINKS: GroupedBacklinksResult = {
  groups: [],
  total: 0,
}

export const useGroupedBacklinks = (
  block: Block,
  filter?: BacklinksFilter,
): GroupedBacklinksResult => {
  const repo = block.repo
  const data = useData(block)
  const workspaceId = data?.workspaceId ?? repo.activeWorkspaceId ?? ''
  const args = hasBacklinksFilter(filter)
    ? {workspaceId, id: block.id, filter}
    : {workspaceId, id: block.id}
  return useHandle(
    repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY](args),
    {selector: data => data ?? EMPTY_GROUPED_BACKLINKS},
  )
}
