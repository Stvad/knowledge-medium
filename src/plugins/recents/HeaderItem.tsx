import { Clock } from 'lucide-react'
import { useRepo } from '@/context/repo.js'
import { activeWorkspaceIdPreferringHash, useBlockOpener } from '@/utils/navigation.js'
import { getOrCreateRecentsPage, recentsPageBlockId } from '@/data/recentsPage.js'

export function RecentsHeaderItem() {
  const repo = useRepo()
  const openBlock = useBlockOpener({plainClick: 'navigator'})

  return (
    <button
      className="inline-flex h-7 w-7 items-center justify-center rounded-md p-0 text-sm text-muted-foreground transition-colors hover:text-foreground sm:h-8 sm:w-8"
      onClick={event => {
        // One workspace read for both the id and the gesture — see `openRecents`.
        // Left implicit, the opener would resolve its own and could disagree.
        const workspaceId = activeWorkspaceIdPreferringHash(repo)
        if (!workspaceId) return
        openBlock(event, {blockId: recentsPageBlockId(workspaceId), workspaceId}, {
          ensureTarget: ws => getOrCreateRecentsPage(repo, ws, {skipUndo: true}),
        })
      }}
      title="Recently edited blocks"
      aria-label="Open recents"
    >
      <Clock className="h-4 w-4"/>
    </button>
  )
}
