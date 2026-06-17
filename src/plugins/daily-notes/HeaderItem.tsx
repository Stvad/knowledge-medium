import type { MouseEvent } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { useRepo } from '@/context/repo.js'
import { useRunAction } from '@/shortcuts/runAction.js'
import { openDialog } from '@/utils/dialogs.js'
import { DailyNotePicker } from './DailyNotePicker.tsx'
import {
  OPEN_NEXT_DAILY_NOTE_ACTION_ID,
  OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID,
  resolveCurrentDailyNoteIso,
} from './actions.ts'

const runHeaderActionEvent = (actionId: string) =>
  new CustomEvent('daily-note-header-action', {detail: {actionId}})

export function DailyNotePickerHeaderItem() {
  const repo = useRepo()
  const runAction = useRunAction()

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

  const runDailyNoteAction = (actionId: string) => {
    try {
      void Promise.resolve(runAction(actionId, runHeaderActionEvent(actionId))).catch(error => {
        console.error(`[DailyNotePickerHeaderItem] Action ${actionId} rejected`, error)
      })
    } catch (error) {
      console.error(`[DailyNotePickerHeaderItem] Action ${actionId} threw`, error)
    }
  }

  return (
    <div className="inline-flex h-7 items-center gap-0.5 text-muted-foreground sm:h-8">
      <button
        className="inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:text-foreground sm:h-8 sm:w-8"
        onClick={() => runDailyNoteAction(OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID)}
        title="Open previous daily note"
        aria-label="Open previous daily note"
      >
        <ChevronLeft className="h-5 w-5"/>
      </button>
      <button
        className="inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:text-foreground sm:h-8 sm:w-8"
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
      <button
        className="inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:text-foreground sm:h-8 sm:w-8"
        onClick={() => runDailyNoteAction(OPEN_NEXT_DAILY_NOTE_ACTION_ID)}
        title="Open next daily note"
        aria-label="Open next daily note"
      >
        <ChevronRight className="h-5 w-5"/>
      </button>
    </div>
  )
}
