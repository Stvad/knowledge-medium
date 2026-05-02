import { useCallback, useEffect, useState } from 'react'
import { listMyPendingInvitations } from '@/data/workspaces'
import type { WorkspaceInvitation } from '@/types'

// Pending invitations don't sync via PowerSync (the email-claim filter would
// require threading the JWT into PowerSync sync rules; keeping the path REST-
// only is simpler). Fetch on mount, refresh on demand.
export const usePendingInvitations = () => {
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const result = await listMyPendingInvitations()
      setInvitations(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invitations')
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Fetch-on-mount of an external resource (Supabase RPC). The
  // setState calls inside `refresh` live behind an `await`, but the
  // lint heuristic still flags the kickoff.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  return {invitations, isLoading, error, refresh}
}
