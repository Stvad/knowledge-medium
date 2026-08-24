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
  queryRegressions,
  startupRegression,
  MIN_BASELINE_SESSIONS,
} from '../series'

const q = (p95Ms: number, calls = 100) => ({ calls, p50Ms: p95Ms / 2, p95Ms, totalMs: p95Ms * calls })

const sample = (over: Partial<InteractionComparable> = {}): InteractionComparable => ({
  writes: 100,
  queries: { 'backlinks.forBlock': q(10) },
  fanout: { loaderRuns: 50 },
  ...over,
})

const history = (n: number, s: () => InteractionComparable): InteractionComparable[] =>
  Array.from({ length: n }, s)

describe('median', () => {
  it('averages the middle pair on an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([3, 1, 2])).toBe(2)
    expect(median([])).toBe(0)
  })
})

describe('queryRegressions', () => {
  it('flags a query whose p95 doubled against the trailing median', () => {
    const found = queryRegressions(sample({ queries: { 'backlinks.forBlock': q(40) } }), history(8, sample))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      metric: 'query:backlinks.forBlock', baseline: 10, current: 40, ratio: 4,
    })
  })

  // A newly mounted surface is not a regression. Reporting one as infinitely
  // regressed is how an alarm teaches its reader to ignore it.
  it('ignores a query with no baseline rather than treating it as regressed', () => {
    const found = queryRegressions(sample({ queries: { 'brandNew.query': q(500) } }), history(8, sample))
    expect(found).toEqual([])
  })

  it('ignores a query too fast to feel, however much it grew', () => {
    const base = () => sample({ queries: { tiny: q(0.1) } })
    expect(queryRegressions(sample({ queries: { tiny: q(4) } }), history(8, base))).toEqual([])
  })

  it('ignores a query with too few resolves to have a distribution', () => {
    const base = () => sample({ queries: { rare: q(10, 100) } })
    expect(queryRegressions(sample({ queries: { rare: q(90, 3) } }), history(8, base))).toEqual([])
  })

  it('reports nothing until the baseline is long enough to be one', () => {
    const short = history(MIN_BASELINE_SESSIONS - 1, sample)
    expect(queryRegressions(sample({ queries: { 'backlinks.forBlock': q(80) } }), short)).toEqual([])
    const enough = history(MIN_BASELINE_SESSIONS, sample)
    expect(queryRegressions(sample({ queries: { 'backlinks.forBlock': q(80) } }), enough)).toHaveLength(1)
  })

  it('orders the worst ratio first', () => {
    const base = () => sample({ queries: { a: q(10), b: q(10) } })
    const found = queryRegressions(sample({ queries: { a: q(30), b: q(100) } }), history(8, base))
    expect(found.map((r) => r.metric)).toEqual(['query:b', 'query:a'])
  })
})

describe('fanoutRegression', () => {
  // The signal for an over-broad invalidation dep: every resolve stays fast, so
  // no latency metric moves -- there are simply many times more of them.
  it('flags a rise in re-resolves per write even with unchanged latencies', () => {
    const base = () => sample({ writes: 100, fanout: { loaderRuns: 50 } })
    const now = sample({ writes: 100, fanout: { loaderRuns: 400 } })
    expect(fanoutRegression(now, history(8, base))).toMatchObject({
      metric: 'fanout:loaderRunsPerWrite', baseline: 0.5, current: 4, ratio: 8,
    })
  })

  it('reports nothing for a session that has not written', () => {
    expect(fanoutRegression(sample({ writes: 0 }), history(8, sample))).toBeNull()
  })
})

describe('startupRegression', () => {
  const boot = (repoReadyMs: number, firstContentPaintMs: number): StartupRecordData =>
    ({ recordedAt: 0, appVersion: '', appSha: '', clientId: '', deviceLabel: '', timeOriginMs: 0,
       repoReadyMs, firstContentPaintMs }) as StartupRecordData

  it('measures repo-ready to paint, not time-to-interactive', () => {
    expect(bootstrapGapMs(boot(1000, 1350))).toBe(350)
    expect(bootstrapGapMs({ recordedAt: 0 } as StartupRecordData)).toBeNull()
  })

  // Modelled on the real series: a gap held within ~70ms for three weeks, then
  // stepped to ~5s. TTI over the same window was far noisier.
  it('flags the step in the bootstrap gap', () => {
    const past = Array.from({ length: 8 }, (_, i) => boot(1000, 1320 + i * 10))
    expect(startupRegression(boot(1000, 6000), past)).toMatchObject({
      metric: 'startup:bootstrapGapMs', current: 5000,
    })
  })

  it('stays quiet while the gap holds', () => {
    const past = Array.from({ length: 8 }, (_, i) => boot(1000, 1320 + i * 10))
    expect(startupRegression(boot(1000, 1400), past)).toBeNull()
  })
})
