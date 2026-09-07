/** The Sleep Lab dashboard's actual content: start/import/tonight controls,
 *  the running experiment's progress and adherence, the pre-registered
 *  comparison table, and a log of recent nights.
 *
 *  Split from `LabPageRenderer` so this can be unit-tested without
 *  `DefaultBlockRenderer` — that module (and the app chrome it pulls in) has
 *  no runtime under the unit tier's kernel-type stubs (declarations only),
 *  the same reason the Strength Tracker's own page renderer has no
 *  rendering test. `LabPageRenderer` composes this with that chrome for the
 *  real app; tests render `LabPageContent` directly.
 */
import {useState} from 'react'

import {useWorkspaceId} from '@/hooks/block.js'
import {openDialog} from '@/utils/dialogs.js'
import {useBlockOpener} from '@/utils/navigation.js'
import type {BlockRendererProps} from '@/types.js'

import {compareAll, OUTCOME_LABELS, PRIMARY_OUTCOMES} from '../engine/stats'
import type {Comparison, ExperimentRecord, NightRecord, Outcome, Population} from '../engine/types'
import {lastNightWakeDate, tonightWakeDate} from '../km/day'
import {createExperiment, runningExperiment, stampNight} from '../km/experiment'
import {summarizeExperiment} from './experimentSummary'
import {ImportDialog} from './ImportDialog'
import {useLabRows} from './labRows'
import {Segmented} from './Segmented'
import {showBlock} from './showBlock'
import {StartExperimentDialog} from './StartExperimentDialog'

const formatValue = (outcome: Outcome, value: number | undefined): string => {
  if (value === undefined) return '—'
  if (outcome === 'efficiency') return `${(value * 100).toFixed(1)}%`
  return value.toFixed(2)
}

const experimentLabel = (experiment: ExperimentRecord): string => `${experiment.intervention} · ${experiment.startDate}`

const ExperimentCard = ({experiment, nights, tonight}: {
  experiment: ExperimentRecord
  nights: readonly NightRecord[]
  /** Wake date of the sleep ahead — what the schedule is asked about. */
  tonight: string
}) => {
  const {progress, tonightArm, adherence, withSession} = summarizeExperiment(experiment, nights, tonight)

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{experiment.intervention}</span>
        <span className="text-xs text-muted-foreground">
          {experiment.control === 'placebo' ? 'placebo control' : 'open-label'}
        </span>
      </div>
      <div className="text-xs text-muted-foreground">{experiment.doseText}</div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span>{progress ? `Night ${progress.night} of ${progress.total}` : 'Not in the schedule window'}</span>
        <span>Tonight: {tonightArm ?? '—'}</span>
        <span>Adherence: {adherence ? `${adherence.taken}/${adherence.of}` : '—'}</span>
        <span>{withSession} night{withSession === 1 ? '' : 's'} with a session</span>
      </div>
    </div>
  )
}

const POPULATION_OPTIONS: readonly {value: Population; label: string}[] = [
  {value: 'assigned', label: 'By assignment'},
  {value: 'per-protocol', label: 'Per protocol'},
]

/** A night with 2+ logged drinks is dropped by this cap; a night with none
 *  logged is never touched by it (see `EligibilityOptions.maxAlcohol`). */
const ALCOHOL_SENSITIVITY_CAP = 1

