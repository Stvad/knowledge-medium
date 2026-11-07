import {useMemo, useSyncExternalStore} from 'react'
import {sha256Hex} from '@/sync/crypto/sha256Hex.js'
import type {FrameScripts} from './frameDocument.ts'
import {grantConsent, readConsent, revokeConsent, subscribeToConsent} from './scriptConsent.ts'

interface DocumentScripts {
  mode: FrameScripts
  allow?: () => void
  stop?: () => void
}

/** Whether a held document has anything to run, so a static one offers nothing.
 *  Only decides that: a miss costs an offer, and the policy holds regardless. */
export const hasScripts = (source: string): boolean =>
  /<script\b|\bon[a-z]+\s*=|javascript:/i.test(source)

/** A document's scripts can take the keyboard and reach the network, so they wait
 *  for the viewer to allow that version on this device. Being alone in a workspace
 *  doesn't skip that: current membership can't show who wrote a document, since a
 *  member can write one and then leave. */
export const useDocumentScripts = (blockId: string, source: string): DocumentScripts => {
  const sourceHash = useMemo(() => sha256Hex(new TextEncoder().encode(source)), [source])
  const consentedHash = useSyncExternalStore(subscribeToConsent, () => readConsent(blockId))

  if (consentedHash === sourceHash) return {mode: 'run', stop: () => revokeConsent(blockId)}
  return hasScripts(source)
    ? {mode: 'hold', allow: () => grantConsent(blockId, sourceHash)}
    : {mode: 'hold'}
}
