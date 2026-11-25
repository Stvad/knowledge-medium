/**
 * Mobile reschedule sheet — opened by the "Reschedule" quick action on
 * the swipe menu, dismissed on commit / outside-tap / Escape.
 *
 * Layout mirrors what the user sketched in the option-4 + option-1 mix:
 *   [ chips:  Today | Tomorrow | +1w | +1m ]
 *   [ month grid (tap a day to commit)     ]
 *   [ horizontal date strip (scrub/tap)    ]
 *
 * The sheet asks the `blockDateAdapterFacet` for an adapter the moment
 * it opens, then routes both reads ("what's the current date?") and
 * writes ("commit this ISO") through that adapter — so SRS blocks adjust
 * `srsNextReviewDateProp` while content-date blocks rewrite the inline
 * wikilink, all behind the same UI.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils.js'
import { useAnchoredFloating } from '@/components/ui/anchored-floating.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { useRepo } from '@/context/repo.js'
import { useIsMobile } from '@/utils/react.js'
import { parseIsoDay } from '@/utils/dailyPage.js'
import type { DialogContextProps } from '@/utils/dialogs.js'
import { addDaysIso, todayIso } from './dailyNotes.ts'
import { pickBlockDateAdapter } from './blockDateAdapter.ts'
import { CalendarGrid } from './CalendarGrid.tsx'
import { firstOfMonth, formatDayLabel } from './calendar.ts'

export interface ReschedulePickerAnchorRect {
  bottom: number
  height: number
  left: number
  right: number
  top: number
  width: number
}

/** Resolved by `openDialog(ReschedulePicker, …)`: `rescheduled` is true
 *  only when the user committed a date and the write landed. The
 *  promise resolves to `null` on cancel / Escape / outside-tap, so
 *  callers (e.g. the SRS review session, which only advances on a real
 *  reschedule) can tell the two apart. */
export interface ReschedulePickerResult {
  rescheduled: boolean
}

export interface ReschedulePickerProps {
  blockId: string
  anchorRect?: ReschedulePickerAnchorRect
}

const DESKTOP_PANEL_MARGIN = 8
const DESKTOP_FALLBACK_POSITION: CSSProperties = {
  left: '50%',
  position: 'fixed',
  top: '50%',
  transform: 'translate(-50%, -50%)',
}
const STRIP_PAST_DAYS = 7
const STRIP_FUTURE_DAYS = 60
const STRIP_CELL_WIDTH_PX = 48

const weekdayLetter = (date: Date): string =>
  date.toLocaleDateString('en-US', {weekday: 'narrow'})

interface StripCell {
  iso: string
  date: Date
  isToday: boolean
  offsetDays: number
}

const buildStripCells = (anchorIso: string): StripCell[] => {
  const today = todayIso()
  const cells: StripCell[] = []
  for (let offset = -STRIP_PAST_DAYS; offset <= STRIP_FUTURE_DAYS; offset++) {
    const iso = addDaysIso(anchorIso, offset)
    const date = parseIsoDay(iso)
    if (!date) continue
    cells.push({
      iso,
      date,
      isToday: iso === today,
      offsetDays: offset,
    })
  }
  return cells
}

const QUICK_CHIPS: readonly {label: string; offset: number}[] = [
  {label: 'Today', offset: 0},
  {label: 'Tomorrow', offset: 1},
  {label: '+1w', offset: 7},
  {label: '+1m', offset: 30},
]

interface ActiveSession {
  initialIso: string
  write: (iso: string) => Promise<boolean>
}

