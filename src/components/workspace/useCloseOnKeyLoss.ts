import { useEffect } from 'react'
import type { Repo } from '@/data/repo.js'
import { onWorkspaceKeyUnavailable } from '@/sync/keys/openWorkspaceKeys.js'

/**
 * Close an open workspace the moment a key read finds this device holds no key
 * for it (`requireWorkspaceKeys`) — the record disappeared after the entry gate
 * checked it. Read-only at once, as the gate leaves a locked workspace; then
 * `onClose` re-resolves the layout, which shows the key gate. Once per opening:
 * every queued upload retry reads the key again.
 */
export const useCloseOnKeyLoss = (
  repo: Repo,
  workspaceId: string,
  active: boolean,
  onClose: () => void,
): void => {
  useEffect(() => {
    if (!active) return
    let closed = false
    return onWorkspaceKeyUnavailable((userId, lockedId) => {
      if (closed || userId !== repo.user.id || lockedId !== workspaceId) return
      closed = true
      repo.setReadOnly(true)
      onClose()
    })
  }, [repo, workspaceId, active, onClose])
}
