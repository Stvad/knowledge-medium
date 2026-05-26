/**
 * Floating preview rendered while the two-finger scrub gesture is
 * active. Owns the runtime + adapter resolution + commit; the gesture
 * module (`dateScrubGesture.ts`) just feeds it day deltas.
 *
 * Rendering: a small pill near the user's finger showing the current
 * candidate ISO and the offset from the original date. A cancel hint
 * appears when the user has dragged far enough vertically that
 * releasing would revert.
 *
 * State strategy: the live scrub lives in a mutable ref so the
 * gesture callbacks can read the latest value across rapid touchmove
 * events without going through React state batching. A parallel
 * `setActive` mirrors the ref for rendering. Persisted-data writes
 * (the adapter `setIso` commit) happen OUTSIDE any state-updater
 * closure — Strict Mode / render-retry would otherwise re-run the
 * updater and fire duplicate reschedule writes for a single gesture
 * release.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Block } from '@/data/block'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { useRepo } from '@/context/repo.js'
import { addDaysIso, todayIso } from './dailyNotes.ts'
import {
  pickBlockDateAdapter,
  type BlockDateAdapter,
} from './blockDateAdapter.ts'
import {
  registerScrubHandler,
  type DateScrubDraft,
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

const createDateDraft = ({
  adapter,
  repoBlock,
  initialIso,
  deltaDays,
}: {
  adapter: BlockDateAdapter
  repoBlock: () => Block
  initialIso: string
  deltaDays: number
}): DateScrubDraft => {
  const currentIso = addDaysIso(initialIso, deltaDays)
  return {
    id: 'date-scrub.date',
    currentIso,
    preview: {
      label: 'Scrub date',
      value: formatPretty(currentIso),
      detail: offsetLabel(deltaDays, currentIso),
    },
    payload: {
      plugin: 'daily-notes.date-scrub',
      initialIso,
      deltaDays,
    },
    shiftDate: delta => createDateDraft({
      adapter,
      repoBlock,
      initialIso,
      deltaDays: deltaDays + delta,
    }),
    commit: async () => {
      if (currentIso === initialIso) return
      await adapter.setIso(repoBlock(), currentIso)
    },
  }
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
  initialIso: string | null
  fallbackIso: string
  startX: number
  startY: number
  deltaDays: number
  cancelIntent: boolean
  draft: DateScrubDraft | null
  /** False until `getCurrentIso` resolves and the default date draft
   *  reflects the block's real date. A plugin can still install its own
   *  date-aware draft before resolution; otherwise commit is skipped
   *  rather than writing `today + delta` by mistake. */
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
  // Source of truth read by gesture callbacks. Kept in lockstep with
  // React state via `writeActive` so callbacks observe the freshest
  // value (touchend fires synchronously after touchmove without
  // waiting for a render) AND renders still get a normal state path.
  const activeRef = useRef<ActiveScrub | null>(null)

  const writeActive = useCallback((next: ActiveScrub | null): void => {
    activeRef.current = next
    setActive(next)
  }, [])

  const dismiss = useCallback(() => writeActive(null), [writeActive])

  useEffect(() => {
    return registerScrubHandler({
      start: (args: ScrubStartArgs) => {
        const adapter = args.adapter ?? pickBlockDateAdapter(runtime, args.block)
        if (!adapter) return false
        const fallback = todayIso()
        const session = ++nextScrubSession
        // Provisional show — render the pill at the start position
        // immediately with a placeholder ISO, then patch once the
        // adapter resolves the real current ISO. Without this the
        // first ~50ms of the scrub flickers blank.
        writeActive({
          blockId: args.blockId,
          session,
          adapter,
          initialIso: null,
          fallbackIso: fallback,
          startX: args.startX,
          startY: args.startY,
          deltaDays: 0,
          cancelIntent: false,
          draft: null,
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
          const current = activeRef.current
          if (!current || current.session !== session) return
          if (current.draft) {
            writeActive({
              ...current,
              initialIso: iso,
              resolved: true,
            })
            return
          }
          writeActive({
            ...current,
            initialIso: iso,
            draft: createDateDraft({
              adapter,
              repoBlock: () => repo.block(args.blockId),
              initialIso: iso,
              deltaDays: current.deltaDays,
            }),
            resolved: true,
          })
        })()
        return true
      },
      update: (deltaDays: number, intentCancel: boolean) => {
        const current = activeRef.current
        if (!current) return
        const stepDeltaDays = deltaDays - current.deltaDays
        const draft = current.draft && stepDeltaDays !== 0
          ? current.draft.shiftDate(stepDeltaDays)
          : current.draft
        if (
          deltaDays === current.deltaDays &&
          intentCancel === current.cancelIntent
        ) return
        writeActive({
          ...current,
          deltaDays,
          cancelIntent: intentCancel,
          draft,
        })
      },
      stage: (blockId: string, draft: DateScrubDraft) => {
        const current = activeRef.current
        if (!current || current.blockId !== blockId) return false
        writeActive({...current, draft})
        return true
      },
      getDraft: (blockId: string) => {
        const current = activeRef.current
        if (!current || current.blockId !== blockId) return null
        return current.draft
      },
      end: (commit: boolean) => {
        // Snapshot the current scrub first, then clear state, then
        // perform the persisted-data write OUTSIDE any setState
        // updater. Doing the write inside a `setActive(current => …)`
        // would expose it to Strict Mode / render-retry double-
        // invocation, producing duplicate reschedules for one
        // gesture release.
        const current = activeRef.current
        writeActive(null)
        if (!current) return
        if (!commit || current.cancelIntent) return
        if (!current.draft) {
          // The user released before `getCurrentIso` resolved — we
          // don't know the block's real date, so we can't safely
          // compute `actual + delta`. Skipping is preferable to
          // committing the wrong date.
          console.warn('[date-scrub] released before initial ISO resolved; skipped commit')
          return
        }
        void Promise.resolve(current.draft.commit()).catch(error => {
          console.error('[date-scrub] commit failed', error)
        })
      },
    })
  }, [repo, runtime, writeActive])

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
  const preview = active.draft?.preview
  const label = active.cancelIntent
    ? 'Release to cancel'
    : preview
      ? preview.label
      : active.resolved
        ? 'Scrub date'
        : 'Loading current date…'
  const value = preview?.value ?? formatPretty(active.fallbackIso)
  const detail = active.cancelIntent
    ? 'release will cancel'
    : preview?.detail ?? (
      active.resolved
        ? offsetLabel(active.deltaDays, active.draft?.currentIso ?? active.fallbackIso)
        : 'release will cancel'
    )
  const valueResolved = active.draft !== null

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
          {label}
        </div>
        <div className={`text-lg font-semibold leading-none ${valueResolved ? '' : 'opacity-60'}`}>
          {value}
        </div>
        <div className="text-xs text-muted-foreground">
          {detail}
        </div>
      </div>
    </div>,
    document.body,
  )
}
