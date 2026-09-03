// @vitest-environment node
/**
 * The comparison rules. These encode judgement calls about what counts as a
 * regression, so each test names the call it pins rather than the branch.
 */
import { describe, expect, it } from 'vitest'
import type { InteractionComparable } from '@/plugins/interaction-metrics/record'
import type { StartupRecordData } from '@/plugins/startup-metrics/record'
import {
  bootstrapGapMs,
  fanoutRegression,
  median,
  awaitingCurrentSample,
  partlyJudged,
  queryRegressions,
  startupRegression,
  MIN_BASELINE_SESSIONS,
  MIN_HISTORY_SESSIONS,
  regressionsIn,
  type TrendResult,
} from '../series'

/** The regressions a set of comparisons produced. Results are now explicit
 *  about "not judged" versus "judged and fine"; these tests are about which
 *  regressions come out, so they collapse that back down. */
const regs = (results: TrendResult[] | TrendResult) =>
  regressionsIn(Array.isArray(results) ? results : [results])
const reg = (result: TrendResult) => regs(result)[0] ?? null

const q = (p95Ms: number, calls = 100) => ({ calls, p50Ms: p95Ms / 2, p95Ms, totalMs: p95Ms * calls })

const sample = (over: Partial<InteractionComparable> = {}): InteractionComparable => ({
  writes: 100,
  queries: { 'backlinks.forBlock': q(10) },
  fanout: { loaderInvalidations: 50 },
  ...over,
})

const history = (n: number, s: () => InteractionComparable): InteractionComparable[] =>
  Array.from({ length: n }, s)

/** History whose most recent session ALSO shows `now`. The current reading is
 *  the median of a small recent window, so a regression registers once it is
 *  the majority of that window -- one session cannot swing it. */
const sinceRegressed = (
  now: () => InteractionComparable,
  base: () => InteractionComparable,
  baseCount = 8,
): InteractionComparable[] => [now(), ...history(baseCount, base)]

describe('median', () => {
  it('averages the middle pair on an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([3, 1, 2])).toBe(2)
    expect(median([])).toBe(0)
  })
})

