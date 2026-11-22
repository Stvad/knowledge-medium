import {userIdProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {userPageBlockId} from '@/data/stateBlocks'

/** Refuses a configured `preferencesPage` that is not a live user page of
 *  `workspaceId`, so a wrong id fails loudly instead of reading defaults. */
export async function requirePreferencesPage(repo: Repo, workspaceId: string, id: string): Promise<void> {
  const row = await repo.load(id)
  const userId = row?.workspaceId === workspaceId ? repo.block(id).peekProperty(userIdProp) : undefined
  if (!userId || userPageBlockId(workspaceId, userId) !== id) {
    throw new Error(`preferencesPage ${id} is not a user page in workspace ${workspaceId}`)
  }
}
