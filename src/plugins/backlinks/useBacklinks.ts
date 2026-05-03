import type { Block } from '@/data/block'
import type { BlockData } from '@/data/api'
import { useData, useHandle } from '@/hooks/block.ts'
import { BACKLINKS_FOR_BLOCK_QUERY } from './query.ts'

const EMPTY_BLOCK_DATA_ARRAY: readonly BlockData[] = Object.freeze([])

/** Reactive backlinks for a block in its workspace. */
export const useBacklinks = (block: Block): Block[] => {
  const repo = block.repo
  const data = useData(block)
  const workspaceId = data?.workspaceId ?? repo.activeWorkspaceId ?? ''
  return useHandle(
    repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId, id: block.id}),
    {
      selector: data => (data ?? EMPTY_BLOCK_DATA_ARRAY).map(d => repo.block(d.id)),
    },
  )
}
