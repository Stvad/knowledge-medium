import { Clock } from 'lucide-react'
import { useRepo } from '@/context/repo.js'
import { useBlockOpener } from '@/utils/navigation.js'
import { openRecentsPage } from './target.js'

export function RecentsHeaderItem() {
  const repo = useRepo()
  const openBlock = useBlockOpener({plainClick: 'navigator'})

  return (
    <button
      className="inline-flex h-7 w-7 items-center justify-center rounded-md p-0 text-sm text-muted-foreground transition-colors hover:text-foreground sm:h-8 sm:w-8"
      onClick={event => {
        // Materialize before opening, like the daily-note picker does with the
        // same opener: the modifier matrix is resolved from the live event by
        // `openBlock`, which reads it synchronously, so awaiting first costs
        // nothing this surface uses — it has no href for a passthrough to follow.
        void openRecentsPage(repo)
          .then(target => { if (target) openBlock(event, target) })
          .catch(error => { console.error('[recents] could not open Recents', error) })
      }}
      title="Recently edited blocks"
      aria-label="Open recents"
    >
      <Clock className="h-4 w-4"/>
    </button>
  )
}