export const ReschedulePicker = ({
  blockId,
  anchorRect,
  resolve,
  cancel,
}: DialogContextProps<ReschedulePickerResult> & ReschedulePickerProps) => {
  const runtime = useAppRuntime()
  const repo = useRepo()
  const [session, setSession] = useState<ActiveSession | null>(null)

  // The finalize callbacks are fresh closures from the DialogHost each
  // render; read them through a ref so the mount-once load effect can
  // close the sheet without depending on (and re-running for) their
  // identity.
  const cancelRef = useRef(cancel)
  useEffect(() => {
    cancelRef.current = cancel
  })

  // Resolve the adapter + current date once on mount. Each open is its
  // own dialog instance, so there's no cross-session supersede
  // bookkeeping — a stale async resolve is only guarded against this
  // instance unmounting mid-flight.
  useEffect(() => {
    let cancelled = false
    const block = repo.block(blockId)
    const adapter = pickBlockDateAdapter(runtime, block)
    if (!adapter) {
      // The action's `isVisible` already filters this out — log so a
      // misconfigured plugin (forgot to register the adapter) is still
      // visible — and close the sheet.
      console.error(`[reschedule] no adapter handles block ${blockId}`)
      cancelRef.current()
      return
    }
    void (async () => {
      let resolvedIso: string | null
      try {
        resolvedIso = await adapter.getCurrentIso(block)
      } catch (error) {
        // Fall back to "today" so the sheet still opens; the user can
        // pick a date and the eventual `setIso` succeeds or reports its
        // own error in commit.
        console.error(`[reschedule] adapter ${adapter.id} read failed`, error)
        resolvedIso = null
      }
      if (cancelled) return
      setSession({
        initialIso: resolvedIso ?? todayIso(),
        write: async iso => {
          const written = await adapter.setIso(block, iso)
          if (!written) console.warn(`[reschedule] adapter ${adapter.id} refused write`)
          return written
        },
      })
    })()
    return () => { cancelled = true }
  }, [repo, runtime, blockId])

  return session && <DatePickerSheet
    session={session}
    anchorRect={anchorRect}
    label="Reschedule block"
    title="Reschedule to"
    cancel={cancel}
    finish={rescheduled => resolve({rescheduled})}
  />
}

export interface DatePropertyPickerProps {
  initialIso?: string
  anchorRect: ReschedulePickerAnchorRect
  write: ActiveSession['write']
}

export function DatePropertyPicker({initialIso, anchorRect, write, resolve, cancel}: DialogContextProps<void> & DatePropertyPickerProps) {
  return <DatePickerSheet
    session={{initialIso: initialIso ?? todayIso(), write}}
    anchorRect={anchorRect}
    label="Choose date"
    title="Choose date"
    cancel={cancel}
    finish={() => resolve()}
  />
}

