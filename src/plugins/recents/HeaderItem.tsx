import { Clock } from 'lucide-react'
import { useRepo } from '@/context/repo.js'
import { useBlockOpener } from '@/utils/navigation.js'
import { getOrCreateRecentsPage, recentsPageBlockId } from '@/data/recentsPage.js'

export function RecentsHeaderItem() {
  const repo = useRepo()
  const openBlock = useBlockOpener({plainClick: 'navigator'})

  return (
    <button
      className="inline-flex h-7 w-7 items-center justify-center rounded-md p-0 text-sm text-muted-foreground transition-colors hover:text-foreground sm:h-8 sm:w-8"
      onClick={event => {
        const workspaceId = repo.activeWorkspaceId
        if (!workspaceId) return
        // `ensureSystemPages` reports a failing `ensure` and carries on, so
        // this page can be absent for the rest of the session (see the
        // `SystemPage` doc). Get-or-creating at the point of use is what the
        // Journal and Locations pages already do — here the id is enough to
        // navigate on, because it is derived rather than read (#931).
        openBlock(event, {
          blockId: recentsPageBlockId(workspaceId),
          ensure: () => getOrCreateRecentsPage(repo, workspaceId),
        })
      }}
      title="Recently edited blocks"
      aria-label="Open recents"
    >
      <Clock className="h-4 w-4"/>
    </button>
  )
}
