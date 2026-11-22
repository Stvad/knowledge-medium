import type {PreferencesPage} from '@/data/clientContext'
import {userIdProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {userPageBlockId} from '@/data/stateBlocks'

/** Refuses a configured page that is not the live user page of the user it
 *  names, so a wrong id fails loudly instead of reading defaults. The gate
 *  re-runs this on each wake while closed, so a page a tab repairs later
 *  (`reconcileUserPage`) is admitted without a restart. */
export async function requirePreferencesPage(repo: Repo, {workspaceId, userPageId}: PreferencesPage): Promise<void> {
  const userId = await repo.load(userPageId) ? repo.block(userPageId).peekProperty(userIdProp) : undefined
  if (!userId || userPageBlockId(workspaceId, userId) !== userPageId) {
    throw new Error(`preferencesPage ${userPageId} is not a user page in workspace ${workspaceId}`)
  }
}