const AnalysisTable = ({nights}: {nights: readonly NightRecord[]}) => {
  const [population, setPopulation] = useState<Population>('assigned')
  const [excludeTransition, setExcludeTransition] = useState(false)
  const [excludeAlcohol, setExcludeAlcohol] = useState(false)

  if (nights.length === 0) return <p className="text-sm text-muted-foreground">No nights logged yet.</p>

  const rows = compareAll(nights, population, {
    excludeTransition,
    ...(excludeAlcohol ? {maxAlcohol: ALCOHOL_SENSITIVITY_CAP} : {}),
  }).filter(c => c.nIntervention >= 1 || c.nControl >= 1)
  const byOutcome = new Map(rows.map(c => [c.outcome, c] as const))
  const primary = PRIMARY_OUTCOMES
    .map(outcome => byOutcome.get(outcome))
    .filter((c): c is Comparison => c !== undefined)
  const secondary = rows.filter(c => !PRIMARY_OUTCOMES.includes(c.outcome))
  const ordered = [...primary, ...secondary]

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <Segmented options={POPULATION_OPTIONS} value={population} onChange={setPopulation}/>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox" checked={excludeTransition}
            onChange={event => setExcludeTransition(event.currentTarget.checked)}
          />
          Sensitivity: exclude transition nights
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox" checked={excludeAlcohol}
            onChange={event => setExcludeAlcohol(event.currentTarget.checked)}
          />
          Sensitivity: exclude nights with 2+ drinks
        </label>
      </div>
      {ordered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No eligible nights for either arm yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-1 pr-2">Outcome</th>
                <th className="py-1 pr-2">n (int/ctl)</th>
                <th className="py-1 pr-2">Mean int</th>
                <th className="py-1 pr-2">Mean ctl</th>
                <th className="py-1 pr-2">Diff</th>
                <th className="py-1 pr-2">95% CI</th>
                <th className="py-1 pr-2">p</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map(row => {
                const isPrimary = PRIMARY_OUTCOMES.includes(row.outcome)
                return (
                  <tr key={row.outcome} className={`border-b border-border ${isPrimary ? 'font-medium' : 'text-muted-foreground'}`}>
                    <td className="py-1 pr-2">{OUTCOME_LABELS[row.outcome]}{isPrimary ? ' *' : ''}</td>
                    <td className="py-1 pr-2 tabular-nums">{row.nIntervention}/{row.nControl}</td>
                    <td className="py-1 pr-2 tabular-nums">{formatValue(row.outcome, row.meanIntervention)}</td>
                    <td className="py-1 pr-2 tabular-nums">{formatValue(row.outcome, row.meanControl)}</td>
                    <td className="py-1 pr-2 tabular-nums">{formatValue(row.outcome, row.difference)}</td>
                    <td className="py-1 pr-2 tabular-nums">
                      {row.ci ? `[${formatValue(row.outcome, row.ci[0])}, ${formatValue(row.outcome, row.ci[1])}]` : '—'}
                    </td>
                    <td className="py-1 pr-2 tabular-nums">{row.p !== undefined ? row.p.toFixed(3) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const RecentNights = ({nights, workspaceId}: {nights: readonly NightRecord[]; workspaceId: string}) => {
  const openBlock = useBlockOpener()
  const recent = [...nights].slice(-14).reverse()

  if (recent.length === 0) return <p className="text-sm text-muted-foreground">No nights logged yet.</p>

  return (
    <ul className="flex flex-col gap-1 text-sm">
      {recent.map(night => (
        <li key={night.id}>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left hover:bg-accent"
            onClick={event => openBlock(event, {blockId: night.id, workspaceId})}
          >
            <span className="tabular-nums">{night.date}</span>
            <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              {night.arm ?? 'baseline'}
            </span>
            <span className="text-xs">{night.doseTaken === undefined ? '–' : night.doseTaken ? '✓' : '✗'}</span>
            <span className="text-xs tabular-nums">{night.ratings.quality ?? '–'}</span>
            <span className="text-xs tabular-nums">{night.main?.measures.sleepMinutes ?? '–'}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export const LabPageContent = ({block}: BlockRendererProps) => {
  const workspaceId = useWorkspaceId(block)
  const {nights, experiments} = useLabRows(workspaceId)
  const [busy, setBusy] = useState(false)
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | undefined>(undefined)
  const running = runningExperiment(experiments)
  const tonightDate = tonightWakeDate()
  // Nights read by the analysis are one experiment's: the running one by
  // default, else the newest (`experiments` is newest-first — see
  // `buildExperiments`). A stale selection (an experiment that no longer
  // exists in the query result) falls back the same way, with no effect
  // needed to reconcile it.
  const defaultExperiment = running ?? experiments[0]
  const selectedExperiment = (
    selectedExperimentId !== undefined ? experiments.find(experiment => experiment.id === selectedExperimentId) : undefined
  ) ?? defaultExperiment
  const analysisNights = selectedExperiment
    ? nights.filter(night => night.experimentId === selectedExperiment.id)
    : []

  const startExperiment = async () => {
    const spec = await openDialog(StartExperimentDialog)
    if (!spec) return
    setBusy(true)
    try {
      await createExperiment(block.repo, block.id, spec)
    } catch (error) {
      console.error('[sleep-lab] could not start the experiment', error)
    } finally {
      setBusy(false)
    }
  }

  const importData = async () => {
    await openDialog(ImportDialog, {repo: block.repo, workspaceId})
  }

  const tonight = async () => {
    setBusy(true)
    try {
      const {nightId} = await stampNight(block.repo, workspaceId, tonightDate)
      await showBlock(block.repo, workspaceId, nightId, "tonight's night is ready")
    } catch (error) {
      console.error('[sleep-lab] could not stamp tonight', error)
    } finally {
      setBusy(false)
    }
  }

  const lastNight = async () => {
    setBusy(true)
    try {
      const {nightId} = await stampNight(block.repo, workspaceId, lastNightWakeDate())
      await showBlock(block.repo, workspaceId, nightId, "last night's night is ready")
    } catch (error) {
      console.error('[sleep-lab] could not stamp last night', error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sleep-lab flex w-full max-w-3xl flex-col gap-6 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Sleep Lab</h1>
        {!block.repo.isReadOnly ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button" disabled={busy}
              className="rounded border border-border px-2.5 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              onClick={() => void startExperiment()}
            >Start an experiment</button>
            <button
              type="button" disabled={busy}
              className="rounded border border-border px-2.5 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              onClick={() => void importData()}
            >Import watch data</button>
            <button
              type="button" disabled={busy}
              className="rounded bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              onClick={() => void tonight()}
            >Tonight</button>
            <button
              type="button" disabled={busy}
              className="rounded border border-border px-2.5 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              onClick={() => void lastNight()}
            >Last night</button>
          </div>
        ) : null}
      </div>

      {running ? (
        <ExperimentCard experiment={running} nights={nights} tonight={tonightDate}/>
      ) : (
        <p className="text-sm text-muted-foreground">No experiment is running. Start one to begin the schedule.</p>
      )}

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Analysis</h2>
        {experiments.length > 1 && selectedExperiment ? (
          <div className="mb-2">
            <Segmented
              options={experiments.map(experiment => ({value: experiment.id, label: experimentLabel(experiment)}))}
              value={selectedExperiment.id}
              onChange={setSelectedExperimentId}
            />
          </div>
        ) : null}
        <AnalysisTable nights={analysisNights}/>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent nights</h2>
        <RecentNights nights={nights} workspaceId={workspaceId}/>
      </section>
    </div>
  )
}
LabPageContent.displayName = 'LabPageContent'
