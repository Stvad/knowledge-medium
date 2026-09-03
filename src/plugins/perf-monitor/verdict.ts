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
  /** `pending` means the comparison is INCOMPLETE — nothing judged, or one
   *  series judged and another not. Reported distinctly from `clean` because an
   *  empty regression list is the same shape for both and the opposite
   *  statement, and a partial verdict is not a clean one: the series that went
   *  unjudged is exactly where a finding could have been hiding. */
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
  // Series-specific, because the same structural reason means different things:
  // startup's current sample IS a record for this boot, while interaction's is
  // the live counters, which exist but held nothing worth comparing.
  'no-current-sample': (s) => s === 'startup'
    ? 'no startup record for this session (startup recording may be off)'
    : 'no usable interaction measurement this session',
  'not-recording': (s) => `no ${s} record for this session (${s} recording may be off)`,
  'history-short': (s) => `${s} history still building`,
  'partly-judged': (s) => `some ${s} metrics could not be judged this session`,
}

/** Which series went unjudged, and why. They resolve differently — only
 *  `history-short` is fixed by waiting — so they are not one message. */
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

/** Facts read at RENDER time rather than stored on the analysis.
 *
 *  Whether recording is possible turns on `repo.isReadOnly`, which a
 *  server-pushed role change flips without touching the Repo, the workspace,
 *  the counter span or the monitor run — so nothing the analysis captured would
 *  be stale-looking, and a verdict from before a demotion would keep claiming
 *  recording works for the rest of the cadence. A live fact has to be read
 *  live. */
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
    // "Building a baseline" promises that waiting resolves this, which is only
    // true while some series is short on HISTORY and still receiving samples. A
    // series whose CURRENT sample never arrives — each recorder is togglable
    // independently of this monitor — is not filling however much history is
    // already on disk, and the note below will be reporting a healthy count
    // under a headline that says to keep waiting.
    const filling = Object.values(analysis.unjudgedBecause).includes('history-short')
    return {
      kind: 'pending',
      headline: filling ? 'Building a baseline' : 'Nothing recorded this session',
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
