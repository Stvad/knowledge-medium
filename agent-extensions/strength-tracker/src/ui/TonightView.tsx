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
  materializeWorkout,
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
  finishPlan,
  hasAcceptedSets,
  liveIdentity,
  overlayLive,
  toExerciseDraft,
  toSetDraft,
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
  const {prescription, session, setSession, config, history, layoffs, liveWorkouts, day} = program
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
    createWorkout: rows => materializeWorkout(repo, workspaceId, pageId, toMaterializeDraft(day, session, rows)),
    createExercise: (workoutId, ex) => materializeExercise(repo, workoutId, toExerciseDraft(ex)),
  }

  // Reseed the editing state only when the underlying identity changes — a
  // session/day switch, a config refine, or the live block structure changing
  // (materialization, another device). Value edits keep the same ids, so they
  // don't trigger a reseed and never clobber in-progress typing.
  const seededKeyRef = useRef<string | null>(null)
  const seededSlotRef = useRef<string>(slot)
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
    seededKeyRef.current = key
    seededSlotRef.current = slot

    // The live query catching up with the workout WE just created carries no
    // news — we stamped those ids ourselves. Rebuilding the draft from the
    // blocks here would throw away a number being typed right now, or a tick
    // whose write hasn't landed yet (which Finish would then prune).
    const ourWorkoutArrived = live !== undefined
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
  ): Promise<IdPatch | undefined> => {
    if (readOnly) return undefined
    const {blockId, patch} = await coordinator.resolveSet(next, exIdx, setIdx, effects)
    if (patch) setDraft(cur => applyIdPatch(cur, patch))
    if (blockId) {
      await writeSet(repo, blockId, toSetDraft(next[exIdx].sets[setIdx]), next[exIdx].unit)
    }
    return patch
  }

  /** A write failing must not be silent: the checkbox stays ticked on screen
   *  and the user would have no idea their session is going nowhere. */
  const reportWriteFailure = (error: unknown) => {
    console.error('[strength] write failed', error)
    setStatus('Could not save that — check the connection and tap it again.')
  }

  const editSet = (exIdx: number, setIdx: number, patch: Partial<DraftSet>) =>
    setDraft(prev => applyPatch(prev, exIdx, setIdx, patch))

  const commitSet = (exIdx: number, setIdx: number, patch: Partial<DraftSet>) => {
    const next = applyPatch(draftRef.current, exIdx, setIdx, patch)
    setDraft(next)
    void persist(next, exIdx, setIdx).catch(reportWriteFailure)
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
        const patch = await persist(rows, exIdx, j)
        if (patch) rows = applyIdPatch(rows, patch)
      }
    })().catch(reportWriteFailure)
  }

  const finish = async () => {
    if (readOnly || busy || !canFinish) return
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
          const {blockId, patch} = await coordinator.resolveSet(flushed, i, j, effects)
          if (patch) {
            flushed = applyIdPatch(flushed, patch)
            setDraft(cur => applyIdPatch(cur, patch))
          }
          if (blockId) await writeSet(repo, blockId, toSetDraft(flushed[i].sets[j]), flushed[i].unit)
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
      await finishWorkout(repo, finishPlan(wid, flushed, live))
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
  const canFinish = !readOnly && !busy
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
            key={ex.altGroupKey ?? ex.exercise}
            ex={ex}
            unit={unit}
            locked={readOnly || busy}
            onEdit={(setIdx, patch) => editSet(exIdx, setIdx, patch)}
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
          {status ?? (started ? 'Saved as you go' : '')}
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
            onClick={() => void finish()}
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
  onEdit,
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
  onEdit: (setIdx: number, patch: Partial<DraftSet>) => void
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
            onEdit={patch => onEdit(i, patch)}
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

function SetRow({
  set,
  unit,
  locked,
  onEdit,
  onCommit,
  onToggleDone,
}: {
  set: DraftSet
  unit: string
  locked: boolean
  onEdit: (patch: Partial<DraftSet>) => void
  onCommit: (patch: Partial<DraftSet>) => void
  onToggleDone: (done: boolean) => void
}) {
  const numberField = (value: number, key: 'weight' | 'reps', label: string) => (
    <input
      type="number"
      inputMode="numeric"
      aria-label={label}
      disabled={locked}
      value={Number.isFinite(value) ? value : ''}
      // Select on focus so a tap-and-type replaces the pre-filled number.
      onFocus={e => e.currentTarget.select()}
      onChange={e => onEdit({[key]: e.currentTarget.value === '' ? 0 : Number(e.currentTarget.value)})}
      // Persist the settled value on blur (cheap, and the block is the record).
      onBlur={e => onCommit({[key]: e.currentTarget.value === '' ? 0 : Number(e.currentTarget.value)})}
      className="h-9 w-16 rounded border border-border bg-background px-2 text-right text-sm tabular-nums"
    />
  )

  return (
    <div className={'flex items-center gap-2 rounded px-1 py-1 ' + (set.done ? 'bg-primary/10' : '')}>
      {set.side && (
        <span className="w-4 shrink-0 text-center text-xs font-medium text-muted-foreground">{set.side}</span>
      )}
      {numberField(set.weight, 'weight', 'weight')}
      <span className="shrink-0 text-xs text-muted-foreground">{unit} ×</span>
      {numberField(set.reps, 'reps', 'reps')}
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
