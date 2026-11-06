import {useEffect, useState, useSyncExternalStore} from 'react'
import {useQuery} from '@powersync/react'
import type {Block} from '@/data/block'
import {useWorkspaceId} from '@/hooks/block.js'
import {computeContentHash} from '@/sync/crypto/contentHash'
import {decideScripts, hasScripts, isSoleMember} from './documentScripts.ts'
import type {FrameScripts} from './frameDocument.ts'
import {grantConsent, readConsent, revokeConsent, subscribeToConsent} from './scriptConsent.ts'

export interface DocumentScripts {
  /** Undefined until known. Starting held and then running would load twice, and
   *  starting to run and then holding would run scripts that should have waited. */
  mode: FrameScripts | undefined
  allow?: () => void
  stop?: () => void
}

const SELECT_MEMBER_IDS_SQL = 'SELECT user_id FROM workspace_members WHERE workspace_id = ?'

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

/** Keyed on the block's own workspace, not the active one: an embed can show a
 *  document from a workspace other people can write to. */
export const useDocumentScripts = (block: Block, source: string): DocumentScripts => {
  const workspaceId = useWorkspaceId(block, '')
  const {data: members, isLoading} = useQuery<{user_id: string}>(SELECT_MEMBER_IDS_SQL, [workspaceId])
  const sourceHash = useSourceHash(source)
  const consentedHash = useSyncExternalStore(subscribeToConsent, () => readConsent(block.id))

  if (workspaceId === '' || isLoading) return {mode: undefined}
  const memberIds = members.map(member => member.user_id)
  const me = block.repo.user.id
  if (isSoleMember(memberIds, me)) return {mode: 'run'}
  if (sourceHash === undefined) return {mode: undefined}

  const mode = decideScripts({memberIds, me, consentedHash, sourceHash})
  if (mode === 'run') return {mode, stop: () => revokeConsent(block.id)}
  return sourceHash !== null && hasScripts(source)
    ? {mode, allow: () => grantConsent(block.id, sourceHash)}
    : {mode}
}
