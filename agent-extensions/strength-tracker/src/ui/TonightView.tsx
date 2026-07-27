/** Tonight's prescription + fast logging.
 *
 *  Mobile-first, dark-mode-friendly, usable half-tired at 1am. Every set is
 *  pre-filled from the prescription; the workout is *materialized* into blocks
 *  on the first settled edit and every set is a block edited in place — so a
 *  reload, tab switch, or second device just re-reads the same synced blocks,
 *  and switching A/B is non-destructive (each session is its own live block).
 *  Numeric edits persist on blur; done-taps persist immediately; "Finish"
 *  reconciles the whole draft to blocks, prunes the un-accepted sets, and
 *  flips the workout to done (still the layoff-record + shoulder-check point).
 */

import {useEffect, useRef, useState} from 'react'

import type {Repo} from '@/data/repo.js'
import {openDialog} from '@/utils/dialogs.js'

import {detectPendingLayoff, layoffAlreadyRecorded, layoffFromPending} from '../engine/reentry'
import {detectLeftRightAsymmetry} from '../engine/shoulder'
import type {ExerciseVideo, SessionType} from '../engine/types'
import {altOptionKey} from '../engine/types'
import {SHOULDER_POLICY_BLOCK_ID} from '../km/fields'
import type {LiveWorkout} from '../km/history'
import {
  discardWorkout,
  finishWorkout,
  materializeExercise,
  startWorkout,
  writeLayoff,
  writeSet,
  writeShoulderTodo,
} from '../km/store'
import {ShoulderChecklistDialog} from './ShoulderChecklistDialog'
import type {ProgramState} from './useProgram'
import {
  applyIdPatch,
  createWriteCoordinator,
  type IdPatch,
  type WriteCoordinator,
  type WriteEffects,
} from './writeCoordinator'
import {
  buildDraft,
  hasAcceptedSets,
  overlayLive,
  rowKey,
  setKey,
  toExerciseDraft,
  toMaterializeDraft,
  type DraftExercise,
  type DraftSet,
} from './draft'

const SESSION_LABELS: Record<SessionType, string> = {A: 'A · upper', B: 'B · lower', mini: 'mini'}
/** Named, because a successful retry has to be able to take it back down —
 *  it tells the user to tap again, and leaving it up after the tap worked
 *  invites the second, reversing tap. */
const WRITE_FAILED = 'Could not save that — check the connection and tap it again.'
const SHOULDER_CHECK_EVERY = 4

interface Props {
  repo: Repo
  workspaceId: string
  pageId: string
  program: ProgramState
}

