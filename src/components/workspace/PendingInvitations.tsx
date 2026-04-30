import { useMemo, useState } from 'react'
import { Mail } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { usePendingInvitations } from '@/hooks/usePendingInvitations'
import { acceptInvitation, declineInvitation } from '@/data/workspaces'
import { buildAppHash } from '@/utils/routing'
import { useHash } from 'react-use'
import { useIsLocalOnly } from '@/components/Login'

export function PendingInvitations() {
  // Pending invitations are a Supabase RPC; in local-only mode the call
  // throws "Supabase is not configured". Skip rendering (and thus the
  // eager fetch on mount) entirely.
  const localOnly = useIsLocalOnly()
  if (localOnly) return null
  return <PendingInvitationsInner />
}

function PendingInvitationsInner() {
  const {invitations, refresh} = usePendingInvitations()
  const [, setHash] = useHash()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const count = invitations.length
  const label = useMemo(() => count === 0 ? 'No invitations' : `${count} invitation${count > 1 ? 's' : ''}`, [count])

  if (count === 0) return null

  const accept = async (id: string, workspaceId: string) => {
    setBusyId(id); setError(null)
    try {
      await acceptInvitation(id)
      await refresh()
      // Hand off to App.tsx by changing the hash. App subscribes to it via
      // useHash and will re-resolve through getInitialBlock — which will
      // poll local sqlite for the workspace's blocks to arrive over
      // PowerSync once the new membership row replicates.
      setHash(buildAppHash(workspaceId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept invitation')
      setBusyId(null)
    }
  }

  const decline = async (id: string) => {
    setBusyId(id); setError(null)
    try {
      await declineInvitation(id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to decline invitation')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="relative flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          aria-label={label}
        >
          <Mail className="h-4 w-4" />
          <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 rounded-full bg-primary text-[10px] font-medium text-primary-foreground flex items-center justify-center px-1">
            {count}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Pending invitations</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ul className="max-h-80 overflow-y-auto">
          {invitations.map((inv) => (
            <li key={inv.id} className="px-2 py-2 text-sm space-y-2">
              <div className="space-y-0.5">
                <div className="font-medium truncate">{inv.workspaceName ?? inv.workspaceId}</div>
                <div className="text-xs text-muted-foreground">
                  Joining as <span className="font-medium">{inv.role}</span>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={busyId === inv.id}
                  onClick={() => void accept(inv.id, inv.workspaceId)}
                >
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  disabled={busyId === inv.id}
                  onClick={() => void decline(inv.id)}
                >
                  Decline
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {error && (
          <p className="px-2 py-1 text-xs text-destructive">{error}</p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
