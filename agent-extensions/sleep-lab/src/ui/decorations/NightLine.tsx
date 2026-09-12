/** Below the night block's own line: the assignment badge, the morning
 *  check-in controls, the covariate toggles, and — once the watch has
 *  reported a session — a one-line summary of it.
 *
 *  Reads through `useLabRows`, the one shared query every night/dose row on
 *  screen reads from (mirrors the Strength Tracker's `useSessionRows`): a
 *  page full of nights must not each run their own join over sessions,
 *  doses and periods. Writes go through the km write path
 *  (`writeRating` / `writeCovariates`), never a raw property setter, so a
 *  night that has been deleted out from under the control reports the
 *  refusal instead of silently writing nothing — see `SetLine` for the
 *  pattern this copies.
 *
 *  Hidden entirely in a read-only workspace except the session summary,
 *  which is read-only content and stays useful without write access.
 *
 *  Exports only the raw component — `cachedContentDecorator` is called in
 *  `./index`, not here, so this module never touches
 *  `@/extensions/blockInteraction.js`. That import has no runtime under the
 *  unit tier's kernel-type stubs (declarations only), and unlike a plain
 *  value import it would run at THIS module's top level via `./index`'s old
 *  shape — keeping it out of this file is what lets a render test import
 *  `NightLine` directly.
 */
import {useState} from 'react'

import {useWorkspaceId} from '@/hooks/block.js'
import type {BlockRenderer, BlockRendererProps} from '@/types.js'

import type {ExperimentRecord, NightRating, NightRecord, SessionRecord} from '../../engine/types'
import {writeCovariates, writeRating, type CovariatePatch, type WriteOutcome} from '../../km/nights'
import {useLabRows} from '../labRows'

interface Props extends BlockRendererProps {
  Inner: BlockRenderer
}

const REFUSED: Record<WriteOutcome, string | null> = {
  written: null,
  gone: 'This night is no longer there — the change was not saved.',
}

const hm = (minutes: number): string => `${Math.floor(minutes / 60)}h${String(Math.round(minutes % 60)).padStart(2, '0')}m`

/** One line: what the watch measured for the night's main sleep. Every
 *  measure is optional on the record (an import may derive only some of
 *  them), so each is included only when present — exported for the
 *  rendering test, which asserts the exact shape of this string. */
export const summarizeMainSession = (session: SessionRecord): string => {
  const {measures} = session
  const parts: string[] = []
  if (measures.sleepMinutes !== undefined) parts.push(hm(measures.sleepMinutes))
  if (measures.onsetMinutes !== undefined) parts.push(`onset ${Math.round(measures.onsetMinutes)} min`)
  if (measures.deepMinutes !== undefined) parts.push(`deep ${Math.round(measures.deepMinutes)}`)
  if (measures.remMinutes !== undefined) parts.push(`REM ${Math.round(measures.remMinutes)}`)
  if (measures.efficiency !== undefined) parts.push(`eff ${measures.efficiency.toFixed(2)}`)
  if (measures.hrMean !== undefined) parts.push(`HR ${Math.round(measures.hrMean)}`)
  if (measures.hrv !== undefined) parts.push(`HRV ${Math.round(measures.hrv)}`)
  return parts.join(' · ')
}

const assignmentBadge = (night: NightRecord, experiments: readonly ExperimentRecord[]): string => {
  if (night.arm === undefined) return 'Baseline'
  if (night.arm === 'control') return 'Control'
  const experiment = night.experimentId ? experiments.find(e => e.id === night.experimentId) : undefined
  return experiment ? experiment.intervention : 'Intervention'
}

const RATING_SCALES: readonly {key: NightRating; label: string}[] = [
  {key: 'quality', label: 'Quality'},
  {key: 'rested', label: 'Rested'},
  {key: 'ease', label: 'Ease'},
]

const ALCOHOL_CHOICES = [0, 1, 2, 3, 4] as const
const KSS_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

const RatingControl = ({label, value, busy, onSet}: {
  label: string
  value: number | undefined
  busy: boolean
  onSet: (value: number) => void
}) => (
  <div className="flex items-center gap-1">
    <span className="w-14 shrink-0 text-xs text-muted-foreground">{label}</span>
    {[1, 2, 3, 4, 5].map(n => (
      <button
        key={n}
        type="button"
        disabled={busy}
        aria-pressed={value === n}
        aria-label={`${label} ${n}`}
        data-block-interaction="ignore"
        className={value === n
          ? 'h-6 min-w-6 rounded bg-primary text-xs font-medium text-primary-foreground'
          : 'h-6 min-w-6 rounded border border-border text-xs text-muted-foreground hover:bg-accent'}
        onClick={event => {
          event.stopPropagation()
          onSet(n)
        }}
      >{n}</button>
    ))}
  </div>
)

