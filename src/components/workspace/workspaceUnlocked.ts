/**
 * A workspace this device just unlocked from outside its gate — the
 * conversion flow's pin upgrade — so the gate showing it resolves, and the app
 * opens the workspace, without waiting for a reload.
 */

import { useEffect } from 'react'
import { CallbackSet } from '@/utils/callbackSet'

const unlocked = new CallbackSet<[workspaceId: string]>('workspaceUnlocked')

export const notifyWorkspaceUnlocked = (workspaceId: string): void => unlocked.notify(workspaceId)

export const useOnWorkspaceUnlocked = (workspaceId: string, onUnlocked: () => void): void => {
  useEffect(() => unlocked.add(id => { if (id === workspaceId) onUnlocked() }), [workspaceId, onUnlocked])
}
