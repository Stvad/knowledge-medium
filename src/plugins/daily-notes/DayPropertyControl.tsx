import type { MouseEvent } from 'react'
import { CalendarDays, X } from 'lucide-react'
import { CompactReferenceLink } from '@/components/references/CompactReferenceLink'
import type { PropertyEditorProps } from '@/data/api'
import { Block } from '@/data/block'
import { storedIsoDay } from '@/utils/dailyPage'
import { openDialog } from '@/utils/dialogs'
import { dailyNoteIsoFromRow, getOrCreateDailyNote } from './dailyNotes'
import { DatePropertyPicker, type DatePropertyPickerProps } from './ReschedulePicker'

const dateButtonClass = 'inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground'

export function DayPropertyControl({block, value, onChange}: PropertyEditorProps<string | undefined>) {
  if (!(block instanceof Block)) return <></>
  const {repo} = block

  const chooseDate = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const workspaceId = block.peek()?.workspaceId
    if (!workspaceId || repo.isReadOnly) return
    const target = value ? repo.block(value).peek() : undefined
    const noteIso = target?.workspaceId === workspaceId ? dailyNoteIsoFromRow(target) : null
    const initialIso = noteIso ?? (value ? storedIsoDay(value) : undefined)

    const trigger = event.currentTarget
    void openDialog<void, DatePropertyPickerProps>(DatePropertyPicker, {
      initialIso,
      anchorRect: trigger.getBoundingClientRect(),
      write: async iso => {
        const owner = await block.load()
        if (owner?.workspaceId !== workspaceId || repo.isReadOnly) return false
        const note = await getOrCreateDailyNote(repo, workspaceId, iso)
        onChange(note.id)
        return true
      },
    }).then(() => trigger.focus({preventScroll: true}))
  }

  return (
    <div className="flex min-w-0 items-center gap-1 text-sm">
      {value ? <CompactReferenceLink owner={block} targetId={value}/>
        : <span className="text-muted-foreground/55">Empty</span>}
      {!repo.isReadOnly && (
        <button type="button" className={dateButtonClass} aria-label="Choose date" title="Choose date"
          aria-haspopup="dialog" onClick={chooseDate}>
          <CalendarDays aria-hidden="true" className="size-4"/>
        </button>
      )}
      {!repo.isReadOnly && value && (
        <button type="button" className={dateButtonClass} aria-label="Clear date" title="Clear date"
          onClick={event => {
            event.stopPropagation()
            onChange('')
          }}>
          <X aria-hidden="true" className="size-3.5"/>
        </button>
      )}
    </div>
  )
}
