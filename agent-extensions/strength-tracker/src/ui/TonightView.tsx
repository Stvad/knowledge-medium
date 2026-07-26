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
import {SHOULDER_POLICY_BLOCK_ID} from '../km/config'
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
  liveIdentity,
  overlayLive,
  overlayLiveValues,
  toExerciseDraft,
  toMaterializeDraft,
  type DraftExercise,
  type DraftSet,
} from './draft'

const SESSION_LABELS: Record<SessionType, string> = {A: 'A · upper', B: 'B · lower', mini: 'mini'}
const SHOULDER_CHECK_EVERY = 4

interface Props {
  repo: Repo
  workspaceId: string
  pageId: string
  program: ProgramState
}

export function TonightView({repo, workspaceId, pageId, program}: Props) {
  const {prescription, session, setSession, config, history, layoffs, liveWorkouts, configLoaded, day} = program
  const readOnly = repo.isReadOnly
  const unit = config.unit

  const live = liveWorkouts.find(w => w.day === day && w.session === session)

  const [draft, setDraft] = useState<DraftExercise[]>(() => overlayLive(buildDraft(prescription, unit), live))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  // Mirror the latest draft into a ref so edit handlers can persist the
  // freshly-computed next state without awaiting a re-render.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const liveRef = useRef(live)
  liveRef.current = live

  /** Set blocks with a write in flight — the block is momentarily behind what
   *  the user just did, and the live overlay must not "correct" it back.
   *
   *  This is the one job the removed per-set `dirty` flag was doing that
   *  moving keystrokes into the input did NOT replace. It lives here rather
   *  than in the draft because it is not a property of the set — it is a
   *  property of this client's outstanding I/O — and because a pure overlay
   *  cannot tell an in-flight write from a failed one.
   *
   *  COUNTED, not a plain set: one block routinely has two writes in flight
   *  at once — typing reps and then tapping the checkbox blurs the input
   *  first, so the reps write and the done write overlap. With a set, the
   *  first to finish un-exempts the block while the second is still going. */
  const inFlightRef = useRef(new Map<string, number>())
  const beginWrite = (blockId: string) =>
    inFlightRef.current.set(blockId, (inFlightRef.current.get(blockId) ?? 0) + 1)
  const endWrite = (blockId: string) => {
    const left = (inFlightRef.current.get(blockId) ?? 1) - 1
    if (left > 0) inFlightRef.current.set(blockId, left)
    else inFlightRef.current.delete(blockId)
  }
  /** The ids currently exempt — `Map` keys read as the `ReadonlySet` the
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
    createExercise: (workoutId, ex, occurrence) =>
      materializeExercise(repo, workoutId, toExerciseDraft(ex), occurrence),
  }

  // Reseed the editing state only when the underlying identity changes — a
  // session/day switch, a config refine, or the live block structure changing
  // (materialization, another device). Value edits keep the same ids, so they
  // don't trigger a reseed and never clobber in-progress typing.
  const seededKeyRef = useRef<string | null>(null)
  const seededSlotRef = useRef<string>(slot)
  const seededShapeRef = useRef<string>(shape)
  useEffect(() => {
    // The key covers everything the draft is BUILT from — not just which
    // exercises, but the numbers pre-filled into their sets. A plan edit (or
    // another device finishing a session) changes the prescribed weight or
    // rep range for the same lifts, and the draft has to follow. Logging sets
    // in THIS session doesn't move these: history only counts finished
    // workouts, so an in-progress session can't reseed itself mid-edit.
    const key = `${slot}|${unit}|${liveIdentity(live)}|${shape}`
    if (key === seededKeyRef.current) return
    const previousSlot = seededSlotRef.current
    const previousShape = seededShapeRef.current
    seededKeyRef.current = key
    seededSlotRef.current = slot
    seededShapeRef.current = shape

    // The live query catching up with the workout WE just created carries no
    // news — we stamped those ids ourselves. Rebuilding the draft from the
    // blocks here would throw away a number being typed right now, or a tick
    // whose write hasn't landed yet (which Finish would then prune).
    //
    // Only when the slot AND the shape held still, though. That is what makes
    // it "the same draft, one query behind". An `or`-group switched mid-
    // session changes the shape, and skipping there left the view rendering
    // the option you just moved OFF — the switch looked like it did nothing,
    // and every set logged after it went to the wrong lift.
    const ourWorkoutArrived = slot === previousSlot
      && shape === previousShape
      && live !== undefined
      && live.id === coordinator.materialized()?.workoutId
      && draftRef.current.some(ex => ex.blockId !== undefined)
    coordinator.reset(live?.id ?? null, slot, shape)
    if (ourWorkoutArrived) return

    setDraft(overlayLive(buildDraft(prescription, unit), live))
    // Keep a confirmation the user hasn't seen. Finishing makes the workout
    // leave `liveWorkouts`, which reseeds — clearing "Logged Session A" the
    // instant it appeared and leaving a screen that looks like nothing
    // happened, which invites a second workout for tonight.
    if (slot !== previousSlot) setStatus(null)
  }, [slot, session, unit, live, prescription, shape, coordinator])

  // Values from the blocks, on every emission — another device's tick, the
  // outline's checkbox, or the values of a workout this view adopted rather
  // than created. Unconditional, and safe to be: the draft holds no
  // uncommitted state, because a number being typed lives in the input's own
  // state until blur. Structure stays the reseed effect's job.
  useEffect(() => {
    setDraft(cur => overlayLiveValues(cur, live, writingNow()))
  }, [live])

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
    const {blockId, patch} = await coordinator.resolveSet(next, exIdx, setIdx, effects)
    if (patch) setDraft(cur => applyIdPatch(cur, patch))
    if (blockId) {
      beginWrite(blockId)
      try {
        // The CHANGE, not the whole set: the rest of this row may be older
        // than the block (the live query hadn't resolved when the draft was
        // built), and writing it back is how logged reps got replaced by the
        // prescription's.
        await writeSet(repo, blockId, change, next[exIdx].unit)
        // No overlay on success, deliberately. The block now agrees with what
        // is on screen, and the write's OWN query emission re-runs the overlay
        // a moment later with the news. Re-running it here instead reverted
        // every tap: a `setDraft` updater is evaluated at the top of the next
        // render, so it reads the `live` from BEFORE this write — the version
        // that still says `open` — and un-ticks the box the user just ticked
        // until the emission lands.
        endWrite(blockId)
      } catch (error) {
        // A failure is the case that genuinely needs it: nothing changed, so
        // no emission is coming, and the draft would keep showing a value that
        // never reached the block.
        endWrite(blockId)
        setDraft(cur => overlayLiveValues(cur, liveRef.current, writingNow()))
        throw error
      }
    }
    return patch
  }

  /** A write failing must not be silent: the checkbox stays ticked on screen
   *  and the user would have no idea their session is going nowhere. */
  const reportWriteFailure = (error: unknown) => {
    console.error('[strength] write failed', error)
    setStatus('Could not save that — check the connection and tap it again.')
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
    const next = draftRef.current.map((ex, i) =>
      i !== exIdx ? ex : {...ex, sets: ex.sets.map(s => (s.done ? s : {...s, done: true, completedAt: now}))},
    )
    setDraft(next)
    // Persist every set of this exercise; materialize on the first if needed.
    //
    // `rows` is REASSIGNED as ids come back, exactly like the Finish loop:
    // handing the same block-less snapshot to every iteration made the later
    // sets look like an exercise that needed creating, so a reseed landing
    // mid-loop (the create's own query update does that) grew a duplicate
    // entry and scattered the sets across the two.
    void (async () => {
      let rows: readonly DraftExercise[] = next
      for (let j = 0; j < rows[exIdx].sets.length; j += 1) {
        const patch = await persist(rows, exIdx, j, {done: true, completedAt: now})
        if (patch) rows = applyIdPatch(rows, patch)
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
            await writeSet(repo, blockId, {done, completedAt}, flushed[i].unit)
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
      const lifts = flushed.filter(ex => ex.sets.some(s => s.done)).length
      setStatus(`Logged ${SESSION_LABELS[session]} — ${lifts} lifts`)

      const fullBefore = history.filter(w => w.session !== 'mini').length
      const isFull = session !== 'mini'
      const due = isFull && ((fullBefore + 1) % SHOULDER_CHECK_EVERY === 0 || detectLeftRightAsymmetry(history))
      if (due) {
        const result = await openDialog(ShoulderChecklistDialog, {history})
        if (result && result.checkedPrompts.length > 0) {
          await writeShoulderTodo(repo, workspaceId, pageId, result.checkedPrompts, SHOULDER_POLICY_BLOCK_ID)
          setStatus('Shoulder trigger logged → consult todo created')
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
            key={`${exIdx}:${ex.altGroupKey ?? ex.defId ?? ex.exercise}`}
            ex={ex}
            unit={unit}
            locked={readOnly || busy || !configLoaded}
            onCommit={(setIdx, patch) => commitSet(exIdx, setIdx, patch)}
            onToggleDone={(setIdx, done) => toggleDone(exIdx, setIdx, done)}
            onAcceptAll={() => acceptAll(exIdx)}
            onSwitch={
              ex.altGroupKey && !readOnly
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
