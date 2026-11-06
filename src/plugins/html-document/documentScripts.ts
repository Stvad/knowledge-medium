/** Whether a document's scripts run. They can take the keyboard and reach the
 *  network, so they run on sight only where nobody else could have written them,
 *  and otherwise wait for the viewer to allow that version on this device. */

import type {FrameScripts} from './frameDocument.ts'

/** Could only the viewer have written anything in this workspace? Asks whether
 *  anyone else has EVER been a member: current membership proves nothing, since a
 *  member can write a document and then leave, and `blocks.updated_by` is claimed
 *  by the client. Unknown means no. Only a local-only workspace, which no one else
 *  can reach, has no server to say. */
export const isOnlyEverViewer = (hadOtherMembers: number | null | undefined, remoteSync: boolean): boolean =>
  hadOtherMembers === 0 || (hadOtherMembers == null && !remoteSync)

export const decideScripts = ({onlyEverViewer, consentedHash, sourceHash}: {
  onlyEverViewer: boolean
  consentedHash: string | null
  sourceHash: string | null
}): FrameScripts => {
  if (onlyEverViewer) return 'run'
  return sourceHash !== null && consentedHash === sourceHash ? 'run' : 'hold'
}

/** Whether a held document has anything to run, so a static one offers nothing.
 *  Only decides that: a miss costs an offer, and the policy holds regardless. */
export const hasScripts = (source: string): boolean =>
  /<script\b|\bon[a-z]+\s*=|javascript:/i.test(source)
