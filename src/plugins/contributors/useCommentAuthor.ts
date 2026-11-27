import type {Block} from '@/data/block'
import {safeDecodeRowProperty} from '@/data/rowProperty'
import {userPageBlockId} from '@/data/stateBlocks'
import {useHandle} from '@/hooks/block'
import {authorIdOf} from './author'
import {attributionCreatorsProp} from './schema'

/** The rule and the byline identify the same author even while the profile is loading. */
export const useCommentAuthor = (block: Block) => useHandle(block, {
  selector: row => {
    if (!row) return null
    const creators = safeDecodeRowProperty(row, attributionCreatorsProp)
    const id = authorIdOf({creators, createdBy: row.createdBy, workspaceId: row.workspaceId})
    return {
      id,
      isSelf: id === userPageBlockId(row.workspaceId, block.repo.user.id),
      explicit: creators.length > 0,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      workspaceId: row.workspaceId,
    }
  },
})
