import type { MouseEvent } from 'react'
import { CalendarDays } from 'lucide-react'
import { openDailyNotePicker } from './events.ts'

export function DailyNotePickerHeaderItem() {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    const {bottom, height, left, right, top, width} =
      event.currentTarget.getBoundingClientRect()
    openDailyNotePicker({
      anchorRect: {bottom, height, left, right, top, width},
    })
  }

  return (
    <button
      className="inline-flex h-8 items-center justify-center rounded-md px-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      onClick={handleClick}
      title="Open daily note picker"
      aria-label="Open daily note picker"
    >
      <CalendarDays className="h-4 w-4"/>
    </button>
  )
}
