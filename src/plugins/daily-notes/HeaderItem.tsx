import type { MouseEvent } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { useRunAction } from '@/shortcuts/runAction.ts'
import { openDailyNotePicker } from './events.ts'
import {
  OPEN_NEXT_DAILY_NOTE_ACTION_ID,
  OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID,
} from './actions.ts'

const runHeaderActionEvent = (actionId: string) =>
  new CustomEvent('daily-note-header-action', {detail: {actionId}})

export function DailyNotePickerHeaderItem() {
  const runAction = useRunAction()

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    const {bottom, height, left, right, top, width} =
      event.currentTarget.getBoundingClientRect()
    openDailyNotePicker({
      anchorRect: {bottom, height, left, right, top, width},
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
    <div className="inline-flex h-8 items-center gap-0.5 text-muted-foreground">
      <button
        className="inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:text-foreground"
        onClick={() => runDailyNoteAction(OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID)}
        title="Open previous daily note"
        aria-label="Open previous daily note"
      >
        <ChevronLeft className="h-5 w-5"/>
      </button>
      <button
        className="inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:text-foreground"
        onClick={handleClick}
        title="Open daily note picker"
        aria-label="Open daily note picker"
      >
        <CalendarDays className="h-5 w-5"/>
      </button>
      <button
        className="inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:text-foreground"
        onClick={() => runDailyNoteAction(OPEN_NEXT_DAILY_NOTE_ACTION_ID)}
        title="Open next daily note"
        aria-label="Open next daily note"
      >
        <ChevronRight className="h-5 w-5"/>
      </button>
    </div>
  )
}