describe('queryRegressions', () => {
  it('flags a query whose p95 doubled against the trailing median', () => {
    const slow = () => sample({ queries: { 'backlinks.forBlock': q(40) } })
    const found = regs(queryRegressions(slow(), sinceRegressed(slow, sample)))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      metric: 'query:backlinks.forBlock', baseline: 10, current: 40, ratio: 4,
    })
  })

  // A newly mounted surface is not a regression. Reporting one as infinitely
  // regressed is how an alarm teaches its reader to ignore it.
  it('ignores a query with no baseline rather than treating it as regressed', () => {
    const found = regs(queryRegressions(sample({ queries: { 'brandNew.query': q(500) } }), history(8, sample)))
    expect(found).toEqual([])
  })

  it('ignores a query too fast to feel, however much it grew', () => {
    const base = () => sample({ queries: { tiny: q(0.1) } })
    expect(regs(queryRegressions(sample({ queries: { tiny: q(4) } }), history(8, base)))).toEqual([])
  })

  // The magnitude floor belongs after the recent median. Applied to the live
  // sample alone, one fast session drops a query whose recent window is
  // sustainably regressed — the single-session swing the smoothing exists to
  // prevent, in the healthy direction.
  it('does not let one fast session hide a sustained regression', () => {
    const slow = () => sample({ queries: { 'backlinks.forBlock': q(40) } })
    const base = () => sample({ queries: { 'backlinks.forBlock': q(10) } })
    // The live session recovers below the floor; the two before it did not.
    const found = regs(queryRegressions(
      sample({ queries: { 'backlinks.forBlock': q(1) } }),
      [slow(), slow(), ...history(8, base)],
    ))
    expect(found.map((r) => r.metric)).toEqual(['query:backlinks.forBlock'])
    expect(found[0].current).toBe(40)
  })

  it('ignores a query with too few resolves to have a distribution', () => {
    const base = () => sample({ queries: { rare: q(10, 100) } })
    expect(regs(queryRegressions(sample({ queries: { rare: q(90, 3) } }), history(8, base)))).toEqual([])
  })

  it('reports nothing until the baseline is long enough to be one', () => {
    const slow = () => sample({ queries: { 'backlinks.forBlock': q(80) } })
    // One history entry is consumed smoothing the current reading, so the
    // baseline the comparison sees is one shorter than the history given.
    expect(
      regs(queryRegressions(slow(), sinceRegressed(slow, sample, MIN_BASELINE_SESSIONS))),
    ).toEqual([])
    expect(
      regs(queryRegressions(slow(), sinceRegressed(slow, sample, MIN_BASELINE_SESSIONS + 1))),
    ).toHaveLength(1)
  })

  // The cost of smoothing the current reading, stated as a rule: a regression
  // is reported once it is the MAJORITY of the recent window, not on its first
  // session.
  it('does not fire on a single anomalous session', () => {
    const found = regs(queryRegressions(
      sample({ queries: { 'backlinks.forBlock': q(400) } }),
      history(10, sample),
    ))
    expect(found).toEqual([])
  })

  // A gap in the recent window would otherwise leave a single live sample
  // standing in for the whole smoothed reading, voiding the guarantee exactly
  // when history is thinnest.
  it('will not judge on one sample when the recent window has gaps', () => {
    const withQ = () => sample({ queries: { seasonal: q(10) } })
    const without = () => sample({ queries: { other: q(10) } })
    // Present now and in the old baseline, absent from the two most recent.
    const found = regs(queryRegressions(
      sample({ queries: { seasonal: q(90) } }),
      [without(), without(), ...history(8, withQ)],
    ))
    expect(found).toEqual([])
  })

  // The exported minimum and what the comparison actually consumes must agree.
  // Drift between them is invisible: the chip reports "no slowdowns" for a
  // comparison that could never have run.
  it('starts comparing at exactly the advertised history length', () => {
    const slow = () => sample({ queries: { 'backlinks.forBlock': q(80) } })
    const at = (n: number) => regs(queryRegressions(slow(), sinceRegressed(slow, sample, n - 1)))
    expect(at(MIN_HISTORY_SESSIONS - 1)).toEqual([])
    expect(at(MIN_HISTORY_SESSIONS)).toHaveLength(1)
  })

  it('orders the worst ratio first', () => {
    const base = () => sample({ queries: { a: q(10), b: q(10) } })
    const slow = () => sample({ queries: { a: q(30), b: q(100) } })
    const found = regs(queryRegressions(slow(), [slow(), ...history(8, base)]))
    expect(found.map((r) => r.metric)).toEqual(['query:b', 'query:a'])
  })
})

describe('fanoutRegression', () => {
  // The signal for an over-broad invalidation dep: every resolve stays fast, so
  // no latency metric moves -- there are simply many times more of them.
  it('flags a rise in re-resolves per write even with unchanged latencies', () => {
    const base = () => sample({ writes: 100, fanout: { loaderInvalidations: 50 } })
    const now = () => sample({ writes: 100, fanout: { loaderInvalidations: 400 } })
    expect(reg(fanoutRegression(now(), sinceRegressed(now, base)))).toMatchObject({
      metric: 'fanout:invalidationsPerWrite', baseline: 0.5, current: 4, ratio: 8,
    })
  })

  it('reports nothing for a session that has not written', () => {
    expect(reg(fanoutRegression(sample({ writes: 0 }), history(8, sample)))).toBeNull()
  })

  // No ratio exists against a zero baseline; reporting one as infinite would
  // turn "this has always been zero" into the loudest possible finding.
  it('treats an unchanged zero as unchanged, not as an infinite regression', () => {
    const zero = () => sample({ writes: 100, fanout: { loaderInvalidations: 0 } })
    expect(fanoutRegression(zero(), history(10, zero)).status).toBe('steady')
  })

  // The other way to reach a zero baseline is the dangerous one: `steady` is a
  // positive health claim, so reporting it here would let the chip certify an
  // arbitrarily large move from nothing as "no slowdowns".
  it('will not certify a move from a zero baseline as healthy', () => {
    const base = () => sample({ writes: 100, fanout: { loaderInvalidations: 0 } })
    const now = () => sample({ writes: 100, fanout: { loaderInvalidations: 6000 } })
    const result = fanoutRegression(now(), [now(), now(), ...history(8, base)])
    expect(result.status).toBe('insufficient')
    expect(result.status).not.toBe('steady')
    // ...and under its own reason. Reported as short history, the verdict tells
    // the reader to keep waiting for sessions it already has ten of, and the one
    // thing that would actually change the answer goes unsaid.
    expect(result).toEqual({ status: 'insufficient', reason: 'no-baseline' })
  })
})

