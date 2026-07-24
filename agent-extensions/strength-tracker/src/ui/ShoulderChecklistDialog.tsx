/** The shoulder re-open self-check.
 *
 *  Surfaced occasionally after logging. Any checked trigger resolves to the
 *  list of checked trigger ids; the caller turns a non-empty result into a
 *  todo referencing the shoulder policy block. Dismissing resolves to `null`.
 */

import {useState} from 'react'

import type {DialogContextProps} from '@/utils/dialogs.js'

import {shoulderChecklist} from '../engine/shoulder'
import type {WorkoutRecord} from '../engine/types'

export interface ShoulderChecklistResult {
  checkedIds: string[]
  checkedPrompts: string[]
}

export interface ShoulderChecklistProps {
  history: readonly WorkoutRecord[]
}

export const ShoulderChecklistDialog = ({
  history,
  resolve,
  cancel,
}: DialogContextProps<ShoulderChecklistResult> & ShoulderChecklistProps) => {
  const triggers = shoulderChecklist(history)
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(triggers.map(t => [t.id, !!t.autoFlag])),
  )

  const toggle = (id: string) => setChecked(prev => ({...prev, [id]: !prev[id]}))

  const submit = () => {
    const hit = triggers.filter(t => checked[t.id])
    resolve({checkedIds: hit.map(t => t.id), checkedPrompts: hit.map(t => t.prompt)})
  }

  return (
    <div className="flex max-w-md flex-col gap-3 p-4">
      <div>
        <h2 className="text-base font-semibold">Shoulder check</h2>
        <p className="text-sm text-muted-foreground">
          Any of these → book the consult, no re-litigating.
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {triggers.map(t => (
          <li key={t.id}>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-primary"
                checked={!!checked[t.id]}
                onChange={() => toggle(t.id)}
              />
              <span className={t.autoFlag ? 'font-medium text-foreground' : ''}>
                {t.prompt}
                {t.autoFlag && (
                  <span className="ml-1 rounded bg-amber-500/15 px-1 text-xs text-amber-600 dark:text-amber-400">
                    logs suggest this
                  </span>
                )}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          className="rounded border border-border px-3 py-1 text-sm hover:bg-muted"
          onClick={() => cancel()}
        >
          All clear
        </button>
        <button
          type="button"
          className="rounded bg-primary px-3 py-1 text-sm font-medium text-primary-foreground hover:opacity-90"
          onClick={submit}
        >
          Book consult
        </button>
      </div>
    </div>
  )
}
ShoulderChecklistDialog.displayName = 'ShoulderChecklistDialog'
