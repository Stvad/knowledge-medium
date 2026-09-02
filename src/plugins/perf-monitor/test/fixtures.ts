import type { PerfAnalysis } from '../analyze'
import type { Regression } from '../series'

/** A fully-judged, unregressed analysis. Shared by the verdict and chip tests,
 *  which were maintaining byte-identical copies — and every field added to
 *  `PerfAnalysis` costs an edit per copy. */
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
  graphGrowth: null,
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