export function TonightView({repo, workspaceId, pageId, program}: Props) {
  const {prescription, session, setSession, config, history, layoffs, liveWorkouts, liveLoaded, configLoaded, day} = program
  const readOnly = repo.isReadOnly
  const unit = config.unit

  const live = liveWorkouts.find(w => w.day === day && w.session === session)

  const [draft, setDraft] = useState<DraftExercise[]>(() => overlayLive(buildDraft(prescription, unit), live))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  /** Bumped to ask the overlay to run again when no query emission is coming
   *  — i.e. after a write FAILED. Nothing changed on the block, so the draft
   *  would otherwise keep showing a value that never landed. */
  const [resync, setResync] = useState(0)

  // Mirror the latest draft into a ref so edit handlers can persist the
  // freshly-computed next state without awaiting a re-render.
  const draftRef = useRef(draft)
  draftRef.current = draft

  /** Sets with a write in flight — the block is momentarily behind what the
   *  user just did, and the live overlay must not "correct" it back.
   *
   *  This is the one job the removed per-set `dirty` flag was doing that
   *  moving keystrokes into the input did NOT replace. It lives here rather
   *  than in the draft because it is not a property of the set — it is a
   *  property of this client's outstanding I/O — and because a pure overlay
   *  cannot tell an in-flight write from a failed one.
   *
   *  Keyed on `setKey`, not the block id: the first write of the night is
   *  made by the very tap that CREATES the block, so there is no id to key on
   *  at the moment the exemption has to start.
   *
   *  COUNTED, not a plain set: one set routinely has two writes in flight at
   *  once — typing reps and then tapping the checkbox blurs the input first,
   *  so the reps write and the done write overlap. With a set, the first to
   *  finish un-exempts it while the second is still going. */
  const inFlightRef = useRef(new Map<string, number>())
  const beginWrite = (key: string) =>
    inFlightRef.current.set(key, (inFlightRef.current.get(key) ?? 0) + 1)
  const endWrite = (key: string) => {
    const left = (inFlightRef.current.get(key) ?? 1) - 1
    if (left > 0) inFlightRef.current.set(key, left)
    else inFlightRef.current.delete(key)
  }
  /** The sets currently exempt — `Map` keys read as the `ReadonlySet` the
   *  overlay wants (`has` is all it uses). */
  const writingNow = (): ReadonlySet<string> => new Set(inFlightRef.current.keys())

  // "Which block does this set write to, and what has to be created first" —
  // the whole answer, unit-tested in writeCoordinator.ts. The view keeps only
  // the React half: applying the ids it hands back.
  const slot = `${day}|${session}`
  const shape = prescription.exercises
    .map(e => `${e.defId ?? e.exercise}:${e.weight ?? ''}:${e.sets}:${e.repMin ?? ''}-${e.repMax ?? ''}:${e.perSide}`)
    .join(',')
  const coordinatorRef = useRef<WriteCoordinator | null>(null)
  coordinatorRef.current ??= createWriteCoordinator(live?.id ?? null, slot, shape)
  const coordinator = coordinatorRef.current

  /** The writes the coordinator orchestrates. Rebuilt per render so a create
   *  always uses the current day/session. */
  const effects: WriteEffects = {
    // `startWorkout`, not a bare create: this fires from a checkbox tap whose
    // timing we don't control, and on first paint `live` is empty because the
    // query hasn't resolved — indistinguishable from "nothing logged". It
    // adopts an in-progress workout for this day+session when there is one.
    createWorkout: rows => startWorkout(repo, workspaceId, pageId, toMaterializeDraft(day, session, rows)),
    // `ex.blockId` — the entry this row is attached to, when it has one. An
    // entry logged before the plan outline was readable is keyed on the lift's
    // NAME, while the row now keys on its plan block; re-deriving there builds
    // a second entry beside the one on screen and the record shows the lift
    // twice.
    createExercise: (workoutId, ex) =>
      materializeExercise(repo, workoutId, toExerciseDraft(ex), ex.blockId),
  }

  /** The draft, re-derived from its inputs on every emission.
   *
   *  There is no longer a question of whether this emission is worth reacting
   *  to. `overlayLive` takes what is on screen as an input and merges rather
   *  than replaces, so running it always is both correct and cheap (it hands
   *  back the same array when nothing moved). The guard this replaced had to
   *  decide, from five clauses, whether an arriving `live` was "our own
   *  create, one query behind" — and every version of that guard was wrong
   *  about some third case: it skipped an `or`-group switch, or it discarded
   *  a tick whose write was still in flight. */
  useEffect(() => {
    const {slotChanged} = coordinator.reset(live?.id ?? null, slot, shape)
    const writing = writingNow()
    // On a session switch, what is on screen is about the OTHER session, so it
    // is not an input. Two sessions can prescribe the same lift and the
    // overlay matches rows BY the lift — so passing the old draft through
    // handed session B session A's block ids, and the first tap in B wrote
    // into A's workout, at A's weights, without ever materializing B.
    setDraft(cur => overlayLive(buildDraft(prescription, unit), live, slotChanged ? [] : cur, writing, liveLoaded))
    // Keep a confirmation the user hasn't seen. Finishing makes the workout
    // leave `liveWorkouts`, which lands here — clearing "Logged Session A"
    // the instant it appeared and leaving a screen that looks like nothing
    // happened, which invites a second workout for tonight.
    if (slotChanged) setStatus(null)
  }, [slot, unit, live, liveLoaded, prescription, shape, coordinator, resync])

  const applyPatch = (
    prev: DraftExercise[],
    exIdx: number,
    setIdx: number,
    patch: Partial<DraftSet>,
  ): DraftExercise[] =>
    prev.map((ex, i) =>
      i !== exIdx ? ex : {...ex, sets: ex.sets.map((s, j) => (j !== setIdx ? s : {...s, ...patch}))},
    )

  /** Resolve the block for one set (creating whatever is missing) and write
   *  it. Reads from `next` so it never races React state; ids that come back
   *  are stamped into the draft. */
  const persist = async (
    next: readonly DraftExercise[],
    exIdx: number,
    setIdx: number,
    change: Partial<DraftSet>,
  ): Promise<IdPatch | undefined> => {
    // Writing before the plan outline has been read derives ids from exercise
    // NAMES, while the records that exist are keyed on their plan block — a
    // whole parallel tree of blocks for a session already in progress.
    if (readOnly || !configLoaded) return undefined
    // Exempt from the overlay for the WHOLE round trip, resolve included: the
    // first tap of the night creates the blocks, and an emission arriving
    // mid-create would otherwise re-derive this set from the prescription and
    // drop the tick that started it all.
    const writingKey = setKey(next[exIdx], setIdx)
    beginWrite(writingKey)
    try {
      const {blockId, patch} = await coordinator.resolveSet(next, exIdx, setIdx, effects)
      if (patch) setDraft(cur => applyIdPatch(cur, patch))
      // The CHANGE, not the whole set: the rest of this row may be older than
      // the block (the live query hadn't resolved when the draft was built),
      // and writing it back is how logged reps got replaced by the
      // prescription's.
      // A block that is GONE is a failure, not a no-op: the draft is holding
      // an id for a set that was undone, deleted from the outline, or pruned
      // by a Finish this view hasn't seen. Treating it as success left the
      // checkbox ticked over nothing.
      const outcome = blockId ? await writeSet(repo, blockId, change, next[exIdx].unit) : 'written'
      endWrite(writingKey)
      if (outcome === 'gone') {
        setResync(n => n + 1)
        throw new Error(`writeSet: set block ${blockId} is gone`)
      }
      // This tap worked, so take down a "tap it again" left over from the last
      // one that didn't. Only that message — a "Logged …" confirmation is
      // about something else and must survive.
      setStatus(current => (current === WRITE_FAILED ? null : current))
      // No overlay on success, deliberately. The block now agrees with what is
      // on screen, and the write's OWN query emission re-runs the overlay a
      // moment later with the news. Asking for one here instead reverted every
      // tap, because the `live` it would run against is the one from before
      // this write — the version that still says `open`.
      return patch
    } catch (error) {
      // A failure is the case that genuinely needs it: nothing changed on the
      // block, so no emission is coming, and the draft would keep showing a
      // value that never reached it.
      endWrite(writingKey)
      setResync(n => n + 1)
      throw error
    }
  }

  /** A write failing must not be silent: the checkbox stays ticked on screen
   *  and the user would have no idea their session is going nowhere. */
  const reportWriteFailure = (error: unknown) => {
    console.error('[strength] write failed', error)
    setStatus(WRITE_FAILED)
  }

  const commitSet = (exIdx: number, setIdx: number, patch: Partial<DraftSet>) => {
    const next = applyPatch(draftRef.current, exIdx, setIdx, patch)
    setDraft(next)
    void persist(next, exIdx, setIdx, patch).catch(reportWriteFailure)
  }

  const toggleDone = (exIdx: number, setIdx: number, done: boolean) =>
    commitSet(exIdx, setIdx, {done, completedAt: done ? Date.now() : undefined})

  const acceptAll = (exIdx: number) => {
    const now = Date.now()
    // Only the sets that weren't already accepted. A set logged an hour ago
    // has a completion time, and "accept the rest" is not a claim about when
    // that one happened — writing `now` to it re-dated real history.
    const pending = draftRef.current[exIdx].sets
      .map((s, j) => (s.done ? -1 : j))
      .filter(j => j >= 0)
    if (pending.length === 0) return
    const next = draftRef.current.map((ex, i) =>
      i !== exIdx ? ex : {...ex, sets: ex.sets.map(s => (s.done ? s : {...s, done: true, completedAt: now}))},
    )
    setDraft(next)
    // The WHOLE batch is exempt from the overlay up front, not one set at a
    // time. Each write's own commit emits, and an emission mid-loop sees every
    // set the loop hasn't reached yet as un-exempt — so it reverted their
    // freshly-ticked boxes and the bulk action visibly undid itself.
    const batch = pending.map(j => setKey(next[exIdx], j))
    for (const key of batch) beginWrite(key)
    // Persist every pending set of this exercise; materialize on the first if
    // needed.
    //
    // `rows` is REASSIGNED as ids come back, exactly like the Finish loop:
    // handing the same block-less snapshot to every iteration made the later
    // sets look like an exercise that needed creating, so a reseed landing
    // mid-loop (the create's own query update does that) grew a duplicate
    // entry and scattered the sets across the two.
    void (async () => {
      try {
        let rows: readonly DraftExercise[] = next
        for (const j of pending) {
          const patch = await persist(rows, exIdx, j, {done: true, completedAt: now})
          if (patch) rows = applyIdPatch(rows, patch)
        }
      } finally {
        for (const key of batch) endWrite(key)
      }
    })().catch(reportWriteFailure)
  }

  const finish = async () => {
    if (readOnly || busy || !canFinish) return
    // Finishing PRUNES. Doing that against a draft that hasn't met the blocks
    // yet — the live query still resolving, so every set reads un-done — marks
    // the workout done and deletes the whole session. Wait for the view to be
    // looking at the workout it is about to finish.
    const pending = coordinator.workoutId()
    if (!configLoaded || (pending !== null && live?.id !== pending)) {
      setStatus('Still catching up with tonight’s log — give it a moment and tap Finish again.')
      return
    }
    setBusy(true)
    // Finish is a dozen-plus transactions. If the draft is reseeded under it
    // (a session switch, a plan reload), everything after that point would be
    // aimed at a workout this view is no longer editing.
    const at = coordinator.generation()
    try {
      // Flush every set through the same resolver the edit path uses, so a
      // Finish pressed mid-create (or right after an or-group switch) joins
      // that create instead of racing a second workout.
      //
      // Ids land in a LOCAL copy as well as in the draft: `setDraft` doesn't
      // apply synchronously, so pruning off `draftRef` would see every
      // exercise as block-less and keep NOTHING — the workout would be marked
      // done with all its pre-filled sets still open.
      let flushed = draftRef.current
      // Indexed, not destructured: `flushed` is REPLACED whenever a create
      // hands back ids, so a captured `ex` would go stale mid-loop.
      for (let i = 0; i < flushed.length; i += 1) {
        // Nothing accepted and nothing on disk: creating blocks here only to
        // prune them two lines later is pure churn (and, after an or-group
        // switch, a create→delete round trip on every Finish).
        if (!flushed[i].blockId && !flushed[i].sets.some(s => s.done)) continue
        for (let j = 0; j < flushed[i].sets.length; j += 1) {
          // Only the acceptance, and only for sets this view believes are
          // done. Weight and reps were written by their own blur, and
          // re-asserting them here would push this draft's copy back over
          // whatever the block has learned since — including from the outline
          // right below, or another device. A set that is done on the block
          // but open here is left alone: `finishPlan` unions both.
          if (!flushed[i].sets[j].done) continue
          const {blockId, patch} = await coordinator.resolveSet(flushed, i, j, effects)
          if (patch) {
            flushed = applyIdPatch(flushed, patch)
            setDraft(cur => applyIdPatch(cur, patch))
          }
          if (blockId) {
            const {done, completedAt} = flushed[i].sets[j]
            const outcome = await writeSet(repo, blockId, {done, completedAt}, flushed[i].unit)
            if (outcome === 'gone') {
              // A set this screen shows as accepted is not there any anymore —
              // deleted from the outline, or undone, since the last emission.
              // Finishing anyway would prune whatever that leaves empty and
              // then report the session as logged INCLUDING that set, off a
              // draft that is now fiction. Stop and re-read instead; the ticks
              // already flushed have landed, and the workout stays live.
              setResync(n => n + 1)
              setStatus('Something changed while saving — the log has been re-read. Check it and tap Finish again.')
              return
            }
          }
        }
      }

      const wid = coordinator.workoutId()
      if (!wid || coordinator.generation() !== at) {
        // The session moved while this was running. Sets written before that
        // point DID land in the workout they belonged to — say that, rather
        // than the old message's claim that nothing was logged, which sent
        // the user looking for data that exists.
        setStatus('Session changed while saving — what you logged is kept, but this session was not finished.')
        return
      }

      const pending = detectPendingLayoff(history, day, config)
      if (pending && !layoffAlreadyRecorded(pending, layoffs)) {
        await writeLayoff(repo, workspaceId, pageId, layoffFromPending(pending))
      }
      // No plan argument: `finishWorkout` re-reads the tree inside its own
      // transaction, so nothing this view believes can prune a set the blocks
      // say was performed.
      await finishWorkout(repo, wid)
      // Tonight's log is now a RECORD, and this view must stop being attached
      // to it. Nothing else says so: a finished workout simply leaves
      // `liveWorkouts`, which is indistinguishable from a query that hasn't
      // caught up — so the coordinator kept its id (a same-slot reset never
      // falls back to null, on purpose) and the overlay kept every block id on
      // screen. `started` stayed true, which left the DISCARD button live: one
      // tap and the session just logged was tombstoned. Taps on the still-
      // rendered sets wrote into finished blocks, moving the next session's
      // prescribed weight; Finish answered "still catching up" forever.
      //
      // `completed`, not `abandon`: both stop in-flight creates from landing,
      // but `abandon` is "this evening is empty again" and this is "this
      // evening holds a finished workout" — the next session of the same type
      // gets a new slot rather than adopting this one.
      coordinator.completed()
      setDraft(buildDraft(prescription, unit))
      const lifts = flushed.filter(ex => ex.sets.some(s => s.done)).length
      setStatus(`Logged ${SESSION_LABELS[session]} — ${lifts} lifts`)

      // The workout is SAVED from here on, so nothing after this point may
      // report it as unsaved. The shoulder check is a follow-up prompt, and a
      // failure in it used to reach `finish`'s caller as "Could not save that
      // — tap it again" over a session that was already logged. Tapping again
      // now starts a second session for tonight, because the coordinator has
      // released this one.
      const fullBefore = history.filter(w => w.session !== 'mini').length
      const isFull = session !== 'mini'
      const due = isFull && ((fullBefore + 1) % SHOULDER_CHECK_EVERY === 0 || detectLeftRightAsymmetry(history))
      if (due) {
        try {
          const result = await openDialog(ShoulderChecklistDialog, {history})
          if (result && result.checkedPrompts.length > 0) {
            await writeShoulderTodo(repo, workspaceId, pageId, result.checkedPrompts, SHOULDER_POLICY_BLOCK_ID)
            setStatus('Shoulder trigger logged → consult todo created')
          }
        } catch (error) {
          console.error('[strength] shoulder follow-up failed', error)
          setStatus(`Logged ${SESSION_LABELS[session]} — the shoulder check could not be saved.`)
        }
      }
    } finally {
      setBusy(false)
    }
  }

  const discard = async () => {
    const wid = coordinator.workoutId()
    if (!wid || busy) return
    setBusy(true)
    // Not `reset`: a create still in flight must not write into the blocks
    // this is about to tombstone (they'd be live todo sets under a deleted
    // workout). `abandon` makes those results yield nothing.
    coordinator.abandon()
    try {
      await discardWorkout(repo, wid)
      setDraft(buildDraft(prescription, unit))
      setStatus('Discarded')
    } finally {
      setBusy(false)
    }
  }

  // Done-ness is the built-in todo checkbox, so sets can be accepted from the
  // outline or another device without this draft hearing about it. Finish has
  // to be reachable in that case too.
  const canFinish = !readOnly && !busy && configLoaded
    && (hasAcceptedSets(draft) || (live?.exercises.some(ex => ex.sets.some(s => s.done)) ?? false))
  // Derived from the draft rather than the coordinator: the coordinator lives
  // in a ref, so reading it here wouldn't re-render when the workout appears.
  // Every materialized row carries a block id, which is the same signal.
  const started = draft.some(ex => ex.blockId !== undefined)

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="text-lg font-semibold">Tonight · {day}</div>
          {prescription.offSchedule && (
            <div className="text-xs text-muted-foreground">off template — inferred session</div>
          )}
        </div>
        <div className="grid grid-cols-3 gap-1" role="group" aria-label="Session">
          {(['A', 'B', 'mini'] as const).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setSession(s)}
              // Switching mid-save reseeds the draft under the operation in
              // flight, which used to split one session's sets across two
              // workouts (and finish the wrong one).
              disabled={busy}
              aria-pressed={session === s}
              className={
                'rounded-md px-3 py-2 text-sm font-medium ' +
                (session === s
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border text-muted-foreground hover:bg-muted')
              }
            >
              {SESSION_LABELS[s]}
            </button>
          ))}
        </div>
      </header>

      {prescription.reentry && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <div className="font-medium text-amber-700 dark:text-amber-300">{prescription.reentry.banner}</div>
          {prescription.reentry.tier.guidance && (
            <div className="mt-0.5 text-xs text-muted-foreground">{prescription.reentry.tier.guidance}</div>
          )}
        </div>
      )}

      <ol className="flex flex-col gap-3">
        {draft.map((ex, exIdx) => (
          <ExerciseCard
            // The row's own identity — so switching an `or`-group remounts
            // the card (it is a different lift) while a plan edit that merely
            // reorders the session does not.
            key={rowKey(ex)}
            ex={ex}
            unit={unit}
            locked={readOnly || busy || !configLoaded}
            onCommit={(setIdx, patch) => commitSet(exIdx, setIdx, patch)}
            onToggleDone={(setIdx, done) => toggleDone(exIdx, setIdx, done)}
            onAcceptAll={() => acceptAll(exIdx)}
            // `locked`, not just `readOnly`: switching an option changes the
            // shape, which bumps the coordinator's generation — under a
            // running Finish that aborts it with "Session changed while
            // saving". It was the one control that could move the ground
            // under a save in progress.
            onSwitch={
              ex.altGroupKey && !readOnly && !busy && configLoaded
                ? (optionKey, label) => program.setAltChoice(ex.altGroupKey as string, optionKey, label)
                : undefined
            }
          />
        ))}
      </ol>

      {prescription.notes.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Session notes</summary>
          <ul className="mt-1 list-disc pl-5">
            {prescription.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </details>
      )}

      {program.warnings.length > 0 && (
        <details className="text-xs text-amber-600 dark:text-amber-400">
          <summary className="cursor-pointer select-none">{program.warnings.length} plan warning(s)</summary>
          <ul className="mt-1 list-disc pl-5">
            {program.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-border bg-background/90 py-3 backdrop-blur">
        <span className="text-sm text-muted-foreground">
          {status ?? (!configLoaded ? 'Reading your plan…' : started ? 'Saved as you go' : '')}
        </span>
        <div className="flex items-center gap-2">
          {started && !readOnly && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void discard()}
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              Discard
            </button>
          )}
          <button
            type="button"
            disabled={!canFinish}
            onClick={() => void finish().catch(reportWriteFailure)}
            className={
              'rounded-md px-4 py-2 text-sm font-medium ' +
              (canFinish
                ? 'bg-primary text-primary-foreground hover:opacity-90'
                : 'cursor-not-allowed bg-muted text-muted-foreground')
            }
          >
            {busy ? 'Saving…' : 'Finish & log'}
          </button>
        </div>
      </div>
    </div>
  )
}
TonightView.displayName = 'TonightView'


