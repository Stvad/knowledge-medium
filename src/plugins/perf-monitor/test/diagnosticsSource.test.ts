// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { PerfAnalysis } from '../analyze'
import { mapAnalysisToSnapshot } from '../diagnosticsSource'
import { VIEW_PERF_TREND_ACTION_ID } from '../store'

const analysis = (over: Partial<PerfAnalysis> = {}): PerfAnalysis => ({
  workspaceId: 'ws-1',
  analyzedAt: 1000,
  baselineSessions: 12,
  regressions: [],
  insufficientHistory: false,
  ready: { interaction: true, startup: true },
  interactionComparable: true,
  recordingBlockedBy: null,
  baseline: { interaction: 12, startup: 12 },
  graphGrowth: null,
  ...over,
})

const regression = (over = {}) => ({
  metric: 'query:backlinks.forBlock',
  label: 'backlinks.forBlock p95',
  baseline: 10,
  current: 40,
  ratio: 4,
  unit: 'ms' as const,
  ...over,
})

describe('mapAnalysisToSnapshot', () => {
  // "Not enough history to judge" and "judged, nothing wrong" call for opposite
  // reactions, so they must not collapse into the same green state -- a silent
  // ok from a comparison that never ran is the failure this feature exists to
  // remove.
  it('reports a short series as its own state, not as health', () => {
    const snapshot = mapAnalysisToSnapshot(analysis({ insufficientHistory: true, baselineSessions: 2 }))
    expect(snapshot.severity).toBe('info')
    expect(snapshot.summary).toMatch(/baseline/i)
  })

  it('reports a clean comparison as ok, saying what it compared against', () => {
    const snapshot = mapAnalysisToSnapshot(analysis())
    expect(snapshot.severity).toBe('ok')
    expect(snapshot.detail).toContain('12')
  })

  // A partial comparison is not health. The judgement itself lives in
  // `summarize`, shared with the trend dialog; this pins that the chip's
  // severity follows it rather than being decided again here.
  it('does not report a partial comparison as ok', () => {
    const snapshot = mapAnalysisToSnapshot(analysis({
      ready: { interaction: false, startup: true },
      baselineSessions: 0,
    }))
    expect(snapshot.severity).toBe('info')
    expect(snapshot.detail).toContain('interaction history still building')
  })

  // An `error` reddens the whole status chip, which is the app's signal for
  // "your data is structurally wrong". A slow query must not spend it.
  it('never escalates a slowdown past a warning', () => {
    const snapshot = mapAnalysisToSnapshot(analysis({
      regressions: [regression({ ratio: 140 }), regression({ metric: 'query:other', ratio: 9 })],
    }))
    expect(snapshot.severity).toBe('warning')
    expect(snapshot.nudge).toBe(true)
  })

  it('leads with the worst regression and routes the action to the trend view', () => {
    const snapshot = mapAnalysisToSnapshot(analysis({
      regressions: [regression({ ratio: 4 })],
    }))
    expect(snapshot.summary).toContain('4×')
    expect(snapshot.detail).toContain('10ms → 40ms')
    expect(snapshot.actionId).toBe(VIEW_PERF_TREND_ACTION_ID)
  })
})
