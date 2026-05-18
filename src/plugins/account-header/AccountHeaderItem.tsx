import { LogOut } from 'lucide-react'
import { useSignOut, useUser } from '@/components/Login.tsx'
import { useRepo } from '@/context/repo.tsx'
import { useUserBlock } from '@/data/globalState.ts'
import { buildAppHash } from '@/utils/routing.ts'
import { useBlockLinkClick } from '@/utils/navigation.ts'

export function AccountHeaderItem() {
  const user = useUser()
  const signOut = useSignOut()
  const repo = useRepo()
  const userBlock = useUserBlock()
  const workspaceId = repo.activeWorkspaceId
  const handleUserLinkClick = useBlockLinkClick({
    blockId: userBlock.id,
    workspaceId: workspaceId ?? '',
  })

  if (!user || !workspaceId) return null

  const displayName = user.name ?? user.id

  return (
    <div className="flex min-w-0 shrink items-center gap-1 text-xs text-muted-foreground sm:gap-2 sm:text-sm">
      <a
        href={buildAppHash(workspaceId, userBlock.id)}
        onClick={handleUserLinkClick}
        className="block min-w-0 max-w-[7rem] truncate rounded-sm px-0.5 py-1 text-muted-foreground no-underline transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:max-w-none"
      >
        {displayName}
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
