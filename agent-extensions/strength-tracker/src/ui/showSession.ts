/** Take the user to a strength block, and say so when that is refused.
 *
 *  `navigateFromGlobalCommand` resolves to `null` — it never rejects — when a
 *  navigation-policy plugin vetoes the gesture or the navigation errors. A
 *  discarded `null` reports success while leaving you on the page you started
 *  from, and for a session it is self-perpetuating: the one it failed to open
 *  is now standing, so every later Start navigates into the same veto and the
 *  action can never appear to do anything again.
 *
 *  Its own module because every command here ends in a navigation and they all
 *  need the same rule. It lived inline on one path, which is exactly how three
 *  other call sites came to discard their result.
 */

import type {Repo} from '@/data/repo.js'
import {navigateFromGlobalCommand} from '@/utils/navigation.js'

export const showSession = async (
  repo: Repo,
  workspaceId: string,
  blockId: string,
  /** What was reached, for the log line: "<what>, but could not be opened". */
  what: string,
): Promise<void> => {
  const shown = await navigateFromGlobalCommand(repo, {blockId, workspaceId})
  if (shown === null) console.warn(`[strength] ${what}, but could not be opened`, blockId)
}
