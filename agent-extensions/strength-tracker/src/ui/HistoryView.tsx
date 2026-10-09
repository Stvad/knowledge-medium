/** The "look back" surface: stalled lifts, milestones and lift ratios,
 *  per-lift trend sparklines, left/right asymmetry, and the recent-session
 *  log. Most useful on a wider screen, but degrades fine on mobile.
 */

import {useMemo} from 'react'

import {
  asymmetries,
  exerciseSeries,
  liftBalance,
  milestoneProgress,
  stalledLifts,
  type SeriesPoint,
} from '../engine/trends'
import {programOccurrences, type ProgramConfig, type WorkoutRecord} from '../engine/types'
import {dateToDay} from '../km/day'

interface Props {
  config: ProgramConfig
  history: readonly WorkoutRecord[]
}

export function HistoryView({config, history}: Props) {
  const milestones = useMemo(() => milestoneProgress(history, config), [history, config])
  const asym = useMemo(() => asymmetries(history, config), [history, config])
  const stalls = useMemo(() => stalledLifts(history, config), [history, config])
  const balance = useMemo(() => liftBalance(history, config), [history, config])
  // The load-progressed lifts, in program order, that have any history. A
  // plan that prescribes one lift twice draws two DIFFERENT lines.
  const trendLifts = useMemo(
    () => programOccurrences(config.exercises)
      .filter(({item}) => !item.freeform)
      .map(({item: e, occurrence, key}) => ({
        name: e.name,
        key,
        label: rowLabel(e.name, occurrence),
        unit: config.unit,
        series: exerciseSeries(
          history,
          {exercise: e.name, ...(e.defId !== undefined ? {defId: e.defId} : {}), occurrence},
          config.dayRolloverHour,
        ),
      }))
      .filter(t => t.series.length > 0),
    [history, config],
  )

  if (history.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No sessions logged yet. Start a session (⌃⇧L) and trends will appear here.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {stalls.length > 0 && (
        <Section title="Stalled">
          <ul className="flex flex-col gap-1.5">
            {stalls.map(stall => (
              <li key={stall.key} className="flex flex-col text-sm">
                <span>
                  {rowLabel(stall.exercise, stall.occurrence)}{' '}
                  <span className="tabular-nums text-muted-foreground">
                    {stall.weight}{config.unit} for {stall.sessions} sessions
                  </span>
                </span>
                {/* The reps are what separate a lift that is stuck from one
                    that is tired: a set-to-set fade points at rest or order,
                    not at the load. A carry logs no reps, so it has none. */}
                {stall.recent.some(reps => reps.some(r => r > 0)) ? (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    last: {stall.recent.map(reps => reps.join('·')).join(' / ')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Milestones">
        <ul className="flex flex-col gap-2">
          {milestones.map(m => (
            <li key={m.milestone.id} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className={m.hit ? 'font-medium text-emerald-600 dark:text-emerald-400' : ''}>
                  {m.hit ? '✓ ' : ''}
                  {m.milestone.label}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {m.best ?? '—'} / {m.milestone.weight}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-muted">
                <div
                  className={'h-full ' + (m.hit ? 'bg-emerald-500' : 'bg-primary')}
                  style={{width: `${Math.round(m.fraction * 100)}%`}}
                />
              </div>
            </li>
          ))}
        </ul>
        {balance.heaviest || balance.ratios.some(r => r.value !== undefined) ? (
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {balance.heaviest ? (
              <li className="flex justify-between gap-2">
                <span>{balance.heaviest.lift} is the heaviest lift</span>
                <span className={'shrink-0 tabular-nums ' + (balance.heaviest.holds ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}>
                  {balance.heaviest.holds ? '✓' : '✗'} {balance.heaviest.weight}
                  {` vs ${balance.heaviest.runnerUp.lift.toLowerCase()} ${balance.heaviest.runnerUp.weight}`}
                </span>
              </li>
            ) : null}
            {balance.ratios.map(({ratio, value}) => value === undefined ? null : (
              <li key={ratio.id} className="flex justify-between gap-2">
                <span>{ratio.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{value.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {trendLifts.length > 0 && (
        <Section title="Progression">
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {trendLifts.map(t => (
              <li key={t.key} className="rounded-md border border-border p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{t.label}</span>
                  <span className="tabular-nums text-sm text-muted-foreground">
                    {t.series.at(-1)!.weight}
                    {t.unit}
                  </span>
                </div>
                <Sparkline series={t.series} />
                <div className="mt-1 text-xs text-muted-foreground">
                  {t.series[0].weight} → {t.series.at(-1)!.weight} over {t.series.length} sessions
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {asym.length > 0 && (
        <Section title="Left / right">
          <ul className="flex flex-col gap-1.5">
            {asym.map(a => (
              <li key={a.key} className="flex items-center justify-between gap-2 text-sm">
                <span>{rowLabel(a.exercise, a.occurrence)}</span>
                <span className="flex items-center gap-2 tabular-nums">
                  {/* Reps beside the load: at equal weight the flag turns on
                      REPS, and showing weight alone would put "right ahead"
                      next to two identical numbers. */}
                  <span>L {a.left ?? '—'}{a.leftReps !== undefined ? `×${a.leftReps}` : ''}</span>
                  <span className="text-muted-foreground">/</span>
                  <span>R {a.right ?? '—'}{a.rightReps !== undefined ? `×${a.rightReps}` : ''}</span>
                  {a.rightAhead && (
                    <span className="rounded bg-amber-500/15 px-1 text-xs text-amber-600 dark:text-amber-400">
                      right ahead
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Recent sessions">
        <ul className="flex flex-col gap-2">
          {[...history]
            .reverse()
            .slice(0, 8)
            .map(w => (
              <li key={w.id} className="rounded-md border border-border p-2 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {w.session === 'mini' ? 'Mini' : `Session ${w.session}`}
                  </span>
                  {/* `dateToDay`, not the ISO prefix. `WorkoutRecord.date` is
                      an INSTANT — local noon for anything this extension wrote
                      — so its UTC prefix is the day BEFORE anywhere east of
                      UTC+12, and every session there listed a day early while
                      progression filed it correctly. Slicing an ISO string is
                      reading a local calendar day off a UTC rendering. */}
                  <span className="text-xs text-muted-foreground">
                    {dateToDay(new Date(w.date))}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {w.exercises
                    .filter(e => e.sets.length > 0)
                    .map(e => `${e.exercise} ${topWeight(e.sets)}×${e.sets.length}`)
                    .join(' · ') || 'no sets'}
                </div>
              </li>
            ))}
        </ul>
      </Section>
    </div>
  )
}
HistoryView.displayName = 'HistoryView'

/** A lift the plan prescribes twice in a session is numbered from its second
 *  row on. */
const rowLabel = (name: string, occurrence: number): string =>
  occurrence === 0 ? name : `${name} (${occurrence + 1})`

const topWeight = (sets: readonly {weight: number}[]): number =>
  sets.reduce((max, s) => Math.max(max, s.weight), 0)

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

/** A tiny dependency-free trend line. Self-contained SVG — no chart library,
 *  which also keeps the extension bundle CSP-clean. */
function Sparkline({series}: {series: readonly SeriesPoint[]}) {
  const w = 200
  const h = 36
  const pad = 3
  const weights = series.map(p => p.weight)
  const min = Math.min(...weights)
  const max = Math.max(...weights)
  const span = max - min || 1
  const n = series.length
  const x = (i: number) => (n === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1))
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad)
  const points = series.map((p, i) => `${x(i).toFixed(1)},${y(p.weight).toFixed(1)}`)

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-2 h-9 w-full" preserveAspectRatio="none" role="img" aria-label="progression trend">
      {n > 1 && (
        <polyline points={points.join(' ')} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-primary" />
      )}
      {series.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.weight)} r={1.6} className="fill-primary" />
      ))}
    </svg>
  )
}
