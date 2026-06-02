import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent } from 'react'
import {
  ArchiveX,
  ArrowLeft,
  CalendarClock,
  Check,
  ChevronLeft,
  ExternalLink,
  Gauge,
  PartyPopper,
  RotateCcw,
  Sparkles,
} from 'lucide-react'
import type { Block } from '@/data/block'
import type { BlockData } from '@/data/api'
import { useRepo } from '@/context/repo.js'
import { getBlockTypes } from '@/data/properties.js'
import { NestedBlockContextProvider } from '@/context/block.js'
import { BlockComponent } from '@/components/BlockComponent.js'
import { Button } from '@/components/ui/button.js'
import { cn } from '@/lib/utils.js'
import { showError, showInfo } from '@/utils/toast.js'
import { useActionContextActivations } from '@/shortcuts/useActionContext.js'
import { useBlockOpener } from '@/utils/navigation.js'
import { Breadcrumbs } from '@/plugins/breadcrumbs'
import { openReschedulePicker } from '@/plugins/daily-notes'
import {
  SRS_SM25_TYPE,
  formatRescheduleToastMessage,
  rescheduleBlock,
  srsArchivedProp,
  srsNextReviewDateProp,
} from '@/plugins/srs-rescheduling'
import { SrsSignal } from '@/plugins/srs-rescheduling/scheduler.js'
import { useDueCards } from './useDueCards.ts'
import { archiveSrsCard } from './archive.ts'
import { reviewDeckStartedProp } from './schema.ts'
import { SRS_REVIEW_CONTEXT, type SrsReviewController } from './actions.ts'
import { SRS_REVIEW_CARD_ID, SRS_REVIEW_REVEALED } from './reviewCardLayout.tsx'

const isInteractiveTarget = (el: HTMLElement | null): boolean => {
  if (!el) return false
  // `isContentEditable` covers CodeMirror's focusable `.cm-content`.
  if (el.isContentEditable) return true
  if (el.getAttribute('role') === 'button') return true
  // Buttons/links/form controls keep their own keys (Enter/Space activate
  // them) — the review context must not shadow that, or keyboard users
  // couldn't operate the grade/reschedule/archive controls.
  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(el.tagName)
}

/** Whether a block is still a live, schedulable review card — mirrors
 *  the deck's membership conditions (`buildDueCardsQuery`): it must
 *  carry the SRS type AND a non-empty next-review date AND not be
 *  archived. A card can lose any of these in another panel after the
 *  session snapshotted its id; grading it then would re-add the type
 *  and/or write a fresh date via `rescheduleBlock`, resurrecting a card
 *  the user just removed from review. */
