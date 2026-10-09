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
  hasClusteredTail,
  startupRegression,
  MIN_BASELINE_SESSIONS,
  MIN_FANOUT_WRITES,
  MIN_HISTORY_SESSIONS,
  regressionsIn,
  slowestQuery,
  type TrendResult,
} from '../series'

/** The regressions a set of comparisons produced. Results are now explicit
 *  about "not judged" versus "judged and fine"; these tests are about which
 *  regressions come out, so they collapse that back down. */
const regs = (results: TrendResult[] | TrendResult) =>
  regressionsIn(Array.isArray(results) ? results : [results])
const reg = (result: TrendResult) => regs(result)[0] ?? null

/** Just the comparison's results. Most of these tests predate the caveat it
 *  now returns alongside them. */
const qr = (
  ...args: Parameters<typeof queryRegressions>
): TrendResult[] => queryRegressions(...args).results

/** A query's stored sample. The argument is the UNCONTENDED p95 — the only
 *  figure the comparison reads — and `uncontendedCalls` the count the gate is
 *  applied to.
 *
 *  The wall-clock fields are deliberately larger on BOTH axes, as a contended
 *  session really records them: more callers than independent observations, and
 *  timings inflated by the queue. Nothing here equals its uncontended
 *  counterpart, so a comparison that read the wall-clock fields instead would
 *  come out with different numbers and these tests would fail rather than pass
 *  by coincidence. */
const q = (p95Ms: number, uncontendedCalls = 100) => ({
  calls: uncontendedCalls * 10 + 50,
  p50Ms: p95Ms * 5,
  p95Ms: p95Ms * 10,
  totalMs: p95Ms * 10 * (uncontendedCalls * 10 + 50),
  uncontended: { calls: uncontendedCalls, p50Ms: p95Ms / 2, p95Ms },
})

/** A query observed plenty of times but never once with the pool to itself —
 *  also the shape of every record written before the recorder measured it. */
const noUncontendedSamples = (p95Ms: number, calls = 100) =>
  ({ calls, p50Ms: p95Ms / 2, p95Ms, totalMs: p95Ms * calls })

