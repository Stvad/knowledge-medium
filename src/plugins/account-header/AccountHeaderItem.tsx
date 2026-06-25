import { LogOut } from 'lucide-react'
import { useSignOut, useUser } from '@/components/Login.js'
import { useActiveWorkspaceId } from '@/hooks/useWorkspaces.js'
import { userPageBlockId } from '@/data/stateBlocks.js'
import { buildAppHash } from '@/utils/routing.js'
import { useOpenBlock } from '@/utils/navigation.js'

export function AccountHeaderItem() {
  const user = useUser()
  const signOut = useSignOut()
  // Track the active workspace reactively (through the URL hash) so the link
  // re-targets the new workspace's user page on a switch. Deriving the user-page
  // block id from that same workspace id — rather than reading the non-reactive
  // `repo.activeWorkspaceId` pin / `useUserBlock()` — keeps the href and the
  // workspace in lockstep and is what makes the link follow workspace switches.
  const workspaceId = useActiveWorkspaceId()
  const userBlockId = user && workspaceId ? userPageBlockId(workspaceId, user.id) : null
  const handleUserLinkClick = useOpenBlock({
    blockId: userBlockId ?? '',
    workspaceId: workspaceId ?? undefined,
  })

  if (!user || !workspaceId || !userBlockId) return null

  const displayName = user.name ?? user.id

  return (
    <div className="flex min-w-0 shrink items-center gap-1 text-xs text-muted-foreground sm:gap-2 sm:text-sm">
      <a
        href={buildAppHash(workspaceId, userBlockId)}
        onClick={handleUserLinkClick}
        className="inline-flex h-7 min-w-0 max-w-[7rem] items-center rounded-sm px-0.5 leading-none text-muted-foreground no-underline transition-colors hover:text-foreground hover:no-underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:h-8 sm:max-w-none"
      >
        <span className="min-w-0 truncate">{displayName}</span>
      </a>
      <button
        type="button"
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:h-8 sm:w-8"
        onClick={() => { void signOut() }}
        title="Sign out"
        aria-label="Sign out"
      >
        <LogOut className="h-4 w-4"/>
      </button>
    </div>
  )
}
