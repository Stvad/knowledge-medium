/**
 * The trend view: this device's recorded performance history, plus the current
 * verdict about it.
 *
 * The reason this exists rather than a smarter alarm: an alarm answers "is
 * something wrong now", and an investigation asks "when did this change, and
 * what shipped around then". Only the series answers the second, and until this
 * view there was nowhere in the app to see it — the startup recorder had been
 * writing a per-session timeline for two months that nothing had ever read.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Activity, RefreshCw, TrendingUp } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.js'
import { Button } from '@/components/ui/button.js'
import { useRepo } from '@/context/repo.js'
import { showError } from '@/utils/toast.js'
import type { DialogContextProps } from '@/utils/dialogs.js'
import {
  interactionMetricsUIStateType,
  type InteractionRecordData,
} from '@/plugins/interaction-metrics/record.js'
import {
  startupMetricsUIStateType,
  type StartupRecordData,
} from '@/plugins/startup-metrics/record.js'
import { INTERACTION_RECORD_PATH, STARTUP_RECORD_PATH, loadRecords } from './load.js'
import { bootstrapGapMs, invalidationsPerWrite } from './series.js'
import { summarize } from './verdict.js'
import { runPerfAnalysisNow } from './schedule.js'
import { getPerfAnalysisFor, subscribePerfAnalysis } from './store.js'

/** Sessions shown per table. The stored series is longer (see `HISTORY_LIMIT`);
 *  this is what fits in a dialog without becoming a spreadsheet. */
const ROWS = 15

const ms = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : `${Math.round(v)}ms`

const when = (epochMs: number): string =>
  new Date(epochMs).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })

/** The costliest query in a session, by p95. The single number that best stands
 *  in for "how did interaction feel" without listing twelve columns. */
const slowestQuery = (r: InteractionRecordData): { name: string; p95Ms: number } | null => {
  let worst: { name: string; p95Ms: number } | null = null
  for (const [name, q] of Object.entries(r.queries)) {
    if (!worst || q.p95Ms > worst.p95Ms) worst = { name, p95Ms: q.p95Ms }
  }
  return worst
}

/** Shares `invalidationsPerWrite` with the comparison rather than recomputing
 *  it: a table that charted a different number than the alarm fires on is worse
 *  than no table, and these did drift once. */
const perWrite = (r: InteractionRecordData): string => {
  const rate = invalidationsPerWrite(r)
  return rate === null ? '—' : (Math.round(rate * 100) / 100).toFixed(2)
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th className="text-left font-medium text-muted-foreground pr-3 pb-1 whitespace-nowrap">{children}</th>
)
const Td = ({ children }: { children: React.ReactNode }) => (
  <td className="pr-3 py-0.5 whitespace-nowrap tabular-nums">{children}</td>
)