const sample = (over: Partial<InteractionComparable> = {}): InteractionComparable => ({
  writes: MIN_FANOUT_WRITES,
  queries: { 'backlinks.forBlock': q(10) },
  fanout: { loaderRuns: MIN_FANOUT_WRITES / 2 },
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

/** Upper half of the UNCONTENDED window collapsed to one value. `q` above
 *  never produces that shape (p50 is half of p95), and the wall-clock half here
 *  stays spread so the caveat cannot pass by reading the wrong one. */
const clustered = (ms: number, uncontendedCalls = 100) => ({
  ...q(ms, uncontendedCalls),
  uncontended: { calls: uncontendedCalls, p50Ms: ms, p95Ms: ms },
})

describe('hasClusteredTail', () => {
  it('spots a collapsed upper half', () => {
    expect(hasClusteredTail(clustered(600).uncontended)).toBe(true)
  })

  it('leaves a spread distribution alone', () => {
    expect(hasClusteredTail(q(600).uncontended)).toBe(false)
  })

  it('does not flag a uniformly fast query', () => {
    // Below the magnitude floor everything clusters and is judged steady
    // anyway, so flagging it would be noise on every verdict.
    expect(hasClusteredTail(clustered(2).uncontended)).toBe(false)
  })
})

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
    const found = regs(qr(slow(), sinceRegressed(slow, sample)))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      metric: 'query:backlinks.forBlock', baseline: 10, current: 40, ratio: 4,
    })
  })

  // Most sessions leave some query without a comparable sample. Windowed before
  // filtering, one such session among the last two leaves the recent side short
  // and the query unjudged for the next two sessions, however much history it has.
  it('smooths over the latest sessions that sampled the query, skipping ones between them', () => {
    const slow = () => sample({ queries: { 'backlinks.forBlock': q(40) } })
    const unsampled = sample({ queries: { 'backlinks.forBlock': noUncontendedSamples(40) } })
    expect(reg(qr(slow(), [unsampled, slow(), ...history(8, sample)])[0]))
      .toMatchObject({ metric: 'query:backlinks.forBlock', ratio: 4 })
  })

  // A newly mounted surface is not a regression. Reporting one as infinitely
  // regressed is how an alarm teaches its reader to ignore it.
  it('ignores a query with no baseline rather than treating it as regressed', () => {
    const found = regs(qr(sample({ queries: { 'brandNew.query': q(500) } }), history(8, sample)))
    expect(found).toEqual([])
  })

  it('ignores a query too fast to feel, however much it grew', () => {
    const base = () => sample({ queries: { tiny: q(0.1) } })
    expect(regs(qr(sample({ queries: { tiny: q(4) } }), history(8, base)))).toEqual([])
  })

  // The magnitude floor belongs after the recent median. Applied to the live
  // sample alone, one fast session drops a query whose recent window is
  // sustainably regressed — the single-session swing the smoothing exists to
  // prevent, in the healthy direction.
  it('does not let one fast session hide a sustained regression', () => {
    const slow = () => sample({ queries: { 'backlinks.forBlock': q(40) } })
    const base = () => sample({ queries: { 'backlinks.forBlock': q(10) } })
    // The live session recovers below the floor; the two before it did not.
    const found = regs(qr(
      sample({ queries: { 'backlinks.forBlock': q(1) } }),
      [slow(), slow(), ...history(8, base)],
    ))
    expect(found.map((r) => r.metric)).toEqual(['query:backlinks.forBlock'])
    expect(found[0].current).toBe(40)
  })

  it('ignores a query with too few resolves to have a distribution', () => {
    const base = () => sample({ queries: { rare: q(10, 100) } })
    expect(regs(qr(sample({ queries: { rare: q(90, 3) } }), history(8, base)))).toEqual([])
  })

  it('reports nothing until the baseline is long enough to be one', () => {
    const slow = () => sample({ queries: { 'backlinks.forBlock': q(80) } })
    // One history entry is consumed smoothing the current reading, so the
    // baseline the comparison sees is one shorter than the history given.
    expect(
      regs(qr(slow(), sinceRegressed(slow, sample, MIN_BASELINE_SESSIONS))),
    ).toEqual([])
    expect(
      regs(qr(slow(), sinceRegressed(slow, sample, MIN_BASELINE_SESSIONS + 1))),
    ).toHaveLength(1)
  })

  // The cost of smoothing the current reading, stated as a rule: a regression
  // is reported once it is the MAJORITY of the recent window, not on its first
  // session.
  it('does not fire on a single anomalous session', () => {
    const found = regs(qr(
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
    const found = regs(qr(
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
    const at = (n: number) => regs(qr(slow(), sinceRegressed(slow, sample, n - 1)))
    expect(at(MIN_HISTORY_SESSIONS - 1)).toEqual([])
    expect(at(MIN_HISTORY_SESSIONS)).toHaveLength(1)
  })

  it('orders the worst ratio first', () => {
    const base = () => sample({ queries: { a: q(10), b: q(10) } })
    const slow = () => sample({ queries: { a: q(30), b: q(100) } })
    const found = regs(qr(slow(), [slow(), ...history(8, base)]))
    expect(found.map((r) => r.metric)).toEqual(['query:b', 'query:a'])
  })
})

describe('slowestQuery', () => {
  // The trend table charts this. It must be the figure the alarm fires on, or
  // the column moves under a verdict that did not — which is the same fault as
  // charting a rate the comparison never reads.
  it('ranks by the uncontended p95, not the wall-clock one stored beside it', () => {
    // `slow` looks worst on wall-clock (q inflates it 10x over 40 = 400) and is
    // the faster of the two once the queue is taken out.
    const r = { queries: { slow: q(4), steady: q(40, 30) } }
    expect(slowestQuery(r)).toEqual({ name: 'steady', p95Ms: 40 })
  })

  it('ignores a query with no uncontended sample rather than ranking it at zero', () => {
    const r = { queries: { unmeasured: noUncontendedSamples(9000), measured: q(3) } }
    expect(slowestQuery(r)).toEqual({ name: 'measured', p95Ms: 3 })
  })

  it('ignores a query too thinly sampled for the comparison to judge', () => {
    // Presence is not eligibility. A single 500ms resolve would top the table
    // while the verdict compares a different, well-sampled query — the column
    // contradicting the alarm beside it, which is the one thing this must not
    // do. Same threshold, one owner.
    const r = { queries: { oneOff: q(500, 3), trended: q(9) } }
    expect(slowestQuery(r)).toEqual({ name: 'trended', p95Ms: 9 })
  })

  it('reports nothing when no query was ever observed unopposed', () => {
    expect(slowestQuery({ queries: { a: noUncontendedSamples(500) } })).toBeNull()
  })
})

describe('what counts as enough measurements', () => {
  // The defect this whole comparison was rebuilt around: `calls` counts
  // CALLERS. N of them awaiting one coalesced statement each record that
  // statement's whole wall-clock, so a plain call count says twenty
  // measurements where there was one. The gate is applied to the resolves that
  // ran with the pool to themselves, which coalesced callers never are.
  // Through `sinceRegressed`, so the gate is the ONLY thing standing between
  // these and a reported regression. Against a history that is merely fast, the
  // recent window's median suppresses a single slow session on its own — and
  // the test then stays green with the gate deleted, proving nothing.
  it('does not judge a query whose callers outnumber its independent observations', () => {
    const base = () => sample({ queries: { 'core.ancestors': q(10) } })
    const busy = () => sample({ queries: { 'core.ancestors': q(90, 3) } })
    expect(regs(qr(busy(), sinceRegressed(busy, base)))).toEqual([])
  })

  it('does not judge a query never observed with the pool to itself', () => {
    // Also every record written before the recorder measured this: a missing
    // subset is "not measured", never "measured as fast".
    const base = () => sample({ queries: { slow: q(10) } })
    const current = () => sample({ queries: { slow: noUncontendedSamples(900) } })
    expect(regs(qr(current(), sinceRegressed(current, base)))).toEqual([])
  })

  it('judges one whose uncontended samples clear the bar', () => {
    const base = () => sample({ queries: { slow: q(10) } })
    const slow = () => sample({ queries: { slow: q(40) } })
    // Through `sinceRegressed` like the other trend tests: the recent reading
    // is a median over a window, so one session never swings it.
    const found = regs(qr(slow(), sinceRegressed(slow, base)))
    expect(found).toHaveLength(1)
    // Reported as the uncontended figure, not the wall-clock one the same
    // sample also carries.
    expect(found[0].current).toBe(40)
    expect(found[0].label).toBe('slow p95 (uncontended)')
  })
})

describe('the clustered-tail caveat', () => {
  const spread = () => sample({ queries: { 'core.ancestors': q(300) } })
  const caveat = (...args: Parameters<typeof queryRegressions>): string[] =>
    queryRegressions(...args).clusteredTail

  it('names a judged metric whose tail collapsed', () => {
    expect(caveat(sample({
      queries: { 'core.ancestors': clustered(600), 'core.childIds': q(300) },
    }), history(8, spread))).toEqual(['core.ancestors'])
  })

  it('reports a baseline the comparison rests on after the live sample recovers', () => {
    // Coalescing stopped, so today's reading is spread — but the collapsed
    // sessions are still in the baseline setting the bar.
    expect(caveat(spread(), [
      spread(), spread(),
      ...history(8, () => sample({ queries: { 'core.ancestors': clustered(600) } })),
    ])).toEqual(['core.ancestors'])
  })

  it('says nothing about a query whose comparison reached no verdict', () => {
    // Enough live calls to be walked, nowhere near enough history to judge.
    // Qualifying a trend that was never produced points the reader at nothing.
    const results = queryRegressions(
      sample({ queries: { 'core.ancestors': clustered(600) } }),
      history(2, spread),
    )
    expect(results.results.every((r) => r.status === 'insufficient')).toBe(true)
    expect(results.clusteredTail).toEqual([])
  })

  it('ignores a query too thin to be walked at all', () => {
    expect(caveat(
      sample({ queries: { 'core.ancestors': clustered(600, 3) } }),
      history(8, () => sample({ queries: { 'core.ancestors': clustered(600) } })),
    )).toEqual([])
  })

  it('ignores a collapsed historical sample too thin to enter a window', () => {
    expect(caveat(
      spread(),
      history(8, () => sample({ queries: { 'core.ancestors': clustered(600, 3) } })),
    )).toEqual([])
  })

  it('stays quiet when every consumed session is spread', () => {
    expect(caveat(spread(), history(8, spread))).toEqual([])
  })

  it('still COMPARES a clustered metric rather than discarding it', () => {
    const slow = () => sample({ queries: { 'core.ancestors': clustered(600) } })
    const found = regs(qr(slow(), [
      slow(), slow(),
      ...history(8, () => sample({ queries: { 'core.ancestors': q(10) } })),
    ]))
    expect(found).toHaveLength(1)
    expect(found[0].metric).toBe('query:core.ancestors')
  })
})

describe('fanoutRegression', () => {
  /** A session re-resolving `perWrite` loaders per write, over `writes` writes. */
  const rate = (perWrite: number, writes = MIN_FANOUT_WRITES) => () =>
    sample({ writes, fanout: { loaderRuns: perWrite * writes } })

  // The signal for an over-broad invalidation dep: every resolve stays fast, so
  // no latency metric moves -- there are simply many times more of them.
  it('flags a rise in re-resolves per write even with unchanged latencies', () => {
    const now = rate(4)
    expect(reg(fanoutRegression(now(), sinceRegressed(now, rate(0.5))))).toMatchObject({
      metric: 'fanout:reResolvesPerWrite', baseline: 0.5, current: 4, ratio: 8,
    })
  })

  // An invalidation landing on a handle nobody subscribes to marks it stale and
  // runs nothing. How many such handles are alive moves with what the session
  // did, not with the code, so counting them fired on sessions whose re-resolves
  // had barely moved.
  it('does not count invalidations that re-resolved nothing', () => {
    const writes = MIN_FANOUT_WRITES
    const base = () => sample({ writes, fanout: {
      loaderRuns: writes, loaderInvalidations: writes, loaderInvalidationsDeferred: 0,
    } })
    const now = () => sample({ writes, fanout: {
      loaderRuns: writes, loaderInvalidations: 8 * writes, loaderInvalidationsDeferred: 7 * writes,
    } })
    expect(fanoutRegression(now(), sinceRegressed(now, base)).status).toBe('steady')
  })

  // A write landing on a load already in flight only queues a rerun, which the
  // load's settle then runs or drops by who is subscribed THEN — a long
  // imperative read with nobody listening drops every one. Counting them reads
  // those reads as fan-out.
  it('does not count a rerun a write only queued behind a load in flight', () => {
    const writes = MIN_FANOUT_WRITES
    const now = () => sample({ writes, fanout: { loaderRuns: writes, midLoadInvalidations: 8 * writes } })
    expect(fanoutRegression(now(), sinceRegressed(now, rate(1))).status).toBe('steady')
  })

  it('reports nothing for a session that has not written', () => {
    expect(reg(fanoutRegression(sample({ writes: 0 }), history(8, sample)))).toBeNull()
  })

  // A handful of writes is not a rate, and an idle session's writes sit at a
  // different rate from an editing session's. Judging one against the other
  // measures which kind of session it was.
  it('waits for this session to write enough before judging it', () => {
    const light = rate(4, MIN_FANOUT_WRITES - 1)
    expect(fanoutRegression(light(), sinceRegressed(rate(4), rate(0.5))))
      .toEqual({ status: 'insufficient', reason: 'no-current-sample' })
  })

  // The alarm this exists to stop: a baseline half made of idle sessions has a
  // median set by how many of them it holds, so a run of editing sessions read
  // as a regression against it.
  it('leaves sessions too light to judge out of the baseline', () => {
    const editing = rate(1)
    const idle = rate(0.1, MIN_FANOUT_WRITES - 1)
    const result = fanoutRegression(editing(), [
      editing(), editing(), ...history(6, idle), ...history(MIN_BASELINE_SESSIONS, editing),
    ])
    expect(result).toEqual({ status: 'steady', baselineCount: MIN_BASELINE_SESSIONS })
  })

  // Idle sessions are about half of a real history. Windowed before filtering,
  // one of them among the last two voids the recent side, and the metric goes
  // unjudged for the next two sessions each time.
  it('smooths over the latest judgeable sessions, skipping light ones between them', () => {
    const now = rate(4)
    const idle = rate(4, MIN_FANOUT_WRITES - 1)
    expect(reg(fanoutRegression(now(), [idle(), now(), ...history(8, rate(0.5))])))
      .toMatchObject({ metric: 'fanout:reResolvesPerWrite', ratio: 8 })
  })

  // No ratio exists against a zero baseline; reporting one as infinite would
  // turn "this has always been zero" into the loudest possible finding.
  it('treats an unchanged zero as unchanged, not as an infinite regression', () => {
    const zero = rate(0)
    expect(fanoutRegression(zero(), history(10, zero)).status).toBe('steady')
  })

  // The other way to reach a zero baseline is the dangerous one: `steady` is a
  // positive health claim, so reporting it here would let the chip certify an
  // arbitrarily large move from nothing as "no slowdowns".
  it('will not certify a move from a zero baseline as healthy', () => {
    const now = rate(60)
    const result = fanoutRegression(now(), [now(), now(), ...history(8, rate(0))])
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

  // Same rule as the interaction comparisons: a past boot hidden until paint
  // has no gap, and must not void the recent window for the boots after it.
  it('smooths over the latest boots with a gap, skipping ones without', () => {
    const hidden = { recordedAt: 0, timeOriginMs: THIS_BOOT - 1 } as StartupRecordData
    expect(reg(startupRegression([hidden, ...stepped(10)], gap(5000))))
      .toMatchObject({ metric: 'startup:bootstrapGapMs' })
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
    const results = qr(quiet, history(20, () => sample({
      queries: { 'backlinks.forBlock': q(40) },
    })))

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ status: 'insufficient' })
    expect(partlyJudged([...results, { status: 'steady', baselineCount: 12 }])).toBe(true)
  })

  // The expected report for a query that only runs inside a fan-out, not a
  // fault — and saying "no usable measurement this session" about a session
  // that measured hundreds of resolves sends a reader to look for a recorder
  // that is working fine.
  // The dangerous shape is not "nothing was judged" — that is visibly empty.
  // It is one query judged BESIDE one that could not be, which looks like an
  // answer: with the judged query steady the verdict reads as a complete clean
  // comparison, and with nothing left awaiting a sample the monitor stops
  // rechecking for the rest of the session. The unjudged query is exactly where
  // a regression would be hiding.
  it('reports a skipped query even when another one was judged', () => {
    const base = () => sample({ queries: { steady: q(10), fanout: q(10) } })
    const now = sample({ queries: { steady: q(10), fanout: noUncontendedSamples(900) } })
    const results = qr(now, history(20, base))

    expect(partlyJudged(results)).toBe(true)
    expect(awaitingCurrentSample(results)).toBe(true)
    expect(results.some((r) => r.status === 'steady')).toBe(true)
    expect(results.some((r) => r.status === 'insufficient')).toBe(true)
  })

  // "Never" describes the SESSION, so it has to be read off the whole session.
  // A query with clean samples but too little history to judge still ran with
  // the database free; saying never beside it is simply false.
  it('does not claim never when a judged-eligible query did run cleanly', () => {
    const thin = history(2, () => sample({ queries: { fresh: q(10), fanout: q(10) } }))
    const now = sample({ queries: { fresh: q(10), fanout: noUncontendedSamples(900) } })
    const results = qr(now, thin)

    expect(results.every((r) => r.status === 'insufficient')).toBe(true)
    expect(results.some((r) => r.status === 'insufficient' && r.reason === 'never-uncontended'))
      .toBe(false)
  })

  // "Never" is a stronger claim than "not yet". A session holding a few clean
  // resolves that fall short of the threshold is still accumulating, and
  // telling the user those queries never ran with the database free is simply
  // false — they did.
  it('does not call a thin set of clean samples a never', () => {
    const history20 = history(20, () => sample({ queries: { 'core.ancestors': q(40) } }))
    const thin = sample({ queries: { 'core.ancestors': q(600, 3) } })
    expect(qr(thin, history20)[0]).toEqual({ status: 'insufficient', reason: 'no-current-sample' })
  })

  it('separates "measured, never with the database free" from "measured nothing"', () => {
    const history20 = history(20, () => sample({ queries: { 'core.ancestors': q(40) } }))
    const busy = sample({ queries: { 'core.ancestors': noUncontendedSamples(600) } })
    expect(qr(busy, history20)[0]).toEqual({ status: 'insufficient', reason: 'never-uncontended' })

    const silent = sample({ queries: {} })
    expect(qr(silent, history20)[0]).toEqual({ status: 'insufficient', reason: 'no-current-sample' })
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

