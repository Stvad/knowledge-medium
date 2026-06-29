/**
 * App-root mount: the §8 byte claw-back. The OPFS byte store holds decrypted plaintext
 * for every media asset the demand lane has viewed AND — with the down-lane — every asset
 * in each opened workspace. On workspace LEAVE / REVOKE the user's `workspace_members` row
 * leaves the local DB, and PowerSync claws back that workspace's `blocks` rows off the
 * same change; the out-of-band bytes don't ride that row claw-back, so they need their own
 * one-shot purge to match — media revocation handled exactly like note text (design §8).
 *
 * Reactive: tracks the user's membership set and purges a workspace's bytes the moment its
 * membership drops — an online revoke, or an offline one that lands on reconnect (the row
 * leaves the local DB exactly as the block rows do). An account switch RE-BASELINES rather
 * than purging: the other account's bytes are isolation-scoped (a different `user_id`
 * subtree), not revoked. Renders nothing.
 *
 * NOT covered here: a workspace removed while the app was fully closed — its row is already
 * gone at mount, so there's no baseline entry to diff against. Closing that needs an
 * enumeration-based reopen reconcile (purge byte-store workspaces absent from the settled
 * membership set), which wants a byte-store "list workspaces" primitive; deferred with the
 * rest of §8 eviction. The dominant live revoke/leave path (the design's specified hook) is
 * covered.
 */

import { useEffect, useRef } from 'react'
import { useRepo } from '@/context/repo.js'
import { useMyWorkspaceRoles } from '@/hooks/useWorkspaces.js'
import { getByteStore } from './byteStore.js'

export const MediaRevocationPurger = (): null => {
  const repo = useRepo()
  const { rolesByWorkspaceId, isLoading } = useMyWorkspaceRoles()
  // The last settled membership set we diff against, keyed by user so an account switch
  // re-baselines (no purge) instead of reading the other account's workspaces as revoked.
  const baselineRef = useRef<{ userId: string; workspaceIds: Set<string> } | null>(null)

  useEffect(() => {
    if (isLoading) return // wait for a settled membership snapshot
    const userId = repo.user.id
    const current = new Set(rolesByWorkspaceId.keys())
    const baseline = baselineRef.current
    baselineRef.current = { userId, workspaceIds: current }

    // First settled snapshot, or an account switch: establish the baseline, purge nothing.
    // (Additions never purge — only a workspace LEAVING a known baseline is a revoke.)
    if (!baseline || baseline.userId !== userId) return

    for (const workspaceId of baseline.workspaceIds) {
      if (current.has(workspaceId)) continue
      // Membership dropped (leave / revoke / offline-revoke-on-reconnect) → claw back this
      // workspace's plaintext from OPFS. A spurious purge would only cost a re-fetch on
      // next view (graceful degradation, never data loss — §8), so this errs toward purging.
      void getByteStore()
        .purgeWorkspace(userId, workspaceId)
        .catch((err) => console.warn(`[media] revocation byte-purge failed for ${workspaceId}`, err))
    }
  }, [rolesByWorkspaceId, isLoading, repo])

  return null
}
