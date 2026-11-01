/** Under an experiment block's children: its status, the schedule's
 *  progress and tonight's arm, adherence so far — the same numbers
 *  `LabPageContent`'s `ExperimentCard` shows on the dashboard, via the
 *  shared `summarizeExperiment` helper — and, for a block typed by hand and
 *  not yet stamped, the one button that turns it into a running experiment.
 *
 *  Rendered by `blockChildrenFooterFacet`, so it sits after the periods
 *  (once stamped) rather than inside the experiment's own line — same
 *  placement as the Strength Tracker's `WorkoutFooter`.
 *
 *  Exports only the raw component — `./index` gates it on `EXPERIMENT_TYPE`
 *  — mirroring `NightLine`/`DoseLine`'s split so this stays renderable in a
 *  unit test without a `@/extensions/blockInteraction.js` runtime.
 */
import {useState} from 'react'

import type {Block} from '@/data/block.js'
import {useWorkspaceId} from '@/hooks/block.js'

import {tonightWakeDate} from '../../km/day'
import {stampSchedule, type StampScheduleOutcome} from '../../km/experiment'
import {summarizeExperiment} from '../experimentSummary'
import {useLabRows} from '../labRows'

const outcomeMessage = (outcome: StampScheduleOutcome): string | null => {
  switch (outcome.status) {
    case 'stamped': return null
    case 'already': return 'This experiment already has its schedule.'
    case 'unreadable': return outcome.reason
  }
}

export const ExperimentFooter = ({block}: {block: Block}) => {
  const workspaceId = useWorkspaceId(block)
  const {nights, experiments} = useLabRows(workspaceId)
  const experiment = experiments.find(e => e.id === block.id)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  // Not our row yet (still loading, or the block lost its type since the
  // facet gated on it) — nothing to summarize and nothing to stamp.
  if (!experiment) return null

  const {progress, tonightArm, adherence} = summarizeExperiment(experiment, nights, tonightWakeDate())
  const hasSchedule = experiment.periods.length > 0

  const stamp = () => {
    setBusy(true)
    setProblem(null)
    stampSchedule(block.repo, block.id)
      .then(outcome => setProblem(outcomeMessage(outcome)))
      .catch((error: unknown) => {
        console.error('[sleep-lab] could not stamp the schedule', error)
        setProblem('Could not stamp the schedule — try again.')
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground" data-block-interaction="ignore">
      <span className="rounded border border-border px-1.5 py-0.5 font-medium text-foreground">{experiment.status}</span>
      <span>{progress ? `Night ${progress.night} of ${progress.total}` : 'Not in the schedule window'}</span>
      <span>Tonight: {tonightArm ?? '—'}</span>
      <span>Adherence: {adherence ? `${adherence.taken}/${adherence.of}` : '—'}</span>
      {!hasSchedule && !block.repo.isReadOnly ? (
        <button
          type="button"
          disabled={busy}
          data-block-interaction="ignore"
          className="rounded border border-border px-2 py-1 font-medium text-foreground hover:bg-accent disabled:opacity-50"
          onClick={event => {
            event.stopPropagation()
            stamp()
          }}
        >{busy ? 'Stamping…' : 'Stamp schedule'}</button>
      ) : null}
      {problem ? <span className="text-destructive">{problem}</span> : null}
    </div>
  )
}
