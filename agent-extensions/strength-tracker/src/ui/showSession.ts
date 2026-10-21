/** Take the user to a strength block, and say so when that is refused.
 *
 *  Both navigation entry points resolve to `null` — neither rejects — when a
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
import {navigate, navigateFromGlobalCommand} from '@/utils/navigation.js'

export interface ShowSessionTarget {
  workspaceId: string
  blockId: string
  /** The pane the gesture came from, when there is one.
   *
   *  A global command has none and lands wherever the app sends commands (main
   *  on desktop). A gesture made IN a pane — the shortcut, the log page's
   *  button — has one, and swapping that pane is what the user asked for:
   *  `navigateFromGlobalCommand` would take the session to the main pane and
   *  leave the pane they pressed Start in showing what it showed before. */
  panelId?: string
  /** What was reached, for the log line: "<what>, but could not be opened". */
  what: string
}

export const showSession = async (
  repo: Repo,
  {workspaceId, blockId, panelId, what}: ShowSessionTarget,
): Promise<void> => {
  const shown = panelId
    // Not routed through the intent policy: there is no gesture to interpret
    // here — no modifiers, no link — so there is nothing for the policy to
    // decide. The pane IS the answer. Core's own zoom action navigates the
    // same way.
    ? await navigate(repo, {target: 'panel', panelId, blockId, workspaceId, origin: 'strength-session'})
    : await navigateFromGlobalCommand(repo, {blockId, workspaceId})
  if (shown === null) console.warn(`[strength] ${what}, but could not be opened`, blockId)
}
