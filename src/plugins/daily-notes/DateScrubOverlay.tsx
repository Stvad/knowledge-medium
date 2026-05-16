/**
 * Floating preview rendered while the long-press scrub gesture is
 * active. Owns the runtime + adapter resolution + commit; the gesture
 * module (`dateScrubGesture.ts`) just feeds it day deltas.
 *
 * Rendering: a small pill near the user's finger showing the current
 * candidate ISO and the offset from the original date. A cancel hint
 * appears when the user has dragged far enough vertically that
 * releasing would revert.
 *
 * State strategy: gesture callbacks always go through functional
 * `setActive` so they read the latest scrub state through React's
 * updater rather than a snapshot closed over at registration time. The
 * `start` async-resolve patch is keyed on `blockId` so a stale resolve
 * from an aborted scrub can't poison the next one.
 */
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { useRepo } from '@/context/repo.tsx'
import { addDaysIso, todayIso } from './dailyNotes.ts'
import {
  pickBlockDateAdapter,
  type BlockDateAdapter,
} from './blockDateAdapter.ts'
import {
  registerScrubHandler,
  type ScrubStartArgs,
} from './dateScrubGesture.ts'

const formatPretty = (iso: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return iso
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

const offsetLabel = (deltaDays: number, candidateIso: string): string => {
  if (deltaDays === 0) return 'unchanged'
  const today = todayIso()
  if (candidateIso === today) return 'today'
  if (deltaDays > 0) return `+${deltaDays}d`
  return `${deltaDays}d`
}

interface ActiveScrub {
  blockId: string
  /** Per-gesture token so a slow `getCurrentIso` from a previous
   *  scrub of the SAME block can't overwrite the freshly-started
   *  successor. `blockId` alone isn't enough: scrub A starts and
   *  ends on block X (without resolving), scrub B starts on the
   *  same block X — A's async resolve would otherwise patch B's
   *  initialIso with X's-at-A-time value. */
  session: number
  adapter: BlockDateAdapter
  initialIso: string
  startX: number
  startY: number
  deltaDays: number
  candidateIso: string
  cancelIntent: boolean
  /** False until `getCurrentIso` resolves and `initialIso/candidateIso`
   *  reflect the block's real date. Commit is gated on this — without
   *  it a fast drag-and-release on an SRS card (where the read does a
   *  daily-note row load) would commit `today + delta` instead of
   *  `actual + delta`. */
  resolved: boolean
}

/** Monotonic gesture counter — module-scoped so it survives any
 *  StrictMode-driven double-mount of the overlay. Each scrub start
 *  takes the next id; async patches compare it against the still-
 *  active session to reject stale resolves. */
let nextScrubSession = 0

export const DateScrubOverlay = () => {
  const runtime = useAppRuntime()
  const repo = useRepo()
  const [active, setActive] = useState<ActiveScrub | null>(null)

  const dismiss = useCallback(() => setActive(null), [])

  useEffect(() => {
    return registerScrubHandler({
      start: (args: ScrubStartArgs) => {
        const adapter = pickBlockDateAdapter(runtime, args.block)
        if (!adapter) return false
        const fallback = todayIso()
        const session = ++nextScrubSession
        // Provisional show — render the pill at the start position
        // immediately with a placeholder ISO, then patch once the
        // adapter resolves the real current ISO. Without this the
        // first ~50ms of the scrub flickers blank.
        setActive({
          blockId: args.blockId,
          session,
          adapter,
          initialIso: fallback,
          startX: args.startX,
          startY: args.startY,
          deltaDays: 0,
          candidateIso: fallback,
          cancelIntent: false,
          resolved: false,
        })

        void (async () => {
          let iso: string | null
          try {
            iso = await adapter.getCurrentIso(args.block)
          } catch (error) {
            // Fire-and-forget would surface only as an unhandled
            // rejection. Catch + log so the failure is visible; leave
            // `resolved` false so the commit gate in `end` skips the
            // write (no-op rather than commit against a placeholder
            // `today`).
            console.error('[date-scrub] adapter read failed', error)
            return
          }
          if (!iso) return
          // Patch only the still-active scrub for THIS session — a
          // quick tap that ended before the adapter resolved, or a
          // fresh scrub on the same block, leaves this stale resolve
          // a no-op. Re-anchor the candidate from the resolved ISO +
          // the delta the user has already dragged through, so the
          // pill doesn't snap back to "today" once the real value
          // lands.
          setActive(current => {
            if (!current || current.session !== session) return current
            return {
              ...current,
              initialIso: iso,
              candidateIso: addDaysIso(iso, current.deltaDays),
              resolved: true,
            }
          })
        })()
        return true
      },
      update: (deltaDays: number, intentCancel: boolean) => {
        setActive(current => {
          if (!current) return current
          const candidateIso = addDaysIso(current.initialIso, deltaDays)
          if (
            deltaDays === current.deltaDays &&
            intentCancel === current.cancelIntent &&
            candidateIso === current.candidateIso
          ) return current
          return {...current, deltaDays, candidateIso, cancelIntent: intentCancel}
        })
      },
      end: (commit: boolean) => {
        // Perform the commit side-effect inside the updater so we read
        // the freshest scrub state without a separate ref. Returning
        // null clears the overlay in the same render the commit fires.
        setActive(current => {
          if (
            current &&
            commit &&
            !current.cancelIntent &&
            // Gate commit on the adapter having resolved the block's
            // real ISO. Without this, a fast drag-and-release before
            // `getCurrentIso` returns (especially likely for SRS
            // cards, whose adapter does a DB read) would commit
            // `today + delta` instead of `actual + delta`.
            current.resolved &&
            current.candidateIso !== current.initialIso
          ) {
            const block = repo.block(current.blockId)
            void current.adapter.setIso(block, current.candidateIso).catch(error => {
              console.error('[date-scrub] commit failed', error)
            })
          } else if (current && commit && !current.cancelIntent && !current.resolved) {
            console.warn('[date-scrub] released before initial ISO resolved; skipped commit')
          }
          return null
        })
      },
    })
  }, [repo, runtime])

  // Esc to bail out from the keyboard (touch-laptop / debugging path).
  useEffect(() => {
    if (!active) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [active, dismiss])

  if (!active) return null

  // Pin the pill near the finger but above it so the user's thumb
  // doesn't occlude the preview. Clamp to the viewport so an
  // edge-of-screen scrub stays readable.
  const PILL_OFFSET_Y = 72
  const PILL_HALF_WIDTH = 110
  const top = Math.max(8, active.startY - PILL_OFFSET_Y)
  const left = Math.max(
    PILL_HALF_WIDTH + 8,
    Math.min(window.innerWidth - PILL_HALF_WIDTH - 8, active.startX),
  )

  return createPortal(
    <div
      className="pointer-events-none fixed z-[60] -translate-x-1/2"
      style={{top, left}}
      aria-live="polite"
    >
      <div
        className={`flex min-w-[200px] flex-col items-center gap-1 rounded-xl border px-4 py-2 shadow-2xl backdrop-blur transition-colors ${
          active.cancelIntent
            ? 'border-destructive/40 bg-destructive/10 text-destructive'
            : 'border-border bg-popover/95 text-popover-foreground'
        }`}
      >
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {active.cancelIntent
            ? 'Release to cancel'
            : active.resolved
              ? 'Scrub date'
              : 'Loading current date…'}
        </div>
        <div className={`text-lg font-semibold leading-none ${active.resolved ? '' : 'opacity-60'}`}>
          {formatPretty(active.candidateIso)}
        </div>
        <div className="text-xs text-muted-foreground">
          {active.resolved
            ? offsetLabel(active.deltaDays, active.candidateIso)
            : 'release will cancel'}
        </div>
      </div>
    </div>,
    document.body,
  )
}
