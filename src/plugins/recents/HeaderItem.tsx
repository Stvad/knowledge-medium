import { Clock } from 'lucide-react'
import { useRepo } from '@/context/repo.js'
import { useAsyncBlockOpener } from '@/utils/navigation.js'
import { getOrCreateRecentsPage } from '@/data/recentsPage.js'

export function RecentsHeaderItem() {
  const repo = useRepo()
  // Async because the target must be resolved at click time: `recentsPageBlockId`
  // is a derived id, not the live page, and can name a tombstone or nothing.
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
