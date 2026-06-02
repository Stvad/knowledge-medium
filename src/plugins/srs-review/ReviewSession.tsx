import { useCallback, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  ArchiveX,
  CalendarClock,
  Check,
  ChevronLeft,
  Gauge,
  PartyPopper,
  RotateCcw,
  Sparkles,
} from 'lucide-react'
import type { Block } from '@/data/block'
import { useRepo } from '@/context/repo.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { appMountsFacet } from '@/extensions/core.js'
import { NestedBlockContextProvider } from '@/context/block.js'
import { BlockComponent } from '@/components/BlockComponent.js'
import { Button } from '@/components/ui/button.js'
import { cn } from '@/lib/utils.js'
import { showError, showInfo } from '@/utils/toast.js'
import {
  hasAnyBlockDateAdapter,
  openReschedulePicker,
  reschedulePickerMount,
} from '@/plugins/daily-notes'
import {
  formatRescheduleToastMessage,
  rescheduleBlock,
} from '@/plugins/srs-rescheduling'
import { SrsSignal } from '@/plugins/srs-rescheduling/scheduler.js'
import { useDueCards } from './useDueCards.ts'
import { archiveSrsCard } from './archive.ts'
import { reviewDeckStartedProp } from './schema.ts'
import { SRS_REVIEW_CARD_ID, SRS_REVIEW_REVEALED } from './reviewCardLayout.tsx'

