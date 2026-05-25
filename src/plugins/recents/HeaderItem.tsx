import { Clock } from 'lucide-react'
import { useRepo } from '@/context/repo.js'
import { useNavigateFromGlobalCommand } from '@/utils/navigation.js'
import { recentsPageBlockId } from '@/data/recentsPage.js'

export function RecentsHeaderItem() {
  const repo = useRepo()
  const navigate = useNavigateFromGlobalCommand()

  return (
    <button
      className="inline-flex h-7 w-7 items-center justify-center rounded-md p-0 text-sm text-muted-foreground transition-colors hover:text-foreground sm:h-8 sm:w-8"
      onClick={() => {
        const workspaceId = repo.activeWorkspaceId
        if (!workspaceId) return
        navigate({blockId: recentsPageBlockId(workspaceId)})
      }}
      title="Recently edited blocks"
      aria-label="Open recents"
    >
      <Clock className="h-4 w-4"/>
    </button>
  )
}
