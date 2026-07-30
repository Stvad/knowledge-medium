import { Clock } from 'lucide-react'
import { useRepo } from '@/context/repo.js'
import { useAsyncBlockOpener } from '@/utils/navigation.js'
import { getOrCreateRecentsPage } from '@/data/recentsPage.js'

export function RecentsHeaderItem() {
  const repo = useRepo()
  // Async opener because the Recents page id is only known after resolving
  // live state: since issue #378 kernel pages resolve alias-first, so the raw
  // `recentsPageBlockId` can be a tombstone (a live block adopted the
  // 'Recents' alias) or absent (bootstrap never ran). Get-or-create both
  // adopts an existing claimant and creates the page, so this can't land on a
  // dead id. The hook keeps the click's modifier semantics intact — see
  // `openAsyncBlockFromEvent`.
  const openBlock = useAsyncBlockOpener({plainClick: 'navigator'})

  return (
    <button
      className="inline-flex h-7 w-7 items-center justify-center rounded-md p-0 text-sm text-muted-foreground transition-colors hover:text-foreground sm:h-8 sm:w-8"
      onClick={event => openBlock(event, async workspaceId => ({
        blockId: (await getOrCreateRecentsPage(repo, workspaceId)).id,
      }))}
      title="Recently edited blocks"
      aria-label="Open recents"
    >
      <Clock className="h-4 w-4"/>
    </button>
  )
}
