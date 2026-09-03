// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { analysisFixture as analysis, regressionFixture as regression } from './fixtures'
import { createPerfMonitorDiagnosticSource, mapAnalysisToSnapshot } from '../diagnosticsSource'
import { publishPerfAnalysis, resetPerfAnalysisStore, VIEW_PERF_TREND_ACTION_ID } from '../store'
import { resetMonitorRun, startMonitorRun } from '../monitorRun'

afterEach(() => { resetPerfAnalysisStore(); resetMonitorRun() })



describe('mapAnalysisToSnapshot', () => {
  // "Not enough history to judge" and "judged, nothing wrong" call for opposite
  // reactions, so they must not collapse into the same green state -- a silent
  // ok from a comparison that never ran is the failure this feature exists to
  // remove.
  it('reports a short series as its own state, not as health', () => {
    const snapshot = mapAnalysisToSnapshot(analysis({ ready: { interaction: false, startup: false }, baseline: { interaction: 2, startup: 0 } }), { blockedBy: null })
    expect(snapshot.severity).toBe('info')
    expect(snapshot.summary).toMatch(/baseline/i)
  })

  it('reports a clean comparison as ok, saying what it compared against', () => {
    const snapshot = mapAnalysisToSnapshot(analysis(), { blockedBy: null })
    expect(snapshot.severity).toBe('ok')
    expect(snapshot.detail).toContain('12')
  })

  // A partial comparison is not health. The judgement itself lives in
  // `summarize`, shared with the trend dialog; this pins that the chip's
  // severity follows it rather than being decided again here.
  it('does not report a partial comparison as ok', () => {
    const snapshot = mapAnalysisToSnapshot(analysis({
      ready: { interaction: false, startup: true },
    }), { blockedBy: null })
    expect(snapshot.severity).toBe('info')
    expect(snapshot.detail).toContain('interaction history still building')
  })

  // An `error` reddens the whole status chip, which is the app's signal for
  // "your data is structurally wrong". A slow query must not spend it.
  it('never escalates a slowdown past a warning', () => {
    const snapshot = mapAnalysisToSnapshot(analysis({
      regressions: [regression({ ratio: 140 }), regression({ metric: 'query:other', ratio: 9 })],
    }), { blockedBy: null })
    expect(snapshot.severity).toBe('warning')
    expect(snapshot.nudge).toBe(true)
  })

  it('leads with the worst regression and routes the action to the trend view', () => {
    const snapshot = mapAnalysisToSnapshot(analysis({
      regressions: [regression({ ratio: 4 })],
    }), { blockedBy: null })
    expect(snapshot.summary).toContain('4×')
    expect(snapshot.detail).toContain('10ms → 40ms')
    expect(snapshot.actionId).toBe(VIEW_PERF_TREND_ACTION_ID)
  })
})

/**
 * The chip follows a role change without a new analysis.
 *
 * `repo.isReadOnly` flips on a server-pushed role change while the Repo, the
 * workspace, the counter span and the monitor run all stay put — so nothing
 * republishes, and a blocker captured on the analysis would keep describing the
 * world as it was for the rest of the cadence.
 */
describe('createPerfMonitorDiagnosticSource', () => {
  it('re-reads the recording blocker rather than caching it with the verdict', () => {
    const repo = { activeWorkspaceId: 'ws-1', isReadOnly: false }
    const source = createPerfMonitorDiagnosticSource(repo)
    startMonitorRun(repo, 'ws-1')
    publishPerfAnalysis(analysis({ seq: 1, ready: { interaction: false, startup: false } }))

    expect(source.getSnapshot()?.detail ?? '').not.toContain('read-only')

    // The demotion, with no republication behind it.
    repo.isReadOnly = true

    expect(source.getSnapshot()?.detail ?? '').toContain('read-only')
  })
})