export function PerfTrendDialog({ resolve, workspaceId }: DialogContextProps<void> & { workspaceId?: string }) {
  const repo = useRepo()
  const analysis = useSyncExternalStore(subscribePerfAnalysis, () =>
    getPerfAnalysisFor(workspaceId ?? repo.activeWorkspaceId),
  )
  const [startup, setStartup] = useState<StartupRecordData[] | null>(null)
  const [interaction, setInteraction] = useState<InteractionRecordData[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const ws = workspaceId ?? repo.activeWorkspaceId

  useEffect(() => {
    if (!ws) return
    let live = true
    void (async () => {
      try {
        const [s, i] = await Promise.all([
          loadRecords<StartupRecordData>(repo, ws, startupMetricsUIStateType.id, STARTUP_RECORD_PATH),
          loadRecords<InteractionRecordData>(repo, ws, interactionMetricsUIStateType.id, INTERACTION_RECORD_PATH),
        ])
        if (!live) return
        setStartup(s.map((r) => r.record))
        setInteraction(i.map((r) => r.record))
      } catch (e) {
        if (live) showError(`Couldn't read performance history: ${e instanceof Error ? e.message : String(e)}`)
      }
    })()
    return () => { live = false }
  }, [repo, ws])

  const refresh = async () => {
    if (!ws) return
    setRefreshing(true)
    try {
      await runPerfAnalysisNow(repo, ws)
    } catch (e) {
      showError(`Analysis failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) resolve() }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4" /> Performance trend
          </DialogTitle>
          <DialogDescription>
            This device&apos;s recorded sessions. Timings are only comparable within one
            device, so the baseline is this client&apos;s own recent history.
          </DialogDescription>
        </DialogHeader>

        <section className="text-sm">
          {!analysis ? (
            <p className="text-muted-foreground">No analysis yet this session.</p>
          ) : (
            (() => {
              // The same verdict the status chip renders. Deciding here what an
              // empty regression list means is how these two came to disagree.
              const verdict = summarize(analysis)
              return (
                <>
                  <p className={verdict.kind === 'clean' ? undefined : 'text-muted-foreground'}>
                    {verdict.headline}
                  </p>
                  {verdict.regressions.length > 0 && (
                    <ul className="space-y-1 mt-1">
                      {verdict.regressions.map((r) => (
                        <li key={r.metric} className="flex items-baseline gap-2">
                          <Activity className="h-3.5 w-3.5 shrink-0 translate-y-0.5" />
                          <span>
                            <strong>{r.label}</strong>{' '}
                            <span className="tabular-nums">
                              {r.unit === 'ms' ? `${ms(r.baseline)} → ${ms(r.current)}` : `${r.baseline} → ${r.current}`}
                            </span>{' '}
                            <span className="text-muted-foreground">({r.ratio}× baseline)</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {verdict.notes.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-1">{verdict.notes.join(' · ')}</p>
                  )}
                </>
              )
            })()
          )}
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? 'animate-spin' : ''}`} /> Re-analyze
          </Button>
        </section>

        <section>
          <h3 className="text-sm font-medium mb-1">Startup</h3>
          {startup === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : startup.length === 0 ? (
            <p className="text-sm text-muted-foreground">No startup records on this device yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead>
                  <tr>
                    <Th>Session</Th><Th>Build</Th><Th>Repo ready</Th>
                    {/* The number worth watching: repo-ready to paint is the
                        bootstrap's own serialized work, where TTI also moves
                        with sync volume and idle contention. */}
                    <Th>→ paint</Th><Th>Interactive</Th>
                  </tr>
                </thead>
                <tbody>
                  {startup.slice(0, ROWS).map((r, i) => (
                    <tr key={`${r.recordedAt}-${i}`}>
                      <Td>{when(r.recordedAt)}</Td>
                      <Td><code className="text-muted-foreground">{r.appSha?.slice(0, 8) || '—'}</code></Td>
                      <Td>{ms(r.repoReadyMs)}</Td>
                      <Td>{ms(bootstrapGapMs(r))}</Td>
                      <Td>{ms(r.interactiveMs)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <h3 className="text-sm font-medium mb-1">Interaction</h3>
          {interaction === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : interaction.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No interaction records yet — the first lands about a minute into a session.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead>
                  <tr>
                    <Th>Session</Th><Th>Build</Th><Th>Blocks</Th><Th>Writes</Th>
                    {/* Invalidations per write is the ratio that catches an
                        over-broad invalidation dep, which no latency column can. */}
                    <Th>Invalidations / write</Th><Th>Slowest query p95</Th>
                  </tr>
                </thead>
                <tbody>
                  {interaction.slice(0, ROWS).map((r, i) => {
                    const worst = slowestQuery(r)
                    return (
                      <tr key={`${r.recordedAt}-${i}`}>
                        <Td>{when(r.recordedAt)}</Td>
                        <Td><code className="text-muted-foreground">{r.appSha?.slice(0, 8) || '—'}</code></Td>
                        <Td>{r.blockCount.toLocaleString()}</Td>
                        <Td>{r.writes}</Td>
                        <Td>{perWrite(r)}</Td>
                        <Td>{worst ? `${worst.name} ${ms(worst.p95Ms)}` : '—'}</Td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </DialogContent>
    </Dialog>
  )
}
