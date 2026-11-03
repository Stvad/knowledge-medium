import { useEffect } from 'react'
import type { Repo } from '@/data/repo.js'
import { onWorkspaceKeyUnavailable } from '@/sync/keys/openWorkspaceKeys.js'

/**
 * Close the open workspace the moment a key read finds this device holds no
 * key for it (`requireWorkspaceKeys`) — the record disappeared after the entry
 * gate checked it. `onClose` re-resolves the layout into the key gate, which
 * makes the workspace read-only once the layout is hidden: an editor's pending
 * write still lands as it unmounts, and writes that need the key throw anyway.
 *
 * `opening` is the ready layout, a new object per resolution, so a re-resolve
 * that finds the key after all re-arms the watch. Once per opening: every
 * queued upload retry reads the key again.
 */
export const useCloseOnKeyLoss = (
  repo: Repo,
  opening: {readonly workspaceId: string} | null,
  onClose: () => void,
): void => {
  useEffect(() => {
    if (!opening) return
    let closed = false
    return onWorkspaceKeyUnavailable((userId, lockedId) => {
      if (closed || userId !== repo.user.id || lockedId !== opening.workspaceId) return
      // Mid-navigation this opening is stale; the next workspace's entry check decides.
      if (opening.workspaceId !== repo.activeWorkspaceId) return
      closed = true
      onClose()
    })
  }, [repo, opening, onClose])
}
