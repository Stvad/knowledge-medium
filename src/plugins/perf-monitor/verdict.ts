/**
 * The single statement of what the analysis found.
 *
 * Both surfaces — the status chip and the trend dialog — render THIS rather
 * than each deciding for itself what an empty regression list means, which is
 * the difference between "judged and fine" and "nothing was judged".
 */
import type { PerfAnalysis } from './analyze.js'
import type { Regression } from './series.js'

export interface PerfVerdict {
  /** `pending` means nothing was judged — reported distinctly from `clean`,
   *  because an empty regression list is the same shape for both and the
   *  opposite statement. */
  kind: 'regressed' | 'clean' | 'pending'
  headline: string
  /** Context that qualifies the headline, in reading order. */
  notes: string[]
  regressions: Regression[]
}

const formatValue = (r: Regression): string =>
  r.unit === 'ms'
    ? `${Math.round(r.baseline)}ms → ${Math.round(r.current)}ms`
    : `${r.baseline} → ${r.current}`

export const formatRegression = (r: Regression): string => `${r.label} ${formatValue(r)}`

/** A duration got SLOWER; a rate got HIGHER. The fan-out metric is a rate, and
 *  it is the one this feature exists to catch, so the headline describing it as
 *  "slower" misnames the primary diagnostic. */
const worsened = (r: Regression): string =>
  r.unit === 'ms' ? 'slower than baseline' : 'higher than baseline'

/** Why the graph size is reported and not corrected for: see `runPerfAnalysis`.
 *  Shown only once it has moved, so the common case stays quiet. */
const graphNote = (growth: number | null): string | null =>
  growth !== null && growth >= 1.05
    ? `graph ${Math.round((growth - 1) * 100)}% larger than the baseline's`
    : null

/** Which series went unjudged, and why. The two reasons resolve differently —
 *  waiting fixes a series that is still filling; only a fresh page session
 *  fixes counters blended across workspaces — so they are not one message. */
const pendingNotes = (analysis: PerfAnalysis): string[] => {
  const notes: string[] = []
  if (!analysis.interactionComparable) {
    notes.push('interaction metrics not comparable this session (more than one workspace opened)')
  } else if (!analysis.ready.interaction) {
    notes.push('interaction history still building')
  }
  if (!analysis.ready.startup) notes.push('startup history still building')
  return notes
}

export const summarize = (analysis: PerfAnalysis): PerfVerdict => {
  const blocked =
    analysis.recordingBlockedBy === null
      ? null
      : analysis.recordingBlockedBy === 'no-persistent-client'
        ? 'new samples are not being recorded: this browser keeps no durable client id'
        : 'new samples are not being recorded: this workspace is read-only'

  // Blocked recording stops the series GROWING. It does not invalidate history
  // already on disk, nor this session's own live counters, so a real regression
  // found against them still has to be reported — with the blocker as context,
  // not in place of the finding.
  if (blocked !== null && analysis.regressions.length === 0) {
    return {
      kind: 'pending',
      headline: 'Performance history disabled',
      notes: [blocked],
      regressions: [],
    }
  }
  const pending = [...pendingNotes(analysis), ...(blocked ? [blocked] : [])]
  const notes = [...pending]
  const growth = graphNote(analysis.graphGrowth)

  if (analysis.regressions.length > 0) {
    const worst = analysis.regressions[0]
    if (growth) notes.unshift(growth)
    return {
      kind: 'regressed',
      headline: `${worst.label} ${worst.ratio}× ${worsened(worst)}`,
      notes,
      regressions: analysis.regressions,
    }
  }
  if (analysis.insufficientHistory) {
    return {
      kind: 'pending',
      headline: 'Building a baseline',
      // The pending notes say WHICH series is missing and why; dropping them
      // for a bare count is how a workspace switch came to read as "building a
      // baseline · 20 sessions recorded so far".
      notes: [`${analysis.baseline.interaction} sessions recorded so far`, ...pending],
      regressions: [],
    }
  }
  // Nothing regressed among the series that WERE judged. If some series was not
  // judged at all, that is not a clean bill of health for it, and saying so is
  // the whole point of this feature.
  return {
    kind: pending.length > 0 ? 'pending' : 'clean',
    headline:
      pending.length > 0
        ? 'Partial comparison'
        : 'No slowdowns vs baseline',
    notes: [
      // The count for the series that was actually judged, not the other one's.
      `compared against ${analysis.ready.interaction ? analysis.baseline.interaction : analysis.baseline.startup} recent sessions`,
      ...notes,
    ],
    regressions: [],
  }
}
