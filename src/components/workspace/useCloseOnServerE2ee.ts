import { useEffect } from 'react'
import type { PowerSyncDb } from '@/data/internals/commitPipeline.js'
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
  db: PowerSyncDb,
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
      const mode = await readWorkspaceEncryptionMode(db, workspaceId)
      if (!disposed && mode === 'e2ee') onClose()
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
