import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useRepo } from '@/context/repo.js'
import { useBlockOpener } from '@/utils/navigation.js'
import type { DialogContextProps } from '@/utils/dialogs.js'
import { getOrCreateDailyNote } from './dailyNotes.ts'
import { CalendarGrid } from './CalendarGrid.tsx'
import { firstOfMonth, initialDateFromIso } from './calendar.ts'

export interface DailyNotePickerAnchorRect {
  bottom: number
  height: number
  left: number
  right: number
  top: number
  width: number
}

export interface DailyNotePickerProps {
  anchorRect?: DailyNotePickerAnchorRect
  initialIso?: string
}

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

export function DailyNotePicker({
  anchorRect,
  initialIso,
  resolve,
  cancel,
}: DialogContextProps<void> & DailyNotePickerProps) {
  const repo = useRepo()
  const openBlock = useBlockOpener({plainClick: 'navigator'})
  const panelRef = useRef<HTMLDivElement>(null)
  const [selectedIso, setSelectedIso] = useState<string | null>(initialIso ?? null)
  const [visibleMonth, setVisibleMonth] = useState(
    () => firstOfMonth(initialDateFromIso(initialIso)),
  )

  const position = useMemo(() => pickerPosition(anchorRect ?? null), [anchorRect])

  // Read the latest cancel through a ref so the focus/Escape effect
  // (mount-once) doesn't depend on the DialogHost's per-render closure.
  const cancelRef = useRef(cancel)
  useEffect(() => {
    cancelRef.current = cancel
  })

  useEffect(() => {
    panelRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelRef.current()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const openDailyNote = async (iso: string, event: MouseEvent<HTMLButtonElement>) => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return

    setSelectedIso(iso)
    const note = await getOrCreateDailyNote(repo, workspaceId, iso)
    openBlock(event, {blockId: note.id, workspaceId})
    resolve()
  }

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40"
        aria-hidden="true"
        onMouseDown={() => cancel()}
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
