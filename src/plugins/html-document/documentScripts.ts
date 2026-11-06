/** Whether a document's scripts run. They can take the keyboard and reach the
 *  network, so they run on sight only where nobody else could have written them,
 *  and otherwise wait for the viewer to allow that version on this device. */

import type {FrameScripts} from './frameDocument.ts'

/** Fails closed: no rows yet means the membership hasn't arrived, not "alone". */
export const isSoleMember = (memberIds: readonly string[], me: string): boolean =>
  memberIds.length > 0 && memberIds.every(id => id === me)

export const decideScripts = ({memberIds, me, consentedHash, sourceHash}: {
  memberIds: readonly string[]
  me: string
  consentedHash: string | null
  sourceHash: string | null
}): FrameScripts => {
  if (isSoleMember(memberIds, me)) return 'run'
  return sourceHash !== null && consentedHash === sourceHash ? 'run' : 'hold'
}

/** Whether a held document has anything to run, so a static one offers nothing.
 *  Only decides that: a miss costs an offer, and the policy holds regardless. */
export const hasScripts = (source: string): boolean =>
  /<script\b|\bon[a-z]+\s*=|javascript:/i.test(source)
