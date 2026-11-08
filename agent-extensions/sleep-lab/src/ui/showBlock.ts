/** Take the user to a Sleep Lab block, and say so when that is refused.
 *
 *  `navigateFromGlobalCommand` resolves to `null` — it never rejects — when a
 *  navigation-policy plugin vetoes the gesture or the navigation errors. A
 *  discarded `null` reports success while leaving the user on the page they
 *  started from, which for a gesture that always lands on the SAME block
 *  (tonight's night, the lab page) is self-perpetuating: nothing changes to
 *  make the next try succeed either. Modelled on the Strength Tracker's
 *  `showSession.ts`.
 */
import type {Repo} from '@/data/repo.js'
import {navigateFromGlobalCommand} from '@/utils/navigation.js'

export const showBlock = async (
  repo: Repo,
  workspaceId: string,
  blockId: string,
  /** What was reached, for the log line: "<what>, but could not be opened". */
  what: string,
): Promise<void> => {
  const shown = await navigateFromGlobalCommand(repo, {blockId, workspaceId})
  if (shown === null) console.warn(`[sleep-lab] ${what}, but could not be opened`, blockId)
}