const Toggle = ({label, active, busy, onToggle}: {
  label: string
  active: boolean
  busy: boolean
  onToggle: (next: boolean) => void
}) => (
  <button
    type="button"
    disabled={busy}
    aria-pressed={active}
    data-block-interaction="ignore"
    className={active
      ? 'rounded bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground'
      : 'rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent'}
    onClick={event => {
      event.stopPropagation()
      onToggle(!active)
    }}
  >{label}</button>
)

/** Exported directly (not just the decorated wrapper below) so the render
 *  test can mount it without going through `cachedContentDecorator` — that
 *  wrapper has no runtime under the unit tier's kernel-type stubs, the same
 *  reason `LabPageContent` is split from `LabPageRenderer`. */
export const NightLine = ({block, Inner}: Props) => {
  const workspaceId = useWorkspaceId(block)
  const {nights, experiments} = useLabRows(workspaceId)
  const night = nights.find(n => n.id === block.id)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [typingReason, setTypingReason] = useState<string | null>(null)

  const rate = (rating: NightRating, value: number | null) => {
    setBusy(true)
    setProblem(null)
    writeRating(block.repo, block.id, rating, value)
      .then(outcome => setProblem(REFUSED[outcome]))
      .catch((error: unknown) => {
        console.error('[sleep-lab] could not save that rating', error)
        setProblem('Could not save that — try again.')
      })
      .finally(() => setBusy(false))
  }

  const covariate = (patch: CovariatePatch) => {
    setBusy(true)
    setProblem(null)
    writeCovariates(block.repo, block.id, patch)
      .then(outcome => setProblem(REFUSED[outcome]))
      .catch((error: unknown) => {
        console.error('[sleep-lab] could not save that', error)
        setProblem('Could not save that — try again.')
      })
      .finally(() => setBusy(false))
  }

  const commitReason = () => {
    const raw = typingReason
    setTypingReason(null)
    if (raw === null) return
    covariate({unusualReason: raw.trim() === '' ? null : raw})
  }

  return (
    <div className="flex flex-col gap-1">
      <Inner block={block}/>
      {night && !block.repo.isReadOnly ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-1 text-xs" data-block-interaction="ignore">
          <span className="rounded border border-border px-1.5 py-0.5 font-medium text-muted-foreground">
            {assignmentBadge(night, experiments)}
          </span>
          {RATING_SCALES.map(({key, label}) => (
            <RatingControl key={key} label={label} value={night.ratings[key]} busy={busy} onSet={value => rate(key, value)}/>
          ))}
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">KSS</span>
            <select
              aria-label="Afternoon sleepiness (KSS)"
              disabled={busy}
              data-block-interaction="ignore"
              className="h-6 rounded border border-border bg-transparent px-1 text-xs tabular-nums"
              value={night.ratings.sleepiness === undefined ? '' : String(night.ratings.sleepiness)}
              onClick={event => event.stopPropagation()}
              onChange={event => {
                const raw = event.currentTarget.value
                rate('sleepiness', raw === '' ? null : Number(raw))
              }}
            >
              <option value="">–</option>
              {KSS_CHOICES.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">Alcohol</span>
            <select
              aria-label="Alcoholic drinks"
              disabled={busy}
              data-block-interaction="ignore"
              className="h-6 rounded border border-border bg-transparent px-1 text-xs tabular-nums"
              value={night.alcohol === undefined ? '' : String(Math.min(night.alcohol, 4))}
              onClick={event => event.stopPropagation()}
              onChange={event => {
                const raw = event.currentTarget.value
                covariate({alcohol: raw === '' ? null : Number(raw)})
              }}
            >
              <option value="">–</option>
              {ALCOHOL_CHOICES.map(n => <option key={n} value={n}>{n === 4 ? '4+' : n}</option>)}
            </select>
          </div>
          <Toggle label="Caffeine late" active={night.caffeineLate} busy={busy} onToggle={next => covariate({caffeineLate: next})}/>
          <Toggle label="Late meal" active={night.lateMeal} busy={busy} onToggle={next => covariate({lateMeal: next})}/>
          <Toggle
            label="Unusual"
            active={night.unusual}
            busy={busy}
            onToggle={next => covariate(next ? {unusual: next} : {unusual: next, unusualReason: null})}
          />
          {night.unusual ? (
            <input
              type="text"
              placeholder="Why?"
              disabled={busy}
              data-block-interaction="ignore"
              className="h-6 min-w-0 flex-1 rounded border border-border bg-transparent px-1 text-xs"
              value={typingReason ?? night.unusualReason ?? ''}
              onClick={event => event.stopPropagation()}
              onChange={event => setTypingReason(event.currentTarget.value)}
              onBlur={commitReason}
              onKeyDown={event => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') setTypingReason(null)
              }}
            />
          ) : null}
          {problem ? <span className="text-destructive">{problem}</span> : null}
        </div>
      ) : null}
      {night?.main ? <div className="pl-1 text-xs text-muted-foreground">{summarizeMainSession(night.main)}</div> : null}
    </div>
  )
}
