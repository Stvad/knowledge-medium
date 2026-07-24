/** The "look back" surface: milestones, per-lift trend sparklines,
 *  left/right asymmetry, and the recent-session log. Richer than Tonight and
 *  most useful on a wider screen, but degrades fine on mobile.
 */

import {useMemo} from 'react'

import {asymmetries, exerciseSeries, milestoneProgress, type SeriesPoint} from '../engine/trends'
import type {ProgramState} from './useProgram'

interface Props {
  program: ProgramState
}

export function HistoryView({program}: Props) {
  const {config, history} = program

  const milestones = useMemo(() => milestoneProgress(history, config), [history, config])
  const asym = useMemo(() => asymmetries(history, config), [history, config])
  // The load-progressed main lifts, in program order, that have any history.
  const trendLifts = useMemo(
    () =>
      config.exercises
        .filter(e => !e.freeform)
        .map(e => ({name: e.name, unit: config.unit, series: exerciseSeries(history, e.name, config.dayRolloverHour)}))
        .filter(t => t.series.length > 0),
    [history, config],
  )

  if (history.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No sessions logged yet. Log tonight above and trends will appear here.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-6">
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
      </Section>

      {trendLifts.length > 0 && (
        <Section title="Progression">
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {trendLifts.map(t => (
              <li key={t.name} className="rounded-md border border-border p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{t.name}</span>
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
              <li key={a.exercise} className="flex items-center justify-between gap-2 text-sm">
                <span>{a.exercise}</span>
                <span className="flex items-center gap-2 tabular-nums">
                  <span>L {a.left ?? '—'}</span>
                  <span className="text-muted-foreground">/</span>
                  <span>R {a.right ?? '—'}</span>
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
                  <span className="text-xs text-muted-foreground">{w.date.slice(0, 10)}</span>
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
