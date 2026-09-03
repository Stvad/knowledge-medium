import type { PerfAnalysis } from '../analyze'
import type { Regression } from '../series'
import { currentMonitorRun } from '../monitorRun'

/** A fully-judged, unregressed analysis. Shared by the verdict and chip tests:
 *  every field added to `PerfAnalysis` costs an edit per copy of this shape. */
export const analysisFixture = (over: Partial<PerfAnalysis> = {}): PerfAnalysis => {
  // `ready` is DERIVED here exactly as `runPerfAnalysis` derives it, so a test
  // can state either one and never an inconsistent pair. Setting only `ready`
  // gets the ordinary reason for an unjudged series; a test that cares which
  // reason states `unjudgedBecause` instead.
  const unjudgedBecause = over.unjudgedBecause ?? {
    interaction: over.ready?.interaction === false ? ('history-short' as const) : null,
    startup: over.ready?.startup === false ? ('history-short' as const) : null,
  }
  return {
    workspaceId: 'ws-1',
    analyzedAt: 1000,
    seq: 1,
    regressions: [],
    baseline: { interaction: 12, startup: 12 },
    recorded: { interaction: 12, startup: 12 },
    graphGrowth: null,
    // The run in force when the fixture is BUILT, so a test that started one
    // gets a publishable analysis and a test that did not gets one the store
    // refuses — which is what the store is for.
    run: currentMonitorRun(),
    ...over,
    unjudgedBecause,
    ready: {
      interaction: unjudgedBecause.interaction === null,
      startup: unjudgedBecause.startup === null,
    },
  }
}

export const regressionFixture = (over: Partial<Regression> = {}): Regression => ({
  metric: 'query:backlinks.forBlock',
  label: 'backlinks.forBlock p95',
  baseline: 10,
  current: 40,
  ratio: 4,
  unit: 'ms',
  ...over,
})