function DatePickerSheet({session: {initialIso, write}, anchorRect, label, title, cancel, finish}: {
  session: ActiveSession
  anchorRect?: ReschedulePickerAnchorRect
  label: string
  title: string
  cancel: () => void
  finish: (written: boolean) => void
}) {
  const isMobile = useIsMobile()
  const [visibleMonth, setVisibleMonth] = useState(() => firstOfMonth(parseIsoDay(initialIso) ?? new Date()))
  const [previewIso, setPreviewIso] = useState(initialIso)
  const [pending, setPending] = useState(false)
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [cancel])

  const stripCells = useMemo(() => buildStripCells(initialIso), [initialIso])
  const {floatingStyle, setFloatingElement} = useAnchoredFloating({
    open: !isMobile,
    anchorRect: anchorRect ?? null,
    gap: DESKTOP_PANEL_MARGIN,
    viewportMargin: DESKTOP_PANEL_MARGIN,
    fallbackStyle: DESKTOP_FALLBACK_POSITION,
  })
  const desktopPosition = isMobile ? undefined : floatingStyle
  const setSheetElement = useCallback((element: HTMLDivElement | null) => {
    sheetRef.current = element
    if (!isMobile) setFloatingElement(element)
  }, [isMobile, setFloatingElement])
  const visible = desktopPosition?.visibility !== 'hidden'
  useEffect(() => {
    if (visible) sheetRef.current?.focus({preventScroll: true})
  }, [visible])

  // Center the strip on the initial date the first time it appears, then
  // never auto-scroll again — the user's manual scroll position is more
  // valuable than re-centering on each preview tick.
  useEffect(() => {
    const container = stripRef.current
    if (!container) return
    const initialOffset = STRIP_PAST_DAYS * STRIP_CELL_WIDTH_PX
    const targetScrollLeft = initialOffset - container.clientWidth / 2 + STRIP_CELL_WIDTH_PX / 2
    container.scrollLeft = Math.max(0, targetScrollLeft)
  }, [])

  const today = todayIso()

  const commit = async (iso: string) => {
    if (pending) return
    setPending(true)
    let wrote = false
    try {
      wrote = await write(iso)
    } catch (error) {
      // Callers fire commit with `void commit(...)`, so a throw here
      // would surface only as an unhandled rejection while the sheet
      // closes silently. Catch + log so the failure is at least
      // visible to anyone with the console open. (No toast plumbing
      // in scope for the prototype.)
      console.error('[date picker] write failed', error)
    }
    // Report `rescheduled` only when the date actually landed; a refused
    // or thrown write is, for the opener's purposes, the same as a cancel
    // (the SRS review session must not advance past a card it never
    // moved).
    finish(wrote)
  }

  const previewDate = parseIsoDay(previewIso)
  const previewLabel = previewDate ? formatDayLabel(previewDate) : '—'

  const sheetClassName = isMobile
    // Bottom sheet on mobile — full-bleed, anchored to the bottom edge,
    // safe-area inset for notched devices. Spans roughly the bottom 75%
    // so the swiped block stays peeking above on tall phones.
    ? 'fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t bg-popover px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3 text-popover-foreground shadow-2xl'
    // Anchored popover on desktop when opened from inline date chrome;
    // centered fallback for command / touch-laptop paths without an anchor.
    : 'fixed z-50 max-h-[calc(100vh-1rem)] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border bg-popover p-4 text-popover-foreground shadow-2xl'

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
        aria-hidden="true"
        onClick={() => cancel()}
      />
      <div
        ref={setSheetElement}
        role="dialog"
        tabIndex={-1}
        aria-label={label}
        aria-busy={pending || undefined}
        className={sheetClassName}
        style={desktopPosition}
        onClick={event => event.stopPropagation()}
      >
        {/* Drag-handle indicator (purely decorative on the bottom sheet) */}
        {isMobile && (
          <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true"/>
        )}

        <div className="mb-3 flex items-baseline justify-between gap-3">
          <div className="text-sm font-medium text-muted-foreground">{title}</div>
          <div className="truncate text-base font-semibold">{previewLabel}</div>
        </div>

        <div className="mb-3 flex flex-wrap gap-2">
          {QUICK_CHIPS.map(chip => {
            const iso = addDaysIso(today, chip.offset)
            const isSelected = previewIso === iso
            return (
              <button
                key={chip.label}
                type="button"
                disabled={pending}
                onClick={() => {
                  setPreviewIso(iso)
                  void commit(iso)
                }}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors active:scale-95',
                  isSelected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-foreground hover:bg-muted',
                )}
              >
                {chip.label}
              </button>
            )
          })}
        </div>

        <CalendarGrid
          visibleMonth={visibleMonth}
          onVisibleMonthChange={setVisibleMonth}
          selectedIso={previewIso}
          onSelect={iso => {
            setPreviewIso(iso)
            void commit(iso)
          }}
          disabled={pending}
          variant="primary"
        />

        <div className="mt-3 border-t pt-3">
          <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
            <span>Quick scrub</span>
            <span className="text-[10px] uppercase tracking-wide">tap a day</span>
          </div>
          <div
            ref={stripRef}
            className="-mx-4 flex snap-x snap-mandatory gap-1 overflow-x-auto px-4 pb-1"
            role="listbox"
            aria-label="Date strip"
          >
            {stripCells.map(cell => {
              const isSelected = cell.iso === previewIso
              return (
                <button
                  key={cell.iso}
                  type="button"
                  disabled={pending}
                  role="option"
                  aria-selected={isSelected}
                  aria-label={formatDayLabel(cell.date)}
                  onClick={() => {
                    setPreviewIso(cell.iso)
                    void commit(cell.iso)
                  }}
                  style={{width: STRIP_CELL_WIDTH_PX, scrollSnapAlign: 'center'}}
                  className={cn(
                    'flex shrink-0 flex-col items-center justify-center rounded-md border py-2 transition-colors active:scale-95',
                    isSelected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : cell.isToday
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background text-foreground hover:bg-muted',
                  )}
                >
                  <span className="text-[10px] font-medium uppercase tracking-wide opacity-70">
                    {weekdayLetter(cell.date)}
                  </span>
                  <span className="text-base font-semibold leading-tight">
                    {cell.date.getDate()}
                  </span>
                  <span className="text-[9px] opacity-60">
                    {cell.isToday
                      ? 'today'
                      : cell.offsetDays === 0
                        ? 'original'
                        : cell.offsetDays > 0
                          ? `+${cell.offsetDays}d`
                          : `${cell.offsetDays}d`}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={() => cancel()}
          className="mt-3 w-full rounded-md border bg-background py-2 text-sm font-medium text-foreground hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </>,
    document.body,
  )
}
