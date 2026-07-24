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
  materializeWorkout,
  writeLayoff,
  writeSet,
  writeShoulderTodo,
} from '../km/store'
import {ShoulderChecklistDialog} from './ShoulderChecklistDialog'
import type {ProgramState} from './useProgram'
import {
  buildDraft,
  draftBlockIds,
  finishPlan,
  hasAcceptedSets,
  liveIdentity,
  overlayLive,
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
  const [workoutId, setWorkoutId] = useState<string | null>(live?.id ?? null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  // Mirror the latest draft/workout id into refs so edit handlers can read
  // and persist the freshly-computed next state without awaiting a re-render.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const workoutIdRef = useRef(workoutId)
  workoutIdRef.current = workoutId
  const materializingRef = useRef(false)

  // Reseed the editing state only when the underlying identity changes — a
  // session/day switch, a config refine, or the live block structure changing
  // (materialization, another device). Value edits keep the same ids, so they
  // don't trigger a reseed and never clobber in-progress typing.
  const seededKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const key = `${session}|${unit}|${liveIdentity(live)}|${prescription.exercises.map(e => e.exercise).join(',')}`
    if (key === seededKeyRef.current) return
    seededKeyRef.current = key
    setDraft(overlayLive(buildDraft(prescription, unit), live))
    setWorkoutId(live?.id ?? null)
    setStatus(null)
  }, [session, unit, live, prescription])

  const applyPatch = (
    prev: DraftExercise[],
    exIdx: number,
    setIdx: number,
    patch: Partial<DraftSet>,
  ): DraftExercise[] =>
    prev.map((ex, i) =>
      i !== exIdx ? ex : {...ex, sets: ex.sets.map((s, j) => (j !== setIdx ? s : {...s, ...patch}))},
    )

  /** Ensure the workout is materialized, then persist a single set (or, on
   *  first edit, the whole draft). Reads from `next` so it never races state. */
  const persist = async (next: DraftExercise[], exIdx: number, setIdx: number) => {
    if (readOnly) return
    if (workoutIdRef.current) {
      const set = next[exIdx].sets[setIdx]
      if (set.blockId) await writeSet(repo, set.blockId, toDraftSet(set), next[exIdx].unit)
      return
    }
    if (materializingRef.current) return
    materializingRef.current = true
    try {
      const mat = await materializeWorkout(repo, workspaceId, pageId, toMaterializeDraft(day, session, next))
      // Thread the created block ids back into the local draft so later edits
      // write straight to their blocks.
      setDraft(cur =>
        cur.map((ex, i) => ({
          ...ex,
          blockId: mat.exercises[i]?.id,
          sets: ex.sets.map((s, j) => ({...s, blockId: mat.exercises[i]?.setIds[j]})),
        })),
      )
      workoutIdRef.current = mat.workoutId
      setWorkoutId(mat.workoutId)
    } finally {
      materializingRef.current = false
    }
  }

  const editSet = (exIdx: number, setIdx: number, patch: Partial<DraftSet>) =>
    setDraft(prev => applyPatch(prev, exIdx, setIdx, patch))

  const commitSet = (exIdx: number, setIdx: number, patch: Partial<DraftSet>) => {
    const next = applyPatch(draftRef.current, exIdx, setIdx, patch)
    setDraft(next)
    void persist(next, exIdx, setIdx)
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
    void (async () => {
      for (let j = 0; j < next[exIdx].sets.length; j++) await persist(next, exIdx, j)
    })()
  }

  const finish = async () => {
    if (readOnly || busy || !hasAcceptedSets(draft)) return
    setBusy(true)
    try {
      // Make sure the workout exists and every set block matches local state
      // before pruning — the finish checkpoint reconciles any un-flushed edit.
      let wid = workoutIdRef.current
      if (!wid) {
        const mat = await materializeWorkout(repo, workspaceId, pageId, toMaterializeDraft(day, session, draftRef.current))
        wid = mat.workoutId
        setDraft(cur =>
          cur.map((ex, i) => ({
            ...ex,
            blockId: mat.exercises[i]?.id,
            sets: ex.sets.map((s, j) => ({...s, blockId: mat.exercises[i]?.setIds[j]})),
          })),
        )
        workoutIdRef.current = wid
        setWorkoutId(wid)
      } else {
        for (const ex of draftRef.current) {
          for (const s of ex.sets) if (s.blockId) await writeSet(repo, s.blockId, toDraftSet(s), ex.unit)
        }
      }

      const pending = detectPendingLayoff(history, day, config)
      if (pending && !layoffAlreadyRecorded(pending, layoffs)) {
        await writeLayoff(repo, workspaceId, pageId, layoffFromPending(pending))
      }
      await finishWorkout(repo, finishPlan(wid, draftRef.current))
      const lifts = draftRef.current.filter(ex => ex.sets.some(s => s.done)).length
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
    const wid = workoutIdRef.current
    if (!wid || busy) return
    setBusy(true)
    try {
      await discardWorkout(repo, draftBlockIds(wid, draftRef.current))
      workoutIdRef.current = null
      setWorkoutId(null)
      setDraft(buildDraft(prescription, unit))
      setStatus('Discarded')
    } finally {
      setBusy(false)
    }
  }

  const canFinish = !readOnly && !busy && hasAcceptedSets(draft)
  const started = workoutId !== null

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
            readOnly={readOnly}
            onEdit={(setIdx, patch) => editSet(exIdx, setIdx, patch)}
            onCommit={(setIdx, patch) => commitSet(exIdx, setIdx, patch)}
            onToggleDone={(setIdx, done) => toggleDone(exIdx, setIdx, done)}
            onAcceptAll={() => acceptAll(exIdx)}
            onSwitch={
              ex.altGroupKey && !readOnly
                ? name => program.setAltChoice(ex.altGroupKey as string, name)
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

const toDraftSet = (s: DraftSet) => ({
  weight: s.weight,
  reps: s.reps,
  done: s.done,
  ...(s.rpe !== undefined ? {rpe: s.rpe} : {}),
  ...(s.side !== undefined ? {side: s.side} : {}),
  ...(s.completedAt !== undefined ? {completedAt: s.completedAt} : {}),
})

function ExerciseCard({
  ex,
  unit,
  readOnly,
  onEdit,
  onCommit,
  onToggleDone,
  onAcceptAll,
  onSwitch,
}: {
  ex: DraftExercise
  unit: string
  readOnly: boolean
  onEdit: (setIdx: number, patch: Partial<DraftSet>) => void
  onCommit: (setIdx: number, patch: Partial<DraftSet>) => void
  onToggleDone: (setIdx: number, done: boolean) => void
  onAcceptAll: () => void
  onSwitch?: (optionKey: string) => void
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
        {!readOnly && (
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
                onClick={() => !current && onSwitch(altOptionKey(option))}
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
            readOnly={readOnly}
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
  readOnly,
  onEdit,
  onCommit,
  onToggleDone,
}: {
  set: DraftSet
  unit: string
  readOnly: boolean
  onEdit: (patch: Partial<DraftSet>) => void
  onCommit: (patch: Partial<DraftSet>) => void
  onToggleDone: (done: boolean) => void
}) {
  const numberField = (value: number, key: 'weight' | 'reps', label: string) => (
    <input
      type="number"
      inputMode="numeric"
      aria-label={label}
      disabled={readOnly}
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
          disabled={readOnly}
          checked={set.done}
          onChange={e => onToggleDone(e.currentTarget.checked)}
          className="h-6 w-6 rounded border-border accent-primary"
        />
      </label>
    </div>
  )
}
