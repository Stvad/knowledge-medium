/** What the next experiment is, asked before anything is written.
 *
 *  `buildSchedule` is pure, so the preview re-runs live as the fields change
 *  — there is no "commit, then see" step the way there is for the schedule
 *  itself once `createExperiment` has stamped its period blocks.
 */
import {useState} from 'react'

import type {DialogContextProps} from '@/utils/dialogs.js'

import {buildSchedule} from '../engine/schedule'
import type {Period} from '../engine/types'
import type {ExperimentSpec} from '../km/experiment'
import type {ControlKind} from '../km/fields'
import {Segmented} from './Segmented'

const randomSeed = (): number => Math.floor(Math.random() * 0xFFFFFFFF)

/** Tomorrow's date, local calendar, as `YYYY-MM-DD` — the default start:
 *  today is usually already committed to whatever tonight's dose is. */
const tomorrow = (): string => {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const CONTROL_OPTIONS: readonly {value: ControlKind; label: string}[] = [
  {value: 'nothing', label: 'Nothing (open-label)'},
  {value: 'placebo', label: 'Placebo'},
]

const previewLabel = (period: Period, intervention: string, control: ControlKind): string =>
  `Period ${period.index} · ${period.arm === 'intervention' ? intervention : (control === 'placebo' ? 'placebo' : 'control')} · ${period.from} → ${period.to}`

export const StartExperimentDialog = ({resolve, cancel}: DialogContextProps<ExperimentSpec>) => {
  const [intervention, setIntervention] = useState('glycine')
  const [doseText, setDoseText] = useState('3 g glycine in 100–200 ml water, 30–60 min before bed')
  const [control, setControl] = useState<ControlKind>('nothing')
  const [startDate, setStartDate] = useState(tomorrow)
  const [periodNights, setPeriodNights] = useState(3)
  const [pairs, setPairs] = useState(8)
  const [seed, setSeed] = useState(randomSeed)

  let preview: Period[] = []
  let error: string | null = null
  try {
    preview = buildSchedule({startDate, periodNights, pairs, seed}).slice(0, 4)
  } catch (e) {
    error = e instanceof Error ? e.message : 'Could not build a schedule from these settings.'
  }

  const canStart = intervention.trim() !== '' && doseText.trim() !== '' && error === null

  return (
    <div className="flex max-w-md flex-col gap-4 p-4">
      <h2 className="text-base font-semibold">Start an experiment</h2>

      <label className="flex flex-col gap-1 text-sm">
        Intervention
        <input
          className="rounded border border-border bg-transparent px-2 py-1"
          value={intervention}
          onChange={event => setIntervention(event.currentTarget.value)}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Dose
        <textarea
          rows={2}
          className="rounded border border-border bg-transparent px-2 py-1"
          value={doseText}
          onChange={event => setDoseText(event.currentTarget.value)}
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Control</span>
        <Segmented options={CONTROL_OPTIONS} value={control} onChange={setControl}/>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        Start date
        <input
          type="date"
          className="rounded border border-border bg-transparent px-2 py-1"
          value={startDate}
          onChange={event => setStartDate(event.currentTarget.value)}
        />
      </label>

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          Period nights
          <input
            type="number"
            min={1}
            className="rounded border border-border bg-transparent px-2 py-1"
            value={periodNights}
            onChange={event => setPeriodNights(Number(event.currentTarget.value))}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          Pairs
          <input
            type="number"
            min={1}
            className="rounded border border-border bg-transparent px-2 py-1"
            value={pairs}
            onChange={event => setPairs(Number(event.currentTarget.value))}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        Seed
        <input
          type="number"
          className="rounded border border-border bg-transparent px-2 py-1"
          value={seed}
          onChange={event => setSeed(Number(event.currentTarget.value))}
        />
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">First periods</span>
        {error ? (
          <span className="text-xs text-destructive">{error}</span>
        ) : (
          <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {preview.map(period => <li key={period.index}>{previewLabel(period, intervention, control)}</li>)}
          </ul>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => cancel()}>
          Cancel
        </button>
        <button
          type="button"
          disabled={!canStart}
          className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          onClick={() => resolve({
            intervention: intervention.trim(), doseText: doseText.trim(), control, startDate, periodNights, pairs, seed,
          })}
        >Start</button>
      </div>
    </div>
  )
}
StartExperimentDialog.displayName = 'StartExperimentDialog'
