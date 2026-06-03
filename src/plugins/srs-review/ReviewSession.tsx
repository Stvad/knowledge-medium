import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
} from 'react'
import {
  ArchiveX,
  ArrowLeft,
  CalendarClock,
  Check,
  ChevronLeft,
  ExternalLink,
  Gauge,
  PartyPopper,
  RefreshCw,
  RotateCcw,
  SkipForward,
  Sparkles,
} from 'lucide-react'
import type { Block } from '@/data/block'
import type { BlockData } from '@/data/api'
import { useRepo } from '@/context/repo.js'
import { useManyParents, useProperty } from '@/hooks/block.js'
import { usePluginUIStateChildBlock } from '@/data/globalState.js'
import { getBlockTypes } from '@/data/properties.js'
import { NestedBlockContextProvider } from '@/context/block.js'
import { BlockComponent } from '@/components/BlockComponent.js'
import { Button } from '@/components/ui/button.js'
import { cn } from '@/lib/utils.js'
import { showError, showInfo } from '@/utils/toast.js'
import { useActionContextActivations } from '@/shortcuts/useActionContext.js'
import { useBlockOpener } from '@/utils/navigation.js'
import { PromotableBreadcrumbList, usePromotableBreadcrumb } from '@/plugins/breadcrumbs'
import { openReschedulePicker } from '@/plugins/daily-notes'
import {
  SRS_SM25_TYPE,
  formatIntervalDays,
  formatRescheduleToastMessage,
  rescheduleBlock,
  srsArchivedProp,
  srsFactorProp,
  srsIntervalProp,
  srsNextReviewDateProp,
} from '@/plugins/srs-rescheduling'
import { SrsSignal, estimateSrsIntervalDays } from '@/plugins/srs-rescheduling/scheduler.js'
import { useDueCards, useDueCardsReady } from './useDueCards.ts'
import { archiveSrsCard } from './archive.ts'
import { reviewDeckStartedProp, reviewProgressProp, srsReviewProgressType } from './schema.ts'
import { localDayKey, reconcileRestoredQueue, restoreSavedSession } from './reviewProgress.ts'
import { SRS_REVIEW_CONTEXT, type SrsReviewController } from './actions.ts'
import { SRS_REVIEW_CARD_ID, SRS_REVIEW_REVEALED } from './reviewCardLayout.tsx'

/** Breadcrumb context overrides — mirrors the breadcrumbs plugin's own
 *  header renderer so the in-review chain renders identically. */
const BREADCRUMB_OVERRIDES = {isNestedSurface: true, isBreadcrumb: true}
const EMPTY_PARENTS: readonly Block[] = []
/** How many cards' ancestors to prefetch per chunk (two chunks are in
 *  flight at once). Bounds the `core.manyAncestors` id count so a large
 *  deck can't exceed SQLite's host-parameter limit. */
const BREADCRUMB_PREFETCH = 24

/** Today's local day key, advanced when the date rolls over. Polls once a
 *  minute (cheap; only re-renders the minute the day changes), mirroring
 *  `useDueCards`' midnight-aware cutoff so a deck left open overnight saves
 *  and restores under the correct day. */
const useTodayKey = (): string => {
  const [key, setKey] = useState(localDayKey)
  useEffect(() => {
    const id = setInterval(() => {
      const next = localDayKey()
      setKey(prev => (prev === next ? prev : next))
    }, 60_000)
    return () => clearInterval(id)
  }, [])
  return key
}

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

/** The four grade buttons, each labelled with the interval the card would
 *  next be scheduled for if you picked it ("1d", "4d", "2mo", …). The
 *  estimate reads the card's live interval/factor so it tracks edits made
 *  elsewhere, and uses the same formatter as the post-grade toast so the
 *  two agree. Split into its own component so the `useProperty` reads only
 *  run for the card on screen. */
const GradeButtons = ({card, busy, onGrade}: {
  card: Block
  busy: boolean
  onGrade: (signal: SrsSignal) => void
}) => {
  const [interval] = useProperty(card, srsIntervalProp)
  const [factor] = useProperty(card, srsFactorProp)
  return (
    <div className="grid grid-cols-4 gap-2">
      {GRADE_BUTTONS.map(btn => (
        <Button
          key={btn.label}
          type="button"
          variant="outline"
          className="flex h-auto flex-col gap-1 py-2"
          disabled={busy}
          onClick={() => onGrade(btn.signal)}
        >
          <btn.icon className={cn('h-4 w-4', btn.className)} />
          <span className="text-sm font-medium">{btn.label}</span>
          <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
            {formatIntervalDays(estimateSrsIntervalDays({interval, factor}, btn.signal))}
          </span>
          <span className="text-[10px] opacity-50">{btn.hint}</span>
        </Button>
      ))}
    </div>
  )
}