describe('startupRegression', () => {
  const THIS_BOOT = 5_000
  const boot = (
    repoReadyMs: number,
    firstContentPaintMs: number,
    timeOriginMs = THIS_BOOT,
  ): StartupRecordData =>
    ({ recordedAt: 0, appVersion: '', appSha: '', clientId: '', deviceLabel: '', timeOriginMs,
       repoReadyMs, firstContentPaintMs }) as StartupRecordData

  it('measures repo-ready to paint, not time-to-interactive', () => {
    expect(bootstrapGapMs(boot(1000, 1350))).toBe(350)
    expect(bootstrapGapMs({ recordedAt: 0 } as StartupRecordData)).toBeNull()
  })

  /** A boot with this bootstrap gap. */
  const gap = (ms: number): StartupRecordData => boot(1000, 1000 + ms)

  const held = (n: number) => Array.from({ length: n }, (_, i) => gap(320 + i * 10))

  /** Past boots whose newest are a step above the rest, so a comparison fires
   *  once there are enough of them. `series` never contains THIS boot — the
   *  loader hands that over separately. */
  const stepped = (n: number) => [gap(5100), gap(4900), ...held(n - 2)]

  // A boot that stayed hidden until after first paint records through the
  // fallback: the row exists, carries this boot's `timeOriginMs`, and has no
  // paint marks. It is immutable, so no amount of history gives it the sample
  // the comparison needs — reporting "still building" promises a resolution
  // that cannot come.
  it('reports a current row with no usable gap as an absent sample', () => {
    const incomplete = { recordedAt: 0, timeOriginMs: THIS_BOOT } as StartupRecordData
    expect(startupRegression(held(11), incomplete))
      .toEqual({ status: 'insufficient', reason: 'no-current-sample' })
  })

  // ...as distinct from a series that genuinely has too little history, which
  // waiting DOES fix.
  it('still reports thin history as thin history', () => {
    expect(startupRegression([gap(320)], gap(330)))
      .toEqual({ status: 'insufficient', reason: 'history' })
  })

  // This boot belongs on the RECENT side and nowhere near the baseline. Counted
  // as baseline it would top up the very history it is judged against; used
  // only as a gate it would report on the boots BEFORE it, which is the next
  // test.
  it('does not let this boot top up its own baseline', () => {
    // Two recent boots and one baseline short of a verdict.
    const thin = stepped(MIN_HISTORY_SESSIONS - 1)
    expect(reg(startupRegression(thin, gap(5000)))).toBeNull()
    expect(startupRegression(thin, gap(5000)))
      .toEqual({ status: 'insufficient', reason: 'history' })
  })

  // A slowdown that starts with THIS boot: two of the three most recent boots
  // are slow, and one of them is the one being judged. Read as a gate alone the
  // recent window is the three boots before this one — one slow, two clean —
  // and the regression stays invisible until enough later sessions record it.
  it('judges this boot, not only the ones before it', () => {
    expect(reg(startupRegression([gap(6000), gap(330), ...held(8)], gap(6100))))
      .toMatchObject({ metric: 'startup:bootstrapGapMs' })
  })

  it('flags the step in the bootstrap gap once it persists', () => {
    expect(reg(startupRegression([gap(5100), gap(4900), ...held(8)], gap(5000))))
      .toMatchObject({ metric: 'startup:bootstrapGapMs', current: 5000 })
  })

  it('stays quiet while the gap holds', () => {
    expect(reg(startupRegression(held(11), gap(325)))).toBeNull()
  })

  // The newest stored records are not necessarily from THIS boot: the write can
  // fail, the recorder can be disabled or read-only, and the analysis can
  // simply run before it. Comparing without one republishes an earlier page
  // load's verdict as though it described this one.
  it('will not judge startup without a record from this boot', () => {
    const series = [gap(5100), gap(4900), ...held(8)]
    expect(startupRegression(series, gap(5000)).status).toBe('regressed')
    expect(startupRegression(series, null).status).toBe('insufficient')
  })

  it('starts comparing at exactly the advertised history length', () => {
    expect(reg(startupRegression(stepped(MIN_HISTORY_SESSIONS - 1), gap(5000)))).toBeNull()
    expect(reg(startupRegression(stepped(MIN_HISTORY_SESSIONS), gap(5000)))).not.toBeNull()
  })

  it('does not fire on a single anomalous boot', () => {
    expect(reg(startupRegression(held(10), gap(9000)))).toBeNull()
  })
})

