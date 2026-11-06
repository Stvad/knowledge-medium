import {useEffect, useState, useSyncExternalStore} from 'react'
import type {Block} from '@/data/block'
import {computeContentHash} from '@/sync/crypto/contentHash'
import {decideScripts, hasScripts} from './documentScripts.ts'
import type {FrameScripts} from './frameDocument.ts'
import {grantConsent, readConsent, revokeConsent, subscribeToConsent} from './scriptConsent.ts'

export interface DocumentScripts {
  /** Undefined until known. Starting held and then running would load twice, and
   *  starting to run and then holding would run scripts that should have waited. */
  mode: FrameScripts | undefined
  allow?: () => void
  stop?: () => void
}

/** `null` when it can't be hashed, which holds the document; `undefined` while
 *  this source's hash is still on its way. */
const useSourceHash = (source: string): string | null | undefined => {
  const [computed, setComputed] = useState<{source: string; hash: string | null} | null>(null)
  useEffect(() => {
    let current = true
    computeContentHash(new TextEncoder().encode(source))
      .catch(() => null)
      .then(hash => {
        if (current) setComputed({source, hash})
      })
    return () => {
      current = false
    }
  }, [source])
  return computed?.source === source ? computed.hash : undefined
}

export const useDocumentScripts = (block: Block, source: string): DocumentScripts => {
  const sourceHash = useSourceHash(source)
  const consentedHash = useSyncExternalStore(subscribeToConsent, () => readConsent(block.id))

  if (sourceHash === undefined) return {mode: undefined}

  const mode = decideScripts(consentedHash, sourceHash)
  if (mode === 'run') return {mode, stop: () => revokeConsent(block.id)}
  return sourceHash !== null && hasScripts(source)
    ? {mode, allow: () => grantConsent(block.id, sourceHash)}
    : {mode}
}