export const ReviewSession = ({deck, tagName}: {deck: Block; tagName: string}) => {
  const repo = useRepo()
  const workspaceId = deck.peek()?.workspaceId ?? repo.activeWorkspaceId ?? ''
  const dueCards = useDueCards(workspaceId, tagName)
  const dueLoaded = useDueCardsReady(workspaceId, tagName)

  // Persist the in-progress session (frozen queue + place) on a per-deck
  // child of the plugin's ui-state block so navigating away and back
  // resumes instantly instead of re-running the due query and restarting
  // at card one — see `reviewProgressProp`. Keying by deck id (rather than
  // a single shared block discriminated by tag) lets every deck keep its
  // own frozen session, so switching decks no longer clobbers the others.
  const progressBlock = usePluginUIStateChildBlock(srsReviewProgressType, deck.id)
  const [progress, setProgress] = useProperty(progressBlock, reviewProgressProp)
  // Today's day key, advanced on rollover (mirrors `useDueCards`' cutoff)
  // so a session kept open past midnight saves under the new day and still
  // restores; a memoized-once key would stamp post-midnight saves with
  // yesterday and lose the user's place on the next visit.
  const todayKey = useTodayKey()

  // Resume a saved session if one's valid for this deck/day; otherwise
  // start empty and let the live-snapshot path below capture the queue.
  // `progressBlock` is loaded by the suspending hook above, so `progress`
  // already reflects storage on this first render.
  const savedSession = restoreSavedSession(progress, tagName, todayKey)
  const [queue, setQueue] = useState<readonly string[] | null>(() => savedSession?.queue ?? null)
  const [index, setIndex] = useState(() => savedSession?.index ?? 0)
  const [revealed, setRevealed] = useState(() => savedSession?.revealed ?? false)
  const [busy, setBusy] = useState(false)
  // True only when this mount resumed a saved session. Captured once:
  // `savedSession` itself flips back to non-null as soon as write-through
  // re-persists, so it can't serve as a stable "did we restore" signal.
  const [wasRestored] = useState(() => savedSession !== null)

  // Freeze the queue at the first non-empty load (a restored session is
  // already non-null, so this is skipped for it). Grading moves a card out
  // of `dueCards` (its next-review date jumps to the future), so walking
  // the live list would renumber the session under the user. We snapshot
  // ids once via the converge-during-render pattern, then read each card's
  // live state at grade time via `repo.block(id)`.
  if (queue === null && dueCards.length > 0) {
    setQueue(dueCards.map(c => c.id))
  }

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
  // Stable handle for the card's grade-interval estimates.
  const currentBlock = useMemo(
    () => (currentId ? repo.block(currentId) : null),
    [repo, currentId],
  )

  // Write-through: persist the live session so it survives unmount. One
  // object write per state change (UI-state scope, undo-segregated from
  // document edits). Skipped until the queue is established so we never
  // clobber a saved session with an empty one during the initial load.
  useEffect(() => {
    if (queue === null) return
    setProgress({queue: [...queue], index, revealed, tag: tagName, day: todayKey})
  }, [queue, index, revealed, tagName, todayKey, setProgress])

  // Reconcile a restored session against the live due set once it loads:
  // keep everything already reviewed (so Back/re-grade still works) but
  // drop not-yet-reached cards that are no longer due — e.g. rescheduled
  // on another surface since the session was saved. `useDueCards` is
  // already running for the snapshot/refresh paths, so this needs no extra
  // query. Runs once, and only after the query has actually resolved
  // (`dueLoaded`) — a loaded-but-empty deck (everything rescheduled away)
  // must still reconcile to "complete", which is why we gate on load
  // status rather than on a non-empty array.
  const reconciledRef = useRef(false)
  useEffect(() => {
    if (!wasRestored || reconciledRef.current || !dueLoaded) return
    reconciledRef.current = true
    const dueIds = new Set(dueCards.map(c => c.id))
    setQueue(prev => (prev === null ? prev : reconcileRestoredQueue(prev, index, dueIds)))
  }, [wasRestored, dueLoaded, dueCards, index])

  // Discard the saved session and rebuild from the live due set. Now that
  // progress persists (navigating away no longer resets it), this is the
  // way to start over. Setting the queue to null re-enters the
  // live-snapshot path; clearing storage is rewritten on the next snapshot.
  const restart = useCallback(() => {
    setRevealed(false)
    setIndex(0)
    setQueue(null)
    setProgress(null)
  }, [setProgress])

  // Window the ancestor prefetch. Passing every queued id to one
  // `core.manyAncestors` call (one SQL placeholder per id) would let a deck
  // with a very large due queue exceed SQLite's host-parameter limit and
  // fail the whole session. Anchor the window to a fixed-size chunk so the
  // handle key — and thus the query — changes only every
  // BREADCRUMB_PREFETCH cards rather than on every advance, and span two
  // chunks so the next chunk is already warm before the user reaches it.
  const prefetchStart = Math.floor(index / BREADCRUMB_PREFETCH) * BREADCRUMB_PREFETCH
  const queueBlocks = useMemo(
    () => (queue ?? [])
      .slice(prefetchStart, prefetchStart + BREADCRUMB_PREFETCH * 2)
      .map(id => repo.block(id)),
    [queue, repo, prefetchStart],
  )
  const parentsByCardId = useManyParents(queueBlocks)
  const currentParents = currentId
    ? parentsByCardId.get(currentId) ?? EMPTY_PARENTS
    : EMPTY_PARENTS

  // Promote-in-place: a plain breadcrumb click "unfurls" that ancestor —
  // the card surface re-renders its subtree (the card is still visible
  // nested below) and the chain truncates to it, mirroring the backlinks
  // entry. The shared hook owns the shown-block state and snaps back to
  // the card whenever it changes (advance / back / skip / restart), so a
  // promotion never leaks across cards; modifier clicks navigate (handled
  // by `PromotableBreadcrumbList`).
  const {shownId, promote: promoteBreadcrumb} = usePromotableBreadcrumb(currentId ?? '')
  // The shown block's ancestors are a prefix of the card's chain, so we
  // can slice the already-fetched parents instead of querying again.
  const shownParents = useMemo(() => {
    if (!currentId || shownId === currentId) return currentParents
    const cut = currentParents.findIndex(p => p.id === shownId)
    return cut >= 0 ? currentParents.slice(0, cut) : currentParents
  }, [shownId, currentId, currentParents])

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
      <div className="flex items-center gap-1">
        <span className="text-xs tabular-nums text-muted-foreground">
          {total === 0 ? '' : `${Math.min(index + 1, total)} / ${total}`}
        </span>
        {queue !== null && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={restart}
            disabled={busy}
            title="Restart review from the cards due now"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
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

  // currentId is non-null past the guards above, so the shown surface id
  // is always a concrete block id (the card, or a promoted ancestor).
  const surfaceId = shownId
  const showingCard = surfaceId === currentId

  return (
    <div
      ref={focusSessionSurface}
      tabIndex={-1}
      onFocus={handleSurfaceFocus}
      onBlur={handleSurfaceBlur}
      className="mx-auto w-full max-w-2xl py-4 outline-none"
    >
      {header}

      {/* Ancestor chain for the block on screen, so its context isn't lost
          outside the outline. Fed from the batched prefetch above so it's
          already warm; renders nothing for a top-level block. Plain click
          unfurls a segment in place (promote); modifier clicks navigate. */}
      {shownParents.length > 0 && (
        <PromotableBreadcrumbList
          parents={shownParents}
          workspaceId={workspaceId}
          overrides={BREADCRUMB_OVERRIDES}
          onPromote={promoteBreadcrumb}
          className="mb-2 flex flex-wrap items-center gap-1 overflow-x-auto py-1 text-sm text-muted-foreground"
          itemClassName="max-w-full cursor-pointer truncate no-underline"
          separatorClassName="mx-1 text-muted-foreground/50"
        />
      )}

      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <NestedBlockContextProvider
          // While the card itself is shown, gate its answer with the review
          // layout context. A promoted ancestor renders its full subtree
          // normally (the card sits within it, in context).
          overrides={showingCard ? {
            [SRS_REVIEW_CARD_ID]: currentId,
            [SRS_REVIEW_REVEALED]: revealed,
            isNestedSurface: true,
            scopeRootId: currentId,
            renderScopeId: `srs-review:${currentId}`,
          } : {
            isNestedSurface: true,
            scopeRootId: surfaceId,
            renderScopeId: `srs-review:${currentId}:${surfaceId}`,
          }}
        >
          {/* keyed by the shown id so switching cards (or promoting) remounts
              the subtree rather than diffing one outline into the next */}
          <BlockComponent key={surfaceId} blockId={surfaceId} />
        </NestedBlockContextProvider>
      </div>

      <div className="mt-4">
        {!revealed ? (
          <Button type="button" className="w-full" onClick={() => setRevealed(true)} disabled={busy}>
            Show answer
            <span className="ml-2 text-xs opacity-70">space</span>
          </Button>
        ) : currentBlock ? (
          <GradeButtons card={currentBlock} busy={busy} onGrade={signal => void grade(signal)} />
        ) : null}
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
          onClick={advance}
          disabled={busy}
        >
          <SkipForward className="h-3.5 w-3.5" />
          Skip
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
