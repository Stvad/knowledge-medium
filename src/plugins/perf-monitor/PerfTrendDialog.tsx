/**
 * The trend view: this device's recorded performance history, plus the current
 * verdict about it.
 *
 * Distinct from the chip on purpose. An alarm answers "is something wrong
 * now"; an investigation asks "when did this change, and what shipped around
 * then" — and only the series answers the second.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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
import type { InteractionRecordData } from '@/plugins/interaction-metrics/record.js'
import type { StartupRecordData } from '@/plugins/startup-metrics/record.js'
import { INTERACTION_SERIES, STARTUP_SERIES, loadRecords, rowTime } from './load.js'
import { bootstrapGapMs, invalidationsPerWrite, round2 } from './series.js'
import { summarize } from './verdict.js'
import { recordingBlockedBy } from '@/plugins/interaction-metrics/sessionContext.js'
import { runPerfAnalysisNow } from './schedule.js'
import { getPerfAnalysisFor, subscribePerfAnalysis } from './store.js'
import { monitorRunFor, subscribeMonitorRun } from './monitorRun.js'

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
 *  it: a table charting a different number than the alarm fires on is worse
 *  than no table. */
const perWrite = (r: InteractionRecordData): string => {
  const rate = invalidationsPerWrite(r)
  return rate === null ? '—' : round2(rate).toFixed(2)
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th className="text-left font-medium text-muted-foreground pr-3 pb-1 whitespace-nowrap">{children}</th>
)
const Td = ({ children }: { children: React.ReactNode }) => (
  <td className="pr-3 py-0.5 whitespace-nowrap tabular-nums">{children}</td>
)

