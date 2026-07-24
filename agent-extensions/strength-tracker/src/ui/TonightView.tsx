/** Tonight's prescription + fast logging.
 *
 *  Mobile-first, dark-mode-friendly, meant to be usable half-tired at 1am:
 *  every set is pre-filled from the prescription, so accepting one as-
 *  prescribed is a single tap on its checkbox; a deviation is editing the
 *  number first. "Finish" writes the accepted sets — and, if a gap was
 *  detected, records the layoff — as one transaction, then runs the
 *  shoulder self-check occasionally.
 */

import {useEffect, useState} from 'react'

import type {Repo} from '@/data/repo.js'
import {openDialog} from '@/utils/dialogs.js'

import {detectPendingLayoff, layoffAlreadyRecorded, layoffFromPending} from '../engine/reentry'
import {detectLeftRightAsymmetry} from '../engine/shoulder'
import type {SessionType} from '../engine/types'
import {SHOULDER_POLICY_BLOCK_ID} from '../km/config'
import {writeLayoff, writeShoulderTodo, writeWorkout} from '../km/store'
import {ShoulderChecklistDialog} from './ShoulderChecklistDialog'
import type {ProgramState} from './useProgram'
import {
  buildDraft,
  hasAcceptedSets,
  toWorkoutDraft,
  type DraftExercise,
  type DraftSet,
} from './draft'

const SESSION_LABELS: Record<SessionType, string> = {A: 'A · upper', B: 'B · lower', mini: 'mini'}

/** After how many full sessions to run the shoulder check when nothing in
 *  the logs flags it. */
const SHOULDER_CHECK_EVERY = 4

interface Props {
  repo: Repo
  workspaceId: string
  pageId: string
  program: ProgramState
}

export function TonightView({repo, workspaceId, pageId, program}: Props) {
  const {prescription, session, setSession, config, history, layoffs, day} = program
  const readOnly = repo.isReadOnly
  const [draft, setDraft] = useState<DraftExercise[]>(() => buildDraft(prescription, config.unit))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  // Rebuild whenever the prescription identity changes — a session toggle,
  // a config refine, or (post-log) the new history. That last case doubles
  // as the reset after a successful save.
  useEffect(() => {
    setDraft(buildDraft(prescription, config.unit))
    setStatus(null)
  }, [prescription, config.unit])

  const updateSet = (exIdx: number, setIdx: number, patch: Partial<DraftSet>) =>
    setDraft(prev =>
      prev.map((ex, i) =>
        i !== exIdx ? ex : {...ex, sets: ex.sets.map((s, j) => (j !== setIdx ? s : {...s, ...patch}))},
      ),
    )

  const acceptAll = (exIdx: number) =>
    setDraft(prev => prev.map((ex, i) => (i !== exIdx ? ex : {...ex, sets: ex.sets.map(s => ({...s, done: true}))})))

  const finish = async () => {
    const workout = toWorkoutDraft(day, session, draft)
    if (workout.exercises.length === 0 || readOnly) return
    setBusy(true)
    try {
      const pending = detectPendingLayoff(history, day, config)
      if (pending && !layoffAlreadyRecorded(pending, layoffs)) {
        await writeLayoff(repo, workspaceId, pageId, layoffFromPending(pending))
      }
      await writeWorkout(repo, workspaceId, pageId, workout)
      setStatus(`Logged ${SESSION_LABELS[session]} — ${workout.exercises.length} lifts`)

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

  const canFinish = !readOnly && !busy && hasAcceptedSets(draft)

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-lg font-semibold">Tonight · {day}</div>
          {prescription.offSchedule && (
            <div className="text-xs text-muted-foreground">off the weekly template — inferred session</div>
          )}
        </div>
        <div className="flex gap-1" role="group" aria-label="Session">
          {(['A', 'B', 'mini'] as const).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setSession(s)}
              className={
                'rounded px-3 py-1.5 text-sm ' +
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
            key={ex.exercise}
            ex={ex}
            unit={config.unit}
            readOnly={readOnly}
            onSet={(setIdx, patch) => updateSet(exIdx, setIdx, patch)}
            onAcceptAll={() => acceptAll(exIdx)}
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
        <span className="text-sm text-muted-foreground">{status}</span>
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
  )
}
TonightView.displayName = 'TonightView'

function ExerciseCard({
  ex,
  unit,
  readOnly,
  onSet,
  onAcceptAll,
}: {
  ex: DraftExercise
  unit: string
  readOnly: boolean
  onSet: (setIdx: number, patch: Partial<DraftSet>) => void
  onAcceptAll: () => void
}) {
  const range = ex.repMin !== undefined && ex.repMax !== undefined
    ? `${ex.repMin}–${ex.repMax}`
    : ex.repMax !== undefined
      ? `${ex.repMax}`
      : ''
  const target = `${ex.sets.length}${ex.perSide ? '' : ''} × ${range || '—'}${ex.prescribedWeight ? ` @ ${ex.prescribedWeight}${unit}` : ''}`

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
      {ex.note && <div className="mt-1 text-xs text-muted-foreground/70">{ex.note}</div>}
      <div className="mt-2 flex flex-col gap-1.5">
        {ex.sets.map((s, i) => (
          <SetRow key={i} set={s} unit={unit} readOnly={readOnly} onChange={patch => onSet(i, patch)} />
        ))}
      </div>
    </li>
  )
}

function SetRow({
  set,
  unit,
  readOnly,
  onChange,
}: {
  set: DraftSet
  unit: string
  readOnly: boolean
  onChange: (patch: Partial<DraftSet>) => void
}) {
  const numberField = (
    value: number,
    onValue: (n: number) => void,
    label: string,
  ) => (
    <input
      type="number"
      inputMode="numeric"
      aria-label={label}
      disabled={readOnly}
      value={Number.isFinite(value) ? value : ''}
      onChange={e => onValue(e.currentTarget.value === '' ? 0 : Number(e.currentTarget.value))}
      className="w-16 rounded border border-border bg-background px-2 py-1 text-right text-sm tabular-nums"
    />
  )

  return (
    <div
      className={
        'flex items-center gap-2 rounded px-1 py-0.5 ' + (set.done ? 'bg-primary/10' : '')
      }
    >
      {set.side && (
        <span className="w-4 text-center text-xs font-medium text-muted-foreground">{set.side}</span>
      )}
      {numberField(set.weight, n => onChange({weight: n}), 'weight')}
      <span className="text-xs text-muted-foreground">{unit} ×</span>
      {numberField(set.reps, n => onChange({reps: n}), 'reps')}
      <label className="ml-auto flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
        <span>done</span>
        <input
          type="checkbox"
          disabled={readOnly}
          checked={set.done}
          onChange={e => onChange({done: e.currentTarget.checked})}
          className="h-5 w-5 rounded border-border accent-primary"
        />
      </label>
    </div>
  )
}
