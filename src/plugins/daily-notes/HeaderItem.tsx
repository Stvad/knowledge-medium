/** Header button that opens the daily-note picker.
 *
 *  It used to be flanked by prev/next-day chevrons; those now live on the
 *  zoomed-in note's title (`DateNavDecorator.tsx`), where they can navigate
 *  the panel they belong to. The picker stays here because "jump to a date"
 *  is useful from any page, not only from a daily note.
 */
import type { MouseEvent } from 'react'
import { CalendarDays } from 'lucide-react'
import { useRepo } from '@/context/repo.js'
import { openDialog } from '@/utils/dialogs.js'
import { DailyNotePicker } from './DailyNotePicker.tsx'
import { resolveCurrentDailyNoteIso } from './actions.ts'

export function DailyNotePickerHeaderItem() {
  const repo = useRepo()

  const handleClick = async (event: MouseEvent<HTMLButtonElement>) => {
    // Capture the rect synchronously — `event.currentTarget` is nulled
    // after the handler yields once we await below.
    const {bottom, height, left, right, top, width} =
      event.currentTarget.getBoundingClientRect()
    const workspaceId = repo.activeWorkspaceId
    const initialIso = workspaceId
      ? (await resolveCurrentDailyNoteIso(repo, workspaceId)) ?? undefined
      : undefined
    void openDialog(DailyNotePicker, {
      anchorRect: {bottom, height, left, right, top, width},
      initialIso,
    })
  }

  return (
    <button
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground sm:h-8 sm:w-8"
      onClick={event => {
        void handleClick(event).catch(error => {
          console.error('[DailyNotePickerHeaderItem] Open picker failed', error)
        })
      }}
      title="Open daily note picker"
      aria-label="Open daily note picker"
    >
      <CalendarDays className="h-5 w-5"/>
    </button>
  )
}