const isLiveSrsCard = (data: BlockData): boolean => {
  if (!getBlockTypes(data).includes(SRS_SM25_TYPE)) return false
  try {
    const archivedRaw = data.properties[srsArchivedProp.name]
    if (archivedRaw !== undefined && srsArchivedProp.codec.decode(archivedRaw)) return false
    const dateRaw = data.properties[srsNextReviewDateProp.name]
    return dateRaw !== undefined && srsNextReviewDateProp.codec.decode(dateRaw).length > 0
  } catch {
    return false
  }
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

export const ReviewSession = ({deck, tagName}: {deck: Block; tagName: string}) => {
  const repo = useRepo()
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

  // A finished session keeps the frozen queue, so it would otherwise show
  // "Review complete" forever and ignore the (now reactive, midnight-
  // aware) due query. When genuinely new cards appear — next day's cards,
  // or ones added elsewhere — restart with those. Filtering to ids not in
  // the finished queue avoids re-reviewing a just-graded card that's
  // still lingering in a stale query result.
  if (queue !== null && index >= queue.length) {
    const fresh = dueCards.filter(card => !queue.includes(card.id))
    if (fresh.length > 0) {
      setQueue(fresh.map(card => card.id))
      setIndex(0)
    }
  }

  const advance = useCallback(() => {
    setRevealed(false)
    setIndex(i => i + 1)
  }, [])

  // Step back to the card just reviewed (or, from the "complete" screen,
  // the last card). The frozen queue keeps every reviewed card's id, so
  // this only re-shows the card — it doesn't undo the grade/reschedule
  // write that already landed; re-grading reschedules it afresh.
  const canGoBack = queue !== null && index > 0
  const goBack = useCallback(() => {
    setRevealed(false)
    // From the completion screen index === total, so step to total - 1.
    setIndex(i => Math.max(0, Math.min(i, total) - 1))
  }, [total])

  // Open the current card on its own, outside the review surface —
  // honouring the shared modifier policy (plain click zooms it into the
  // main panel, shift / shift+alt open it in the sidebar / a new panel).
  const openBlock = useBlockOpener({plainClick: 'navigator'})
  // Stable handle for the breadcrumb chain above the card.
  const currentBlock = useMemo(
    () => (currentId ? repo.block(currentId) : null),
    [repo, currentId],
  )

  const grade = useCallback(
    async (signal: SrsSignal) => {
      if (!currentId || busy) return
      setBusy(true)
      try {
        const block = repo.block(currentId)
        // The card may have left review since the queue was snapshotted
        // (its type or next-review date removed in another panel).
        // `rescheduleBlock` would re-add the type and write a fresh date,
        // silently resurrecting a card the user just removed — so drop it
        // from the session instead of grading it.
        const data = block.peek() ?? (await block.load())
        if (!data || !isLiveSrsCard(data)) {
          showInfo('Card is no longer in spaced repetition')
          advance()
          return
        }
        // Advance only when the write lands. A null result means the
        // reschedule was refused (e.g. read-only repo) — advancing then
        // would mark progress and eventually "complete" while the card's
        // due date never moved, so it'd resurface next session. Keep the
        // card and surface it.
        const result = await rescheduleBlock(block, signal)
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

  // Hand the card to the shared reschedule sheet. Advance only once the
  // sheet reports a committed date — cancelling, tapping outside, or
  // pressing Escape leaves the card in place rather than silently
  // skipping it (the user took no action, so neither should we).
  const reschedule = useCallback(() => {
    if (!currentId) return
    openReschedulePicker({
      blockId: currentId,
      workspaceId,
      onComplete: ({rescheduled}) => { if (rescheduled) advance() },
    })
  }, [currentId, workspaceId, advance])

  const changeDeck = useCallback(() => {
    void deck.set(reviewDeckStartedProp, false)
  }, [deck])

  // Reveal/grade run through the app's shortcut system via a dedicated
  // modal `srs-review` context (see actions.ts), not a hand-rolled key
  // handler. The session activates that context only while its own
  // (non-editor) chrome is focused, so a deck in a background panel — or
  // a second open deck — never grabs Space/1-4.
  //
  // We can't rely on the dispatcher's default editable-target filter to
  // keep grade keys out of the revealed answer's CodeMirror: EDIT_MODE_CM
  // opts editor events back in via its own eventFilter (filters OR
  // together), and this modal context would then shadow edit-mode and
  // eat Enter / 1-4. So we deactivate the context whenever focus lands on
  // an editable element instead.
  const [surfaceFocused, setSurfaceFocused] = useState(false)
  const controller = useMemo<SrsReviewController>(() => ({
    reveal: () => { if (!busy) setRevealed(true) },
    grade: signal => { if (revealed && !busy) void grade(signal) },
  }), [busy, revealed, grade])
  const shortcutActivations = useMemo(() => [{
    context: SRS_REVIEW_CONTEXT,
    dependencies: {controller},
    enabled: surfaceFocused && currentId !== null,
  }], [controller, surfaceFocused, currentId])
  useActionContextActivations(shortcutActivations)

  const handleSurfaceFocus = useCallback((e: ReactFocusEvent<HTMLDivElement>) => {
    // Active only when focus is on the session chrome itself, not the
    // answer editor or an interactive control — see the context note and
    // `isInteractiveTarget`.
    setSurfaceFocused(!isInteractiveTarget(e.target as HTMLElement | null))
  }, [])
  const handleSurfaceBlur = useCallback((e: ReactFocusEvent<HTMLDivElement>) => {
    // focusout bubbles; only treat it as leaving when focus moves
    // outside the session subtree entirely.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSurfaceFocused(false)
  }, [])

  // Focus the session surface once, when the card view first mounts, so
  // the shortcuts are live without a click. We don't refocus per card —
  // that would yank focus back from the reschedule sheet after it opens.
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const focusedOnce = useRef(false)
  const focusSessionSurface = useCallback((el: HTMLDivElement | null) => {
    surfaceRef.current = el
    if (el && !focusedOnce.current) {
      focusedOnce.current = true
      el.focus()
    }
  }, [])

  // On reveal, pull focus back to the surface so the grade keys (1-4) are
  // live — whether the answer was revealed via Space or by clicking the
  // "Show answer" button (which would otherwise leave focus on a button,
  // where the review context is intentionally inactive).
  useEffect(() => {
    if (revealed) surfaceRef.current?.focus()
  }, [revealed])

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
          {canGoBack && (
            <Button type="button" variant="ghost" size="sm" className="mt-1 h-7 px-2 text-xs" onClick={goBack}>
              <ArrowLeft className="mr-1 h-3.5 w-3.5" />
              Back to last card
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={focusSessionSurface}
      tabIndex={-1}
      onFocus={handleSurfaceFocus}
      onBlur={handleSurfaceBlur}
      className="mx-auto w-full max-w-2xl py-4 outline-none"
    >
      {header}

      {/* Ancestor chain for the card under review, so its context isn't
          lost outside the outline. Renders nothing for a top-level card. */}
      {currentBlock && <Breadcrumbs block={currentBlock} />}

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

      <div className="mt-3 flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
        <button
          type="button"
          className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-50"
          onClick={goBack}
          disabled={busy || !canGoBack}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Previous
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-50"
          onClick={e => openBlock(e, {blockId: currentId, workspaceId})}
          disabled={busy}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-50"
          onClick={reschedule}
          disabled={busy}
        >
          <CalendarClock className="h-3.5 w-3.5" />
          Reschedule
        </button>
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