function ExerciseCard({
  ex,
  unit,
  locked,
  onCommit,
  onToggleDone,
  onAcceptAll,
  onSwitch,
}: {
  ex: DraftExercise
  unit: string
  /** No edits right now: read-only workspace, or a save in flight (a tick
   *  made during Finish would be written and then pruned by the plan that
   *  was snapshotted before it). */
  locked: boolean
  onCommit: (setIdx: number, patch: Partial<DraftSet>) => void
  onToggleDone: (setIdx: number, done: boolean) => void
  onAcceptAll: () => void
  onSwitch?: (optionKey: string, label: string) => void
}) {
  const range =
    ex.repMin !== undefined && ex.repMax !== undefined
      ? `${ex.repMin}–${ex.repMax}`
      : ex.repMax !== undefined
        ? `${ex.repMax}`
        : ''
  // Per-side lifts double the draft rows (L+R); show the per-leg set count the
  // plan states, not the doubled row count.
  const setCount = ex.prescribedSets ?? (ex.perSide ? ex.sets.length / 2 : ex.sets.length)
  const target =
    `${setCount} × ${range || '—'}${ex.perSide ? ' / side' : ''}` +
    (ex.prescribedWeight ? ` @ ${ex.prescribedWeight}${unit}` : '')

  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">{ex.exercise}</div>
          <div className="text-xs text-muted-foreground">{target}</div>
          <div className="text-xs text-muted-foreground/80">{ex.rationale}</div>
        </div>
        {!locked && (
          <button
            type="button"
            onClick={onAcceptAll}
            className="shrink-0 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            all ✓
          </button>
        )}
      </div>
      {onSwitch && ex.altOptions && ex.altOptions.length > 1 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {ex.altOptions.map(option => {
            // Which chip is lit: by block when both sides know one (so a
            // renamed option still reads as the tracked one), else by name.
            const current =
              option.defId !== undefined && ex.defId !== undefined
                ? option.defId === ex.defId
                : option.name === ex.exercise
            return (
              <button
                key={altOptionKey(option)}
                type="button"
                onClick={() => !current && onSwitch(altOptionKey(option), option.name)}
                aria-pressed={current}
                className={
                  'rounded-full px-2.5 py-1 text-xs ' +
                  (current
                    ? 'bg-primary/15 font-medium text-primary'
                    : 'border border-border text-muted-foreground hover:bg-muted')
                }
              >
                {option.name}
              </button>
            )
          })}
        </div>
      )}
      {ex.note && <div className="mt-1 whitespace-pre-line text-xs text-muted-foreground/70">{ex.note}</div>}
      {ex.videos && ex.videos.length > 0 && <VideoLinks videos={ex.videos} />}
      <div className="mt-2 flex flex-col gap-1.5">
        {ex.sets.map((s, i) => (
          <SetRow
            key={i}
            set={s}
            unit={unit}
            locked={locked}
            onCommit={patch => onCommit(i, patch)}
            onToggleDone={done => onToggleDone(i, done)}
          />
        ))}
      </div>
    </li>
  )
}