/**
 * A series with one judged metric and one unjudgeable one is INCOMPLETE.
 *
 * `anyJudged` answers "can a verdict be given at all"; it must not be read as
 * "everything was checked", or a steady query beside an unrateable fan-out
 * jump publishes a clean bill for a comparison that did not run.
 */
describe('partlyJudged', () => {
  const judged = { status: 'steady', baselineCount: 12 } as const
  const unjudged = { status: 'insufficient', reason: 'history' } as const

  it('is true when some metrics were judged and some were not', () => {
    expect(partlyJudged([judged, unjudged])).toBe(true)
  })

  it('is false when everything was judged, and when nothing was', () => {
    expect(partlyJudged([judged, judged])).toBe(false)
    expect(partlyJudged([unjudged, unjudged])).toBe(false)
    expect(partlyJudged([])).toBe(false)
  })
})

/**
 * A latency dimension nobody could judge is not a clean one.
 *
 * Every query too quiet to compare leaves no query results at all — and a
 * steady fan-out result alone would then publish "no slowdowns" for latency
 * that was never evaluated.
 */
describe('queryRegressions with nothing judgeable', () => {
  it('says so rather than returning nothing', () => {
    const quiet = sample({ queries: { 'backlinks.forBlock': q(40, 3) } })
    const results = queryRegressions(quiet, history(20, () => sample({
      queries: { 'backlinks.forBlock': q(40) },
    })))

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ status: 'insufficient' })
    expect(partlyJudged([...results, { status: 'steady', baselineCount: 12 }])).toBe(true)
  })
})

/**
 * A mixed set still has a live counter in it.
 *
 * One metric short of its own history beside another short of a current sample
 * is not "short of history": the live one can make a verdict possible the
 * moment someone edits, and calling it history parks the whole series behind
 * the long cadence.
 */
describe('awaitingCurrentSample with mixed reasons', () => {
  const shortHistory = { status: 'insufficient', reason: 'history' } as const
  const noSample = { status: 'insufficient', reason: 'no-current-sample' } as const

  it('reports a current sample missing among reasons that are not', () => {
    expect(awaitingCurrentSample([shortHistory, noSample])).toBe(true)
  })

  it('is false when every reason is history', () => {
    expect(awaitingCurrentSample([shortHistory, shortHistory])).toBe(false)
  })
})

