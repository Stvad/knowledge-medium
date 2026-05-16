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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { useRepo } from '@/context/repo.tsx'
import { useIsMobile } from '@/utils/react.tsx'
import { addDaysIso, todayIso } from './dailyNotes.ts'
import { pickBlockDateAdapter, type BlockDateAdapter } from './blockDateAdapter.ts'
import { CalendarGrid } from './CalendarGrid.tsx'
import { firstOfMonth, formatDayLabel, fromIso } from './calendar.ts'
import {
  openReschedulePickerEvent,
  type OpenReschedulePickerEventDetail,
} from './rescheduleEvents.ts'

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
    const date = fromIso(iso)
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
  blockId: string
  workspaceId: string
  adapter: BlockDateAdapter
  initialIso: string
}

export const ReschedulePicker = () => {
  const runtime = useAppRuntime()
  const repo = useRepo()
  const isMobile = useIsMobile()
  const [session, setSession] = useState<ActiveSession | null>(null)
  const [visibleMonth, setVisibleMonth] = useState(() => firstOfMonth(new Date()))
  const [previewIso, setPreviewIso] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const stripRef = useRef<HTMLDivElement | null>(null)
  const stripDidScrollRef = useRef(false)
  /** Monotonic request id — bumped on every open event. Async resolves
   *  check it before writing state so two opens in quick succession
   *  can't have the older `getCurrentIso` resolve last and replace
   *  the newer session. Read+write in the event handler is safe;
   *  React queues the setState that depends on it. */
  const openRequestIdRef = useRef(0)

  const dismiss = useCallback(() => {
    // Bump the counter so any in-flight resolves from this session
    // become stale and won't reopen the sheet.
    openRequestIdRef.current += 1
    setSession(null)
    setPreviewIso(null)
    stripDidScrollRef.current = false
  }, [])

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenReschedulePickerEventDetail>).detail
      if (!detail) return
      const block = repo.block(detail.blockId)
      const adapter = pickBlockDateAdapter(runtime, block)
      if (!adapter) {
        // The action's `canRun` already filters this out — log so a
        // misconfigured plugin (e.g. forgot to register the adapter) is
        // still visible.
        console.error(`[reschedule] no adapter handles block ${detail.blockId}`)
        return
      }

      const requestId = ++openRequestIdRef.current

      void (async () => {
        const initialIso = (await adapter.getCurrentIso(block)) ?? todayIso()
        // Drop the result if a newer open (or a dismiss) has bumped
        // the counter — without this, two fast opens against blocks
        // with different `getCurrentIso` latencies can land in the
        // wrong order and the sheet ends up showing/committing for
        // the wrong block.
        if (openRequestIdRef.current !== requestId) return
        const initialDate = fromIso(initialIso) ?? new Date()
        // Clear any stranded `pending` from an earlier session whose
        // commit hasn't resolved yet (its finally now no-ops because
        // the request id has moved on).
        setPending(false)
        setSession({
          blockId: detail.blockId,
          workspaceId: detail.workspaceId,
          adapter,
          initialIso,
        })
        setVisibleMonth(firstOfMonth(initialDate))
        setPreviewIso(initialIso)
        stripDidScrollRef.current = false
      })()
    }

    window.addEventListener(openReschedulePickerEvent, handleOpen)
    return () => window.removeEventListener(openReschedulePickerEvent, handleOpen)
  }, [repo, runtime])

  useEffect(() => {
    if (!session) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [session, dismiss])

  const stripCells = useMemo(
    () => session ? buildStripCells(session.initialIso) : [],
    [session],
  )

  // Center the strip on the initial date the first time it appears, then
  // never auto-scroll again — the user's manual scroll position is more
  // valuable than re-centering on each preview tick.
  useEffect(() => {
    if (!session || !stripRef.current || stripDidScrollRef.current) return
    const container = stripRef.current
    const initialOffset = STRIP_PAST_DAYS * STRIP_CELL_WIDTH_PX
    const targetScrollLeft = initialOffset - container.clientWidth / 2 + STRIP_CELL_WIDTH_PX / 2
    container.scrollLeft = Math.max(0, targetScrollLeft)
    stripDidScrollRef.current = true
  }, [session])

  if (!session) return null

  const today = todayIso()

  const commit = async (iso: string) => {
    if (!session || pending) return
    // Scope completion to the open-request id that was current when
    // we started the write. If the user dismisses and reopens (or
    // opens for a different block) while `setIso` is in flight, the
    // older promise's `finally` would otherwise dismiss the NEW
    // sheet and leave it with `pending = true` (buttons disabled
    // until the stale promise resolves).
    const committingFor = openRequestIdRef.current
    setPending(true)
    try {
      const block = repo.block(session.blockId)
      const ok = await session.adapter.setIso(block, iso)
      if (!ok) {
        console.warn(`[reschedule] adapter ${session.adapter.id} refused write`)
      }
    } catch (error) {
      // Callers fire commit with `void commit(...)`, so a throw here
      // would surface only as an unhandled rejection while the sheet
      // dismisses silently. Catch + log so the failure is at least
      // visible to anyone with the console open. (No toast plumbing
      // in scope for the prototype.)
      console.error(`[reschedule] adapter ${session.adapter.id} threw on write`, error)
    }
    if (openRequestIdRef.current !== committingFor) {
      // A newer open happened between setPending(true) and now.
      // Leave its state alone — its own commit/dismiss will manage
      // pending and visibility.
      return
    }
    setPending(false)
    dismiss()
  }

  const previewDate = previewIso ? fromIso(previewIso) : null
  const previewLabel = previewDate ? formatDayLabel(previewDate) : '—'

  const sheetClassName = isMobile
    // Bottom sheet on mobile — full-bleed, anchored to the bottom edge,
    // safe-area inset for notched devices. Spans roughly the bottom 75%
    // so the swiped block stays peeking above on tall phones.
    ? 'fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t bg-popover px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3 text-popover-foreground shadow-2xl'
    // Modal-ish on desktop (the picker is mobile-first; this is a
    // graceful fallback for the touch-laptop case).
    : 'fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-popover p-4 text-popover-foreground shadow-2xl'

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
        aria-hidden="true"
        onClick={dismiss}
      />
      <div
        role="dialog"
        aria-label="Reschedule block"
        aria-busy={pending || undefined}
        className={sheetClassName}
        onClick={event => event.stopPropagation()}
      >
        {/* Drag-handle indicator (purely decorative on the bottom sheet) */}
        {isMobile && (
          <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true"/>
        )}

        <div className="mb-3 flex items-baseline justify-between gap-3">
          <div className="text-sm font-medium text-muted-foreground">Reschedule to</div>
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
                        ? 'border-primary/40 bg-background text-primary'
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
                    {cell.offsetDays === 0
                      ? 'today'
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
          onClick={dismiss}
          className="mt-3 w-full rounded-md border bg-background py-2 text-sm font-medium text-foreground hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </>,
    document.body,
  )
}
