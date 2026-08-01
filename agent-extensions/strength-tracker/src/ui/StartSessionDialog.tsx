/** What tonight is, asked before anything is written.
 *
 *  The variant and the `or`-group picks have to be settled BEFORE the stamp,
 *  not after: blocks are created for what you chose, so a switch afterwards
 *  would mean deleting the ones already made — which is exactly the
 *  prune-and-regenerate this design removed. Cancelling writes nothing at all.
 */

import {useState} from 'react'

import type {DialogContextProps} from '@/utils/dialogs.js'

import {altOptionKey, type Prescription, type SessionType} from '../engine/types'

export interface StartSessionResult {
  session: SessionType
  /** `{groupKey: optionKey}` for the groups touched here. Merged over the
   *  recorded choices, so an untouched group keeps its answer. */
  choices: Record<string, string>
}

export interface StartSessionProps {
  /** Re-prescribe for the current picks. Pure and synchronous — the plan is
   *  read once before the dialog opens — so the list on screen is always the
   *  list Start will stamp, rather than the one the defaults would have. */
  prescribeFor: (result: StartSessionResult) => Prescription
  initialSession: SessionType
  /** Anything wrong with the plan read. Shown rather than logged: the session
   *  is about to become blocks, and a plan that could not be read stamps the
   *  BUILT-IN program under your own lift names — which then keys the entries
   *  differently from every session logged when the plan was readable. You
   *  can still start; you just get to know what you are starting. */
  warnings: readonly string[]
}

const SESSIONS: readonly {value: SessionType; label: string}[] = [
  {value: 'A', label: 'A · upper-lean'},
  {value: 'B', label: 'B · lower-pull'},
  {value: 'mini', label: 'Mini day'},
]

const Segmented = <T extends string>({
  options, value, onChange,
}: {
  options: readonly {value: T; label: string}[]
  value: T
  onChange: (next: T) => void
}) => (
  <div className="flex flex-wrap gap-1">
    {options.map(option => (
      <button
        key={option.value}
        type="button"
        aria-pressed={option.value === value}
        className={option.value === value
          ? 'rounded bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-foreground'
          : 'rounded border border-border px-2.5 py-1.5 text-sm hover:bg-muted'}
        onClick={() => onChange(option.value)}
      >{option.label}</button>
    ))}
  </div>
)

export const StartSessionDialog = ({
  prescribeFor,
  initialSession,
  warnings,
  resolve,
  cancel,
}: DialogContextProps<StartSessionResult> & StartSessionProps) => {
  const [session, setSession] = useState<SessionType>(initialSession)
  const [choices, setChoices] = useState<Record<string, string>>({})

  const prescription = prescribeFor({session, choices})

  // One entry per `or`-group in tonight's list. `altGroupKey` is the group
  // block; the options are its declared children.
  const groups = prescription.exercises
    .filter(exercise => exercise.altGroupKey && (exercise.altOptions?.length ?? 0) > 1)

  return (
    <div className="flex max-w-md flex-col gap-4 p-4">
      <div>
        <h2 className="text-base font-semibold">Start a session</h2>
        <p className="text-sm text-muted-foreground">
          {prescription.offSchedule
            ? 'Nothing is scheduled today — pick what you are doing.'
            : `Scheduled for ${prescription.day}.`}
        </p>
      </div>

      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
          {warnings.map(warning => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Session</span>
        <Segmented options={SESSIONS} value={session} onChange={setSession}/>
      </div>

      {groups.map(exercise => {
        const groupKey = exercise.altGroupKey!
        const current = choices[groupKey] ?? altOptionKey({
          name: exercise.exercise,
          ...(exercise.defId !== undefined ? {defId: exercise.defId} : {}),
        })
        return (
          <div key={groupKey} className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Choose one
            </span>
            <Segmented
              options={(exercise.altOptions ?? []).map(option => ({
                value: altOptionKey(option),
                label: option.name,
              }))}
              value={current}
              onChange={next => setChoices(current => ({...current, [groupKey]: next}))}
            />
          </div>
        )
      })}

      <div>
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {prescription.exercises.length} lifts
        </span>
        <ul className="mt-1 flex flex-col gap-0.5 text-sm">
          {prescription.exercises.map((exercise, index) => (
            <li key={`${exercise.exercise}-${index}`} className="flex justify-between gap-3">
              <span>{exercise.exercise}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {exercise.sets}×{exercise.repMax ?? exercise.repMin ?? '?'}
                {exercise.weight !== undefined ? ` @ ${exercise.weight}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted"
          onClick={() => cancel()}
        >Cancel</button>
        <button
          type="button"
          className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          onClick={() => resolve({session, choices})}
        >Start</button>
      </div>
    </div>
  )
}
StartSessionDialog.displayName = 'StartSessionDialog'
