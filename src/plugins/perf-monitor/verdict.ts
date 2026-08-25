/**
 * The single statement of what the analysis found.
 *
 * Both surfaces — the status chip and the trend dialog — render THIS rather
 * than each deciding for itself what an empty regression list means, which is
 * the difference between "judged and fine" and "nothing was judged".
 */
import type { PerfAnalysis } from './analyze.js'

/** Nothing was judged at all. Derived rather than stored, so it cannot be set
 *  inconsistently with `ready`. */
const nothingJudged = (a: PerfAnalysis): boolean => !a.ready.interaction && !a.ready.startup
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

/** How much history the comparison actually had.
 *
 *  Labelled per series once both were judged: the two fill independently and
 *  use their own windows, so a single bare number is the other series' count
 *  misreported as this one's. Unlabelled when only one was judged — there is no
 *  second count for a reader to confuse it with. */
const comparedAgainst = (analysis: PerfAnalysis): string => {
  const { interaction, startup } = analysis.ready
  if (interaction && startup) {
    return `compared against ${analysis.baseline.interaction} interaction and ${analysis.baseline.startup} startup sessions`
  }
  const n = interaction ? analysis.baseline.interaction : analysis.baseline.startup
  return `compared against ${n} recent ${interaction ? 'interaction' : 'startup'} sessions`
}

export const summarize = (analysis: PerfAnalysis): PerfVerdict => {
  const blocked =
    analysis.recordingBlockedBy === null
      ? null
      : analysis.recordingBlockedBy === 'no-persistent-client'
        ? 'new samples are not being recorded: this browser keeps no durable client id'
        : 'new samples are not being recorded: this workspace is read-only'

  // Blocked recording stops the series GROWING. It does not invalidate history
  // already on disk, nor this session's own live counters, so ANY verdict
  // reached against them still stands — clean as much as regressed — and the
  // blocker is context on it. The disabled headline is for the one case where
  // nothing was judged at all, and so there is no other verdict to carry it.
  if (blocked !== null && nothingJudged(analysis)) {
    return {
      kind: 'pending',
      headline: 'Performance history disabled',
      notes: [blocked],
      regressions: [],
    }
  }
  // The blocker is CONTEXT on whatever verdict was reached; only an unjudged
  // series makes a verdict partial. Folding the two together would report a
  // clean comparison in a read-only workspace as pending.
  const unjudged = pendingNotes(analysis)
  const notes0 = [...unjudged, ...(blocked ? [blocked] : [])]
  const notes = [...notes0]
  const growth = graphNote(analysis.graphGrowth)

  if (analysis.regressions.length > 0) {
    const worst = analysis.regressions[0]
    // Growth is measured over the INTERACTION baseline, so it only contextualises
    // interaction findings. Attached to a startup regression it would claim the
    // graph grew relative to a baseline that regression never used.
    const aboutInteraction = analysis.regressions.some((r) => !r.metric.startsWith('startup:'))
    if (growth && aboutInteraction) notes.unshift(growth)
    return {
      kind: 'regressed',
      headline: `${worst.label} ${worst.ratio}× ${worsened(worst)}`,
      notes,
      regressions: analysis.regressions,
    }
  }
  if (nothingJudged(analysis)) {
    return {
      kind: 'pending',
      headline: 'Building a baseline',
      // A bare count does not say WHICH series is missing, or that one of them
      // can never fill this session; the pending notes carry both.
      notes: [`${analysis.baseline.interaction} sessions recorded so far`, ...notes0],
      regressions: [],
    }
  }
  // Nothing regressed among the series that WERE judged. If some series was not
  // judged at all, that is not a clean bill of health for it, and saying so is
  // the whole point of this feature.
  return {
    kind: unjudged.length > 0 ? 'pending' : 'clean',
    headline: unjudged.length > 0 ? 'Partial comparison' : 'No slowdowns vs baseline',
    notes: [comparedAgainst(analysis), ...notes],
    regressions: [],
  }
}