export function PerfTrendDialog({ resolve, workspaceId }: DialogContextProps<void> & { workspaceId?: string }) {
  const repo = useRepo()
  // Both signals: a publication, and a `resetMetrics()` that retires the
  // counters the current verdict rests on while moving nothing else.
  const subscribeVerdict = useCallback((onChange: () => void) => {
    const stops = [subscribePerfAnalysis(onChange), repo.onMetricsReset(onChange)]
    return () => { for (const stop of stops) stop() }
  }, [repo])
  const analysis = useSyncExternalStore(subscribeVerdict, () =>
    getPerfAnalysisFor(repo, workspaceId ?? repo.activeWorkspaceId),
  )
  // The dialog reads the recording blocker LIVE, and a role change moves it
  // with nothing else moving — no analysis is published, so the store's
  // subscription never fires. Same seam the status chip uses; without it this
  // dialog shows the pre-change status until the next cadence.
  const readOnly = useSyncExternalStore(
    useCallback((onChange: () => void) => repo.onReadOnlyChange(onChange), [repo]),
    () => repo.isReadOnly,
  )
  /** The context a refresh is running for, or null. A refresh superseded by a
   *  sign-out, a workspace change or a monitor toggle would otherwise hold the
   *  replacement's button disabled until it settled — or forever, if it hung. */
  const [refreshingFor, setRefreshingFor] = useState<object | null>(null)
  // The active pin decides `stale`, and a workspace switch moves nothing else
  // this dialog subscribes to — no publication, no role change. Without this
  // seam the staleness re-render is incidental: it arrives only if some other
  // signal happens to fire, so the dialog goes on offering a blocker (and a
  // re-analyze button) for a workspace the user has already left.
  const activePin = useSyncExternalStore(
    useCallback((onChange: () => void) => repo.client.onActingAsChange(onChange), [repo]),
    () => repo.activeWorkspaceId,
  )
  const ws = workspaceId ?? activePin

  /** The monitor run this dialog is looking at, or null. Subscribed, so a
   *  teardown or restart re-renders — the analysis store cannot stand in for
   *  that, since its snapshot is null on both sides of a teardown. */
  const run = useSyncExternalStore(
    subscribeMonitorRun,
    () => (ws == null ? null : monitorRunFor(repo, ws)),
  )

  /** ONE identity for the world this dialog is looking at: the Repo, the
   *  workspace, and the monitor run. Everything asynchronous here is tagged
   *  with the context it was started in, and anything carrying a different one
   *  is simply not shown.
   *
   *  Compared during RENDER, so a context change hides superseded results in
   *  the same commit. A token bumped from an effect is one commit late, which
   *  is exactly long enough to paint the previous workspace's history. */
  const context = useMemo(() => ({ repo, ws, run }), [repo, ws, run])

  /** The context anyone is still waiting on, or null once nobody is. The
   *  refresh has no rows to tag, so this is the whole of its ownership: the
   *  cleanup is what stops a rejection arriving after the dialog closed from
   *  raising a global toast over whatever replaced it. */
  const latest = useRef<object | null>(context)
  useEffect(() => {
    latest.current = context
    return () => { latest.current = null }
  }, [context])

  /** The loaded series WITH the world it was read in and the PUBLICATION it was
   *  read for. Derived rather than cleared: a sign-out swaps the Repo, and rows
   *  in bare state would go on showing the previous user's history until the
   *  new read finished — or forever, if it failed.
   *
   *  `seq` because the tables are what a reader checks the verdict against and
   *  the series moves underneath an open dialog. It proves which publication
   *  these rows were read FOR, not that the analysis read the same bytes: this
   *  is a second query. ACCEPTED — one round trip against a cadence of minutes.
   */
  const [series, setSeries] = useState<{
    context: object
    seq: number | null
    startup: StartupRecordData[]
    interaction: InteractionRecordData[]
  } | null>(null)
  const seq = analysis?.seq ?? null
  const shown = series && series.context === context && series.seq === seq
    ? series
    : null
  const startup = shown?.startup ?? null
  const interaction = shown?.interaction ?? null

  /** The ONE place the series is read, keyed on everything a row is tagged
   *  with. React's own cleanup is then the whole ownership story: a new world
   *  or a new publication re-runs this and invalidates the read in flight,
   *  unmounting invalidates it, and success and failure consult the same flag.
   *
   *  Which is why the manual refresh below does not read: its publication
   *  re-runs this effect with the right `seq`, where loading from the refresh
   *  meant loading under the `seq` captured before it published. */
  useEffect(() => {
    if (!ws) return
    let alive = true
    // Async IIFE: the state lands on resolve, not during the effect.
    void (async () => {
      try {
        const [s, i] = await Promise.all([
          loadRecords(repo, ws, STARTUP_SERIES),
          loadRecords(repo, ws, INTERACTION_SERIES),
        ])
        if (!alive) return
        setSeries({
          context, seq,
          startup: s.map((r) => r.record),
          interaction: i.map((r) => r.record),
        })
      } catch (e) {
        if (!alive) return
        showError(`Couldn't read performance history: ${e instanceof Error ? e.message : String(e)}`)
      }
    })()
    return () => { alive = false }
  }, [repo, ws, seq, context])

  // The dialog is pinned to the workspace it opened on, but a fresh analysis
  // reads AMBIENT state — `repo.isReadOnly` describes whichever workspace is
  // active now. Re-analyzing a pinned workspace from inside another would
  // report its blocker as the active one's: an editable workspace shown as
  // recording-disabled, or a read-only one shown as fine.
  const runActive = run !== null
  const refreshing = refreshingFor === context
  const stale = !ws || ws !== activePin
  // The monitor's own toggle can go off while this dialog stays mounted in the
  // shared DialogHost. Nothing could publish then, so the button would spin and
  // leave the panel saying "No analysis yet" — an advertised action with no
  // visible effect.
  //
  // Its OWN subscription, not the analysis store's: a store notification only
  // re-renders a reader whose snapshot changed, and with nothing published that
  // snapshot is null on both sides of a teardown.
  const monitorOff = !stale && !runActive
  /** Live, and only while this dialog is still ON its workspace: `readOnly`
   *  follows whichever workspace is ACTIVE, and everything here describes the
   *  pinned one. Unknown is the honest answer once those diverge. */
  const blockedBy = stale ? null : recordingBlockedBy({ isReadOnly: readOnly })

  const refresh = async () => {
    // Re-READ, not the render's snapshot: a click lands after a render, and the
    // workspace or the monitor run can move in between — after which this whole
    // pass (two history reads, a live block count, an analysis) runs for a
    // context whose publication will then be refused. Refuse before the
    // expensive step, not after it.
    if (!ws || ws !== repo.activeWorkspaceId || monitorRunFor(repo, ws) === null) return
    const mine = context
    setRefreshingFor(mine)
    try {
      // An accepted analysis publishes, which re-runs the load effect. A refused
      // one changes no verdict, so the tables beside it are still current.
      await runPerfAnalysisNow(repo, ws)
    } catch (e) {
      // A refresh superseded by a sign-out or a workspace change would otherwise
      // raise its failure over whatever is on screen now, describing an analysis
      // nobody is waiting for.
      if (latest.current !== mine) return
      showError(`Analysis failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRefreshingFor((current) => (current === mine ? null : current))
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
              // The same verdict the status chip renders — neither surface
              // decides for itself what an empty regression list means.
              // Only while this dialog is still ON its workspace. `readOnly`
              // follows whichever workspace is ACTIVE, and the verdict beside
              // it describes the pinned one — so once those diverge the blocker
              // would claim recording is disabled for a workspace that is fine,
              // or stay silent about one that is not. Unknown is the honest
              // answer, and the "switched workspace" line above says why.
              const verdict = summarize(analysis, { blockedBy })
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
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void refresh()} disabled={refreshing || stale || monitorOff}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? 'animate-spin' : ''}`} /> Re-analyze
          </Button>
          {stale && (
            <p className="text-xs text-muted-foreground mt-1">
              Switched workspace since this opened — reopen here to re-analyze.
            </p>
          )}
          {monitorOff && (
            <p className="text-xs text-muted-foreground mt-1">
              Performance monitoring is switched off — turn it back on to re-analyze.
            </p>
          )}
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
                    <tr key={`${rowTime(STARTUP_SERIES, r)}-${i}`}>
                      {/* Boot time — `recordedAt` is stamped whenever the
                          deferred write happens to land. */}
                      <Td>{when(rowTime(STARTUP_SERIES, r))}</Td>
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
              {/* The timing is only true while recording is possible. Blocked,
                  the verdict above says so, and promising a record a minute
                  from now contradicts it. */}
              {blockedBy === null
                ? 'No interaction records yet — the first lands about a minute into a session.'
                : 'No interaction records on this device.'}
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
                      <tr key={`${rowTime(INTERACTION_SERIES, r)}-${i}`}>
                        <Td>{when(rowTime(INTERACTION_SERIES, r))}</Td>
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
