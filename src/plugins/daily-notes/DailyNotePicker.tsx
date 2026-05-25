import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useRepo } from '@/context/repo.js'
import { useBlockOpener } from '@/utils/navigation.js'
import {
  type DailyNotePickerAnchorRect,
  type OpenDailyNotePickerEventDetail,
  openDailyNotePickerEvent,
} from './events.ts'
import { getOrCreateDailyNote } from './dailyNotes.ts'
import { CalendarGrid } from './CalendarGrid.tsx'
import { firstOfMonth, initialDateFromIso } from './calendar.ts'

const PANEL_WIDTH = 352
const PANEL_MARGIN = 8

const pickerPosition = (
  anchorRect: DailyNotePickerAnchorRect | null,
): CSSProperties => {
  if (!anchorRect || typeof window === 'undefined') {
    return {left: '50%', top: 72, transform: 'translateX(-50%)'}
  }

  const availableWidth = window.innerWidth
  const centeredLeft = anchorRect.left + anchorRect.width / 2 - PANEL_WIDTH / 2
  const left = Math.min(
    Math.max(PANEL_MARGIN, centeredLeft),
    Math.max(PANEL_MARGIN, availableWidth - PANEL_WIDTH - PANEL_MARGIN),
  )

  return {
    left,
    top: anchorRect.bottom + PANEL_MARGIN,
  }
}

export function DailyNotePicker() {
  const repo = useRepo()
  const openBlock = useBlockOpener({plainClick: 'navigator'})
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [anchorRect, setAnchorRect] = useState<DailyNotePickerAnchorRect | null>(null)
  const [selectedIso, setSelectedIso] = useState<string | null>(null)
  const [visibleMonth, setVisibleMonth] = useState(() => firstOfMonth(new Date()))

  const position = useMemo(() => pickerPosition(anchorRect), [anchorRect])

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenDailyNotePickerEventDetail>).detail ?? {}
      const initialDate = initialDateFromIso(detail.initialIso)
      setAnchorRect(detail.anchorRect ?? null)
      setSelectedIso(detail.initialIso ?? null)
      setVisibleMonth(firstOfMonth(initialDate))
      setOpen(true)
    }

    window.addEventListener(openDailyNotePickerEvent, handleOpen)
    return () => window.removeEventListener(openDailyNotePickerEvent, handleOpen)
  }, [])

  useEffect(() => {
    if (!open) return

    panelRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open])

  const openDailyNote = async (iso: string, event: MouseEvent<HTMLButtonElement>) => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return

    setSelectedIso(iso)
    const note = await getOrCreateDailyNote(repo, workspaceId, iso)
    openBlock(event, {blockId: note.id, workspaceId})
    setOpen(false)
  }

  if (!open) return null

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40"
        aria-hidden="true"
        onMouseDown={() => setOpen(false)}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Daily note picker"
        tabIndex={-1}
        className="fixed z-50 w-[min(22rem,calc(100vw-1rem))] rounded-md border bg-popover p-3 text-popover-foreground shadow-lg outline-none"
        style={position}
      >
        <CalendarGrid
          visibleMonth={visibleMonth}
          onVisibleMonthChange={setVisibleMonth}
          selectedIso={selectedIso}
          onSelect={(iso, event) => void openDailyNote(iso, event)}
          variant="destructive"
        />
      </div>
    </>,
    document.body,
  )
}
