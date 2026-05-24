/**
 * Calendar grid shared by `DailyNotePicker` (daily-note navigation,
 * popover) and `ReschedulePicker` (mobile reschedule sheet). The
 * date math, layout, and accessibility attributes are identical
 * between the two callers; only the highlight color of "today" and
 * "selected" differed historically — `variant` lets each caller pick
 * its tone without forking the component.
 *
 * The grid renders only the month nav + weekday header + day cells.
 * Each caller wraps it in their own chrome (popover / bottom sheet)
 * and supplies their own `onSelect` handler — navigation vs. write.
 */
import { useMemo, type MouseEvent } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils.js'
import { todayIso } from './dailyNotes.ts'
import {
  CALENDAR_WEEKDAY_LABELS,
  addMonths,
  buildCalendarCells,
  formatDayLabel,
  monthLabel,
} from './calendar.ts'

export type CalendarGridVariant = 'destructive' | 'primary'

export interface CalendarGridProps {
  /** First-of-month date driving which 6-week block is shown. */
  visibleMonth: Date
  onVisibleMonthChange: (next: Date) => void
  /** ISO of the currently highlighted day, or null for "no selection
   *  yet". */
  selectedIso: string | null
  /** Fires when the user taps a day cell. The caller decides what
   *  "select" means (navigate vs. write). */
  onSelect: (iso: string, event: MouseEvent<HTMLButtonElement>) => void
  /** Greys out the grid while a write is in flight. Day cells stay
   *  rendered so the user sees what they picked; they're just
   *  un-clickable until the writer settles. */
  disabled?: boolean
  /** Tone for the today / selected highlights. `destructive` is the
   *  existing daily-note picker red accent; `primary` is the
   *  reschedule sheet's blue. Default `primary`. */
  variant?: CalendarGridVariant
  /** Tailwind-style class injection for fine layout tweaks at the
   *  call site (e.g. `h-10` vs `h-9` cells). Optional; sensible
   *  defaults otherwise. */
  cellClassName?: string
}

interface VariantClasses {
  todayText: string
  selectedBg: string
}

const VARIANT_CLASSES: Record<CalendarGridVariant, VariantClasses> = {
  destructive: {
    todayText: 'font-semibold text-destructive',
    selectedBg: 'bg-destructive text-destructive-foreground hover:bg-destructive hover:text-destructive-foreground',
  },
  primary: {
    todayText: 'font-semibold text-primary',
    selectedBg: 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
  },
}

export const CalendarGrid = ({
  visibleMonth,
  onVisibleMonthChange,
  selectedIso,
  onSelect,
  disabled = false,
  variant = 'primary',
  cellClassName,
}: CalendarGridProps) => {
  const today = todayIso()
  const cells = useMemo(() => buildCalendarCells(visibleMonth), [visibleMonth])
  const tone = VARIANT_CLASSES[variant]

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-label="Previous month"
          onClick={() => onVisibleMonthChange(addMonths(visibleMonth, -1))}
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
          onClick={() => onVisibleMonthChange(addMonths(visibleMonth, 1))}
        >
          <ChevronRight className="h-5 w-5"/>
        </button>
      </div>

      <div className="mb-2 grid grid-cols-7 border-t pt-3 text-center text-sm font-semibold">
        {CALENDAR_WEEKDAY_LABELS.map(day => (
          <div key={day}>{day}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell, index) => {
          if (!cell.date || !cell.iso) {
            return <div key={`empty-${index}`} className={cn('h-10', cellClassName)}/>
          }

          const iso = cell.iso
          const isToday = cell.iso === today
          const isSelected = cell.iso === selectedIso

          return (
            <button
              key={iso}
              type="button"
              disabled={disabled}
              aria-label={formatDayLabel(cell.date)}
              aria-current={isToday ? 'date' : undefined}
              onClick={event => onSelect(iso, event)}
              className={cn(
                'inline-flex h-10 items-center justify-center rounded-sm text-base transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
                isToday && tone.todayText,
                isSelected && tone.selectedBg,
                cellClassName,
              )}
            >
              {cell.date.getDate()}
            </button>
          )
        })}
      </div>
    </>
  )
}