const isEditableTarget = (): boolean => {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

interface GradeButton {
  signal: SrsSignal
  label: string
  hint: string
  icon: typeof Check
  className: string
}

const GRADE_BUTTONS: readonly GradeButton[] = [
  {signal: SrsSignal.AGAIN, label: 'Again', hint: '1', icon: RotateCcw, className: 'text-rose-600'},
  {signal: SrsSignal.HARD, label: 'Hard', hint: '2', icon: Gauge, className: 'text-amber-600'},
  {signal: SrsSignal.GOOD, label: 'Good', hint: '3', icon: Check, className: 'text-emerald-600'},
  {signal: SrsSignal.EASY, label: 'Easy', hint: '4', icon: Sparkles, className: 'text-sky-600'},
]

const GRADE_BY_KEY: Readonly<Record<string, SrsSignal>> = {
  '1': SrsSignal.AGAIN,
  '2': SrsSignal.HARD,
  '3': SrsSignal.GOOD,
  '4': SrsSignal.EASY,
}

export const ReviewSession = ({deck, tagName}: {deck: Block; tagName: string}) => {
  const repo = useRepo()
  const runtime = useAppRuntime()
  const workspaceId = deck.peek()?.workspaceId ?? repo.activeWorkspaceId ?? ''
  const dueCards = useDueCards(workspaceId, tagName)

  // Freeze the queue at the first non-empty load. Grading moves a card
  // out of `dueCards` (its next-review date jumps to the future), so
  // walking the live list would renumber the session under the user.
  // We snapshot ids once via the converge-during-render pattern, then
  // read each card's live state at grade time via `repo.block(id)`.
  const [queue, setQueue] = useState<readonly string[] | null>(null)
  if (queue === null && dueCards.length > 0) {
    setQueue(dueCards.map(c => c.id))
  }

  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)

  const total = queue?.length ?? 0
  const currentId = queue && index < queue.length ? queue[index] : null

  // Show Reschedule only when it can actually do something: a date
  // adapter must handle the card (gone if srs-rescheduling is off) AND
  // the reschedule picker must be mounted (contributed by daily-notes —
  // its adapter survives even with daily-notes off, so check the mount
  // separately). Without both, dispatching the picker event would open
  // nothing and `advance()` would silently skip the card.
  const canReschedule =
    currentId !== null &&
    hasAnyBlockDateAdapter(runtime, repo.block(currentId)) &&
    runtime.read(appMountsFacet).some(mount => mount.id === reschedulePickerMount.id)

  const advance = useCallback(() => {
    setRevealed(false)
    setIndex(i => i + 1)
  }, [])

  const grade = useCallback(
    async (signal: SrsSignal) => {
      if (!currentId || busy) return
      setBusy(true)
      try {
        // Advance only when the write lands. A null result means the
        // reschedule was refused (read-only repo, or the block is no
        // longer an SRS card) — advancing then would mark progress and
        // eventually "complete" while the card's due date never moved,
        // so it'd resurface next session. Keep the card and surface it.
        const result = await rescheduleBlock(repo.block(currentId), signal)
        if (result) {
          showInfo(formatRescheduleToastMessage(result))
          advance()
        } else {
          showError("Couldn't reschedule this card")
        }
      } finally {
        setBusy(false)
      }
    },
    [currentId, busy, repo, advance],
  )

  const archive = useCallback(async () => {
    if (!currentId || busy) return
    setBusy(true)
    try {
      // Same as grade: only advance if the archive write actually
      // happened (false on read-only / non-SRS block).
      const archived = await archiveSrsCard(repo.block(currentId))
      if (archived) {
        showInfo('Archived')
        advance()
      } else {
        showError("Couldn't archive this card")
      }
    } finally {
      setBusy(false)
    }
  }, [currentId, busy, repo, advance])

  // Hand the card to the shared reschedule sheet, then move on — the
  // sheet writes the new date asynchronously; either way this card is
  // dealt with for the session.
  const reschedule = useCallback(() => {
    if (!currentId) return
    openReschedulePicker({blockId: currentId, workspaceId})
    advance()
  }, [currentId, workspaceId, advance])

  const changeDeck = useCallback(() => {
    void deck.set(reviewDeckStartedProp, false)
  }, [deck])

  // Keyboard: space/enter reveals, 1–4 grade. Scoped to the session's
  // own surface via a container `onKeyDown` (not a global `window`
  // listener) so a deck rendered in a background panel never grabs
  // these keys while the user is interacting elsewhere — and two open
  // decks don't fight over them. The editable-target guard additionally
  // lets typing into the revealed answer (a live outline) through
  // instead of firing a grade.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (busy || isEditableTarget()) return
      if (!revealed) {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          setRevealed(true)
        }
        return
      }
      const signal = GRADE_BY_KEY[e.key]
      if (signal !== undefined) {
        e.preventDefault()
        void grade(signal)
      }
    },
    [busy, revealed, grade],
  )

  // Focus the session surface once, when the card view first mounts, so
  // the shortcuts are live without a click. We don't refocus per card —
  // that would yank focus back from the reschedule sheet after it opens.
  const focusedOnce = useRef(false)
  const focusSessionSurface = useCallback((el: HTMLDivElement | null) => {
    if (el && !focusedOnce.current) {
      focusedOnce.current = true
      el.focus()
    }
  }, [])

  const deckLabel = tagName.trim() ? tagName.trim() : 'All due cards'

  const header = (
    <div className="mb-4 flex items-center justify-between gap-3">
      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={changeDeck}>
        <ChevronLeft className="mr-1 h-3.5 w-3.5" />
        Decks
      </Button>
      <span className="truncate text-sm font-medium text-muted-foreground">{deckLabel}</span>
      <span className="text-xs tabular-nums text-muted-foreground">
        {total === 0 ? '' : `${Math.min(index + 1, total)} / ${total}`}
      </span>
    </div>
  )

  // Nothing due (or the deck is still loading its first page — the
  // queue is captured the moment cards arrive, promoting this to a
  // session).
  if (queue === null) {
    return (
      <div className="mx-auto w-full max-w-2xl py-4">
        {header}
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center text-muted-foreground">
          <PartyPopper className="h-6 w-6" />
          <p className="font-medium">No cards due in this deck</p>
        </div>
      </div>
    )
  }

  if (currentId === null) {
    return (
      <div className="mx-auto w-full max-w-2xl py-4">
        {header}
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
          <PartyPopper className="h-6 w-6 text-emerald-600" />
          <p className="font-medium">Review complete</p>
          <p className="text-sm text-muted-foreground">
            {total} {total === 1 ? 'card' : 'cards'} reviewed.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={focusSessionSurface}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="mx-auto w-full max-w-2xl py-4 outline-none"
    >
      {header}

      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <NestedBlockContextProvider
          overrides={{
            [SRS_REVIEW_CARD_ID]: currentId,
            [SRS_REVIEW_REVEALED]: revealed,
            isNestedSurface: true,
            scopeRootId: currentId,
            renderScopeId: `srs-review:${currentId}`,
          }}
        >
          {/* keyed by card id so switching cards remounts the subtree
              rather than diffing one card's outline into the next */}
          <BlockComponent key={currentId} blockId={currentId} />
        </NestedBlockContextProvider>
      </div>

      <div className="mt-4">
        {!revealed ? (
          <Button type="button" className="w-full" onClick={() => setRevealed(true)} disabled={busy}>
            Show answer
            <span className="ml-2 text-xs opacity-70">space</span>
          </Button>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            {GRADE_BUTTONS.map(btn => (
              <Button
                key={btn.label}
                type="button"
                variant="outline"
                className="flex h-auto flex-col gap-1 py-2"
                disabled={busy}
                onClick={() => void grade(btn.signal)}
              >
                <btn.icon className={cn('h-4 w-4', btn.className)} />
                <span className="text-sm font-medium">{btn.label}</span>
                <span className="text-[10px] opacity-60">{btn.hint}</span>
              </Button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-center gap-4 text-xs text-muted-foreground">
        {/* Hidden unless an adapter handles the card and the picker is
            mounted — otherwise the control would open nothing and then
            skip the card. */}
        {canReschedule && (
          <button
            type="button"
            className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-50"
            onClick={reschedule}
            disabled={busy}
          >
            <CalendarClock className="h-3.5 w-3.5" />
            Reschedule
          </button>
        )}
        <button
          type="button"
          className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-50"
          onClick={() => void archive()}
          disabled={busy}
        >
          <ArchiveX className="h-3.5 w-3.5" />
          Archive
        </button>
      </div>
    </div>
  )
}
