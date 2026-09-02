import type { PerfAnalysis } from '../analyze'
import type { Regression } from '../series'
import { currentMonitorRun } from '../monitorRun'

/** A fully-judged, unregressed analysis. Shared by the verdict and chip tests:
 *  every field added to `PerfAnalysis` costs an edit per copy of this shape. */
export const analysisFixture = (over: Partial<PerfAnalysis> = {}): PerfAnalysis => ({
  workspaceId: 'ws-1',
  analyzedAt: 1000,
  seq: 1,
  regressions: [],
  ready: { interaction: true, startup: true },
  startupAwaitingCurrentSample: false,
  interactionComparable: true,
  recordingBlockedBy: null,
  baseline: { interaction: 12, startup: 12 },
  recorded: { interaction: 12, startup: 12 },
  graphGrowth: null,
  // The run in force when the fixture is BUILT, so a test that started one gets
  // a publishable analysis and a test that did not gets one the store refuses —
  // which is what the store is for.
  run: currentMonitorRun(),
  ...over,
})

export const regressionFixture = (over: Partial<Regression> = {}): Regression => ({
  metric: 'query:backlinks.forBlock',
  label: 'backlinks.forBlock p95',
  baseline: 10,
  current: 40,
  ratio: 4,
  unit: 'ms',
  ...over,
})