function VideoLinks({videos}: {videos: readonly ExerciseVideo[]}) {
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
      {videos.map((v, i) => (
        <a
          key={i}
          href={v.url}
          target="_blank"
          rel="noreferrer"
          className="text-xs font-medium text-primary underline underline-offset-2 hover:opacity-80"
        >
          ▶ {v.label}
        </a>
      ))}
    </div>
  )
}

const fieldText = (value: number): string => (Number.isFinite(value) ? String(value) : '')

/** The one place uncommitted state lives.
 *
 *  Keystrokes stay inside this input until blur, so the draft — and every
 *  block under it — only ever holds settled values. That is what lets the
 *  live overlay apply unconditionally: there is nothing half-typed anywhere
 *  for it to overwrite. The alternative (keystrokes in the shared draft)
 *  needs a per-set dirty flag on every set to stay safe, which is a lot of
 *  machinery to protect one text field.
 *
 *  It also stops a full re-render of every card on each digit. */
function NumberField({
  value,
  label,
  disabled,
  onCommit,
}: {
  value: number
  label: string
  disabled: boolean
  onCommit: (value: number) => void
}) {
  const [text, setText] = useState(() => fieldText(value))
  const [shown, setShown] = useState(value)
  const [editing, setEditing] = useState(false)
  // What the field read when focus arrived. Blur commits only if the USER
  // moved it: comparing against `value` instead would commit whenever the
  // block changed underneath a focused field, writing the number the user was
  // merely looking at back over the newer one.
  const enteredRef = useRef('')

  // Follow the block when the change came from anywhere but this input — but
  // never while it's focused, or a set someone ticks elsewhere would rewrite
  // the number under the cursor.
  if (value !== shown) {
    setShown(value)
    if (!editing) setText(fieldText(value))
  }

  return (
    <input
      type="number"
      inputMode="numeric"
      aria-label={label}
      disabled={disabled}
      value={text}
      // Select on focus so a tap-and-type replaces the pre-filled number.
      onFocus={e => {
        setEditing(true)
        enteredRef.current = e.currentTarget.value
        e.currentTarget.select()
      }}
      onChange={e => setText(e.currentTarget.value)}
      // Enter is how you say "done with this field" on a phone keyboard.
      // Without it the typed value lives only in the DOM until something else
      // blurs it — lock the phone first and it is gone.
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      // Persist the settled value on blur (cheap, and the block is the record).
      onBlur={e => {
        setEditing(false)
        const raw = e.currentTarget.value
        if (raw === enteredRef.current) {
          // Untouched. Resync to the PROP, not to what is on screen: the block
          // may have moved while this field was focused, and the catch-up
          // above is keyed on `value !== shown`, which by now is false — so
          // this is the only remaining chance to stop showing a stale number.
          setText(fieldText(value))
          return
        }
        const next = raw === '' ? 0 : Number(raw)
        setText(fieldText(next))
        onCommit(next)
      }}
      className="h-9 w-16 rounded border border-border bg-background px-2 text-right text-sm tabular-nums"
    />
  )
}

