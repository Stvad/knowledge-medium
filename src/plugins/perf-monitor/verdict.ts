/**
 * The single statement of what the analysis found.
 *
 * Both surfaces — the status chip and the trend dialog — render THIS rather
 * than each deciding for itself what an empty regression list means, which is
 * the difference between "judged and fine" and "nothing was judged".
 */
import type { PerfAnalysis, UnjudgedReason } from './analyze.js'
import type { RecordingBlocker } from '@/plugins/interaction-metrics/sessionContext.js'

/** Nothing was judged at all. Derived rather than stored, so it cannot be set
 *  inconsistently with `ready`. */
const nothingJudged = (a: PerfAnalysis): boolean => !a.ready.interaction && !a.ready.startup
import type { Regression } from './series.js'

export interface PerfVerdict {
  /** `clean` is the only one that claims a COMPLETE comparison. `pending` says
   *  nothing regressed among what was judged and something was not judged —
   *  reported distinctly from `clean` because an empty regression list is the
   *  same shape for both and the opposite statement. `regressed` says only that
   *  a finding was found; a series or metric may still have gone unjudged
   *  beside it, and `notes` carries that. */
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
    ? `graph ${Math.round((growth - 1) * 100)}% larger than recent history's median`
    : null

/** One message per unjudged reason. RENDERED here, decided in `runPerfAnalysis`
 *  — a reason invented next to its message is how these came to disagree with
 *  what the comparison concluded. */
const NOTE: Record<UnjudgedReason, (series: 'interaction' | 'startup') => string> = {
  'blended-workspaces': (s) =>
    `${s} metrics not comparable this session (more than one workspace opened)`,
  // Series-specific, and neither asserts ABSENCE: startup reaches this reason
  // both with no row for this boot and with a fallback row carrying no paint
  // marks, and the trend table SHOWS that second row. A note claiming no record
  // exists would contradict the panel beside it.
  'no-current-sample': (s) => s === 'startup'
    ? 'no usable startup measurement for this session'
    : 'no usable interaction measurement this session',
  'not-recording': (s) => `no ${s} record for this session (${s} recording may be off)`,
  'history-short': (s) => `${s} history still building`,
  'no-baseline': (s) => `no ${s} baseline to compare against (recent sessions all measured zero)`,
  'partly-judged': (s) => `some ${s} metrics could not be judged this session`,
}

/** Which series went unjudged, and why — one message per series, since the
 *  reasons resolve differently and a reader acts on which one it is. */
const pendingNotes = (analysis: PerfAnalysis): string[] =>
  (['interaction', 'startup'] as const).flatMap((series) => {
    const reason = analysis.unjudgedBecause[series]
    return reason === null ? [] : [NOTE[reason](series)]
  })

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

/** Read at RENDER time, not stored on the analysis: a server-pushed role change
 *  flips `repo.isReadOnly` without touching the Repo, workspace, counter span
 *  or run, so a captured verdict would look fresh while claiming recording
 *  works for the rest of the cadence. */
export interface LiveFacts {
  blockedBy: RecordingBlocker | null
}

export const summarize = (analysis: PerfAnalysis, live: LiveFacts): PerfVerdict => {
  const blocked =
    live.blockedBy === null
      ? null
      : live.blockedBy === 'no-persistent-client'
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
  const notes = [...unjudged, ...(blocked ? [blocked] : [])]
  const growth = graphNote(analysis.graphGrowth)

  if (analysis.regressions.length > 0) {
    const worst = analysis.regressions[0]
    // Growth is measured over the INTERACTION baseline, so it only contextualises
    // interaction findings. Attached to a startup regression it would claim the
    // graph grew relative to a baseline that regression never used.
    const aboutInteraction = analysis.regressions.some((r) => !r.metric.startsWith('startup:'))
    return {
      kind: 'regressed',
      headline: `${worst.label} ${worst.ratio}× ${worsened(worst)}`,
      notes: growth && aboutInteraction ? [growth, ...notes] : notes,
      regressions: analysis.regressions,
    }
  }
  if (nothingJudged(analysis)) {
    // "Building a baseline" promises waiting resolves this, true only while a
    // series is short on HISTORY. One missing its CURRENT sample is not filling
    // however much is on disk, and the note would report a healthy count under
    // a headline saying to keep waiting.
    const filling = Object.values(analysis.unjudgedBecause).includes('history-short')
    return {
      kind: 'pending',
      // Not "nothing recorded": this boot can HAVE a row and still be unjudged
      // — one written through the hidden-until-after-paint fallback carries no
      // marks — and the note beside it reports a positive record count while
      // the table shows the row.
      headline: filling ? 'Building a baseline' : 'Nothing to compare this session',
      // From `recorded`, NOT `baseline`: nothing was judged in this branch, so
      // `baseline` is 0 for both series by construction — the note would report
      // a constant zero while the trend dialog shows the history it was counted
      // from. Both series named, because they fill independently and one number
      // is the other series' count misreported as this one's.
      notes: [
        `${analysis.recorded.interaction} interaction and ${analysis.recorded.startup} startup sessions recorded so far`,
        ...notes,
      ],
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
