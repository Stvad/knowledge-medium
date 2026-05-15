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
  adapter: BlockDateAdapter
  initialIso: string
  startX: number
  startY: number
  deltaDays: number
  candidateIso: string
  cancelIntent: boolean
}

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
        // Provisional show — render the pill at the start position
        // immediately with a placeholder ISO, then patch once the
        // adapter resolves the real current ISO. Without this the
        // first ~50ms of the scrub flickers blank.
        setActive({
          blockId: args.blockId,
          adapter,
          initialIso: fallback,
          startX: args.startX,
          startY: args.startY,
          deltaDays: 0,
          candidateIso: fallback,
          cancelIntent: false,
        })

        void (async () => {
          const iso = await adapter.getCurrentIso(args.block)
          if (!iso) return
          // Patch only the still-active scrub for THIS block — a quick
          // tap that ended before the adapter resolved should leave
          // the next scrub alone. Re-anchor the candidate from the
          // resolved ISO + the delta the user has already dragged
          // through, so the pill doesn't snap back to "today" once
          // the real value lands.
          setActive(current => {
            if (!current || current.blockId !== args.blockId) return current
            return {
              ...current,
              initialIso: iso,
              candidateIso: addDaysIso(iso, current.deltaDays),
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
            current.candidateIso !== current.initialIso
          ) {
            const block = repo.block(current.blockId)
            void current.adapter.setIso(block, current.candidateIso).catch(error => {
              console.error('[date-scrub] commit failed', error)
            })
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
          {active.cancelIntent ? 'Release to cancel' : 'Scrub date'}
        </div>
        <div className="text-lg font-semibold leading-none">
          {formatPretty(active.candidateIso)}
        </div>
        <div className="text-xs text-muted-foreground">
          {offsetLabel(active.deltaDays, active.candidateIso)}
        </div>
      </div>
    </div>,
    document.body,
  )
}