function SetRow({
  set,
  unit,
  locked,
  onCommit,
  onToggleDone,
}: {
  set: DraftSet
  unit: string
  locked: boolean
  onCommit: (patch: Partial<DraftSet>) => void
  onToggleDone: (done: boolean) => void
}) {
  return (
    <div className={'flex items-center gap-2 rounded px-1 py-1 ' + (set.done ? 'bg-primary/10' : '')}>
      {set.side && (
        <span className="w-4 shrink-0 text-center text-xs font-medium text-muted-foreground">{set.side}</span>
      )}
      <NumberField
        value={set.weight}
        label="weight"
        disabled={locked}
        onCommit={weight => onCommit({weight})}
      />
      <span className="shrink-0 text-xs text-muted-foreground">{unit} ×</span>
      <NumberField value={set.reps} label="reps" disabled={locked} onCommit={reps => onCommit({reps})} />
      <label className="ml-auto flex cursor-pointer items-center gap-1.5 py-1 pl-2 text-xs text-muted-foreground">
        <span>done</span>
        <input
          type="checkbox"
          disabled={locked}
          checked={set.done}
          onChange={e => onToggleDone(e.currentTarget.checked)}
          className="h-6 w-6 rounded border-border accent-primary"
        />
      </label>
    </div>
  )
}
