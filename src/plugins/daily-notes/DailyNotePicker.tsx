import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils.ts'
import { useRepo } from '@/context/repo.tsx'
import { useNavigateFromGlobalCommand } from '@/utils/navigation.ts'
import { formatIsoDate } from '@/utils/dailyPage.ts'
import {
  type DailyNotePickerAnchorRect,
  type OpenDailyNotePickerEventDetail,
  openDailyNotePickerEvent,
} from './events.ts'
import { getOrCreateDailyNote, todayIso } from './dailyNotes.ts'

interface CalendarCell {
  date: Date | null
  iso: string | null
}

const CALENDAR_CELL_COUNT = 42
const PANEL_WIDTH = 352
const PANEL_MARGIN = 8
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const monthLabel = (date: Date): string =>
  date.toLocaleString('en-US', {month: 'long'})

const firstOfMonth = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), 1)

const fromIso = (iso: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (Number.isNaN(date.getTime())) return null
  return formatIsoDate(date) === iso ? date : null
}

const initialDateFromIso = (iso: string | undefined): Date => {
  if (!iso) return new Date()
  return fromIso(iso) ?? new Date()
}

const addMonths = (date: Date, months: number): Date =>
  new Date(date.getFullYear(), date.getMonth() + months, 1)

const buildCells = (visibleMonth: Date): CalendarCell[] => {
  const year = visibleMonth.getFullYear()
  const month = visibleMonth.getMonth()
  const leadingEmptyCells = (new Date(year, month, 1).getDay() + 6) % 7
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  return Array.from({length: CALENDAR_CELL_COUNT}, (_, index) => {
    const day = index - leadingEmptyCells + 1
    if (day < 1 || day > daysInMonth) return {date: null, iso: null}
    const date = new Date(year, month, day)
    return {date, iso: formatIsoDate(date)}
  })
}

const formatDayLabel = (date: Date): string =>
  date.toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

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
  const navigateFromGlobalCommand = useNavigateFromGlobalCommand()
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [anchorRect, setAnchorRect] = useState<DailyNotePickerAnchorRect | null>(null)
  const [selectedIso, setSelectedIso] = useState<string | null>(null)
  const [visibleMonth, setVisibleMonth] = useState(() => firstOfMonth(new Date()))

  const today = todayIso()
  const cells = useMemo(() => buildCells(visibleMonth), [visibleMonth])
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

  const openDailyNote = async (iso: string) => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return

    setSelectedIso(iso)
    const note = await getOrCreateDailyNote(repo, workspaceId, iso)
    navigateFromGlobalCommand({blockId: note.id, workspaceId})
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
        <div className="mb-3 flex items-center justify-between gap-2">
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            aria-label="Previous month"
            onClick={() => setVisibleMonth(current => addMonths(current, -1))}
          >
            <ChevronLeft className="h-5 w-5"/>
          </button>

          <div className="flex min-w-0 items-baseline justify-center gap-2 text-lg font-semibold">
            <span>{monthLabel(visibleMonth)}</span>
            <span>{visibleMonth.getFullYear()}</span>
          </div>

          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            aria-label="Next month"
            onClick={() => setVisibleMonth(current => addMonths(current, 1))}
          >
            <ChevronRight className="h-5 w-5"/>
          </button>
        </div>

        <div className="mb-2 grid grid-cols-7 border-t pt-3 text-center text-sm font-semibold">
          {WEEKDAY_LABELS.map(day => (
            <div key={day}>{day}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {cells.map((cell, index) => {
            if (!cell.date || !cell.iso) {
              return <div key={`empty-${index}`} className="h-10"/>
            }

            const iso = cell.iso
            const isToday = cell.iso === today
            const isSelected = cell.iso === selectedIso

            return (
              <button
                key={iso}
                type="button"
                aria-label={formatDayLabel(cell.date)}
                aria-current={isToday ? 'date' : undefined}
                className={cn(
                  'inline-flex h-10 items-center justify-center rounded-sm text-base transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  isToday && 'font-semibold text-destructive',
                  isSelected && 'bg-destructive text-destructive-foreground hover:bg-destructive hover:text-destructive-foreground',
                )}
                onClick={() => {
                  void openDailyNote(iso)
                }}
              >
                {cell.date.getDate()}
              </button>
            )
          })}
        </div>
      </div>
    </>,
    document.body,
  )
}
