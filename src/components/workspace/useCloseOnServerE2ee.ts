import { useEffect } from 'react'
import type { Repo } from '@/data/repo.js'
import { readWorkspaceEncryptionMode } from '@/data/workspaceSchema.js'
import { getModePin } from '@/sync/keys/modePin.js'

/**
 * Close an open workspace the moment its synced `encryption_mode` says e2ee
 * while this device's pin doesn't — the server converted it in place
 * (docs/workspace-e2ee-conversion.md §6.2). `onClose` re-resolves the layout,
 * which then shows the gate. Checks once on mount too, since the row may have
 * changed between the layout resolving and this effect subscribing.
 */
export const useCloseOnServerE2ee = (
  db: Repo['db'],
  userId: string,
  workspaceId: string,
  active: boolean,
  onClose: () => void,
): void => {
  useEffect(() => {
    if (!active) return
    let disposed = false
    const check = async () => {
      if (getModePin(userId, workspaceId) === 'e2ee') return
      try {
        const mode = await readWorkspaceEncryptionMode(db, workspaceId)
        if (!disposed && mode === 'e2ee') onClose()
      } catch (err) {
        // The database closing under an account switch, say; the next change re-checks.
        console.warn('[gate] workspace mode read failed', err)
      }
    }
    const unsubscribe = db.onChange(
      {onChange: check, onError: err => console.warn('[gate] workspace mode watch failed', err)},
      {tables: ['workspaces']},
    )
    void check()
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [db, userId, workspaceId, active, onClose])
}
