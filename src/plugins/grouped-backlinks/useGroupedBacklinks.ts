import type { Block } from '@/data/block'
import { useHandle } from '@/hooks/block.ts'
import {
  hasBacklinksFilter,
  type BacklinksFilter,
} from '@/plugins/backlinks/query.ts'
import type { GroupedBacklinksConfig } from './config.ts'
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
  workspaceId: string,
  groupingConfig: GroupedBacklinksConfig,
  filter?: BacklinksFilter,
): GroupedBacklinksResult => {
  const repo = block.repo
  const args = {
    workspaceId,
    id: block.id,
    groupingConfig,
    ...(hasBacklinksFilter(filter) ? {filter} : {}),
  }
  return useHandle(
    repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY](args),
    {selector: data => data ?? EMPTY_GROUPED_BACKLINKS},
  )
}
