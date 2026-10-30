import {isSystemAuthor} from '@/data/api/user'
import {userPageBlockId} from '@/data/stateBlocks'

/** The block that names a block's author: its first recorded creator, which
 *  every agent write has, else the page of its `created_by` user, because
 *  human-only writes record no attribution. `created_by` alone would be wrong
 *  for agents: bridge and MCP writes run in the tab and stamp its human user.
 *  Undefined for a system author, which is no user. */
export const authorIdOf = ({creators, createdBy, workspaceId}: {
  creators: readonly string[]
  createdBy: string
  workspaceId: string
}): string | undefined =>
  creators[0] ?? (createdBy && !isSystemAuthor(createdBy) ? userPageBlockId(workspaceId, createdBy) : undefined)
