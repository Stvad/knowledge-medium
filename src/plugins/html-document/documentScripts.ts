/** Whether a document's scripts run. They can take the keyboard and reach the
 *  network, so they wait for the viewer to allow that version on this device.
 *  Being alone in a workspace doesn't skip that: current membership can't show who
 *  wrote a document, since a member can write one and then leave. */

import type {FrameScripts} from './frameDocument.ts'

export const decideScripts = (consentedHash: string | null, sourceHash: string | null): FrameScripts =>
  sourceHash !== null && consentedHash === sourceHash ? 'run' : 'hold'

/** Whether a held document has anything to run, so a static one offers nothing.
 *  Only decides that: a miss costs an offer, and the policy holds regardless. */
export const hasScripts = (source: string): boolean =>
  /<script\b|\bon[a-z]+\s*=|javascript:/i.test(source)
