// @vitest-environment node
/**
 * Who sets the loop's cadence.
 *
 * The analysis itself is mocked: what is under test is the wiring between an
 * accepted verdict and the next delay, and driving a real comparison through a
 * real database would say nothing more about it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
import type { PerfComparison } from '../analyze'
import { analysisFixture } from './fixtures'

const loop = { stop: vi.fn(), rearmIn: vi.fn() }
/** The loop body `perfAnalysisEffect` hands to the job. */
let run: (() => Promise<number | void>) | null = null

vi.mock('@/utils/cadencedIdleJob.js', () => ({
  cadencedIdleJob: () => ({
    drain: async () => {},
    start: (body: () => Promise<number | void>) => { run = body; return loop },
  }),
}))
// The session facts a real analysis would consult. None of them is what this
// file is about, and all of them need a live Repo.
vi.mock('@/plugins/interaction-metrics/sessionContext.js', () => ({
  contextHolds: () => true,
  metricsContext: () => ({}),
  observeWorkspace: () => {},
}))
/** One queued result per analysis, so a test can hold one in flight. */
const analyses: Array<Promise<PerfComparison>> = []
vi.mock('../analyze.js', () => ({
  runPerfAnalysis: () =>
    analyses.shift() ?? Promise.reject(new Error('the test queued no analysis')),
}))

const { perfAnalysisEffect, runPerfAnalysisNow } = await import('../schedule')
const { resetPerfAnalysisStore } = await import('../store')

const WS = 'ws-1'
const REANALYZE_MS = 10 * 60_000
const RECHECK_MS = 60_000

const repo = { onMetricsReset: () => () => {} } as unknown as Repo

/** A verdict awaiting a live sample takes the short backoff; one that is not
 *  takes the full cadence. Those are the two delays this file tells apart. */
const verdict = (seq: number, awaiting: boolean): PerfComparison =>
  analysisFixture({
    workspaceId: WS, seq,
    unjudgedBecause: { interaction: awaiting ? 'no-current-sample' : null, startup: null },
  })

let stop: (() => void) | undefined
const startEffect = (): (() => Promise<number | void>) => {
  stop = perfAnalysisEffect.start({ repo, workspaceId: WS }) ?? undefined
  if (run === null) throw new Error('the effect started no loop')
  return run
}

beforeEach(() => { analyses.length = 0; run = null; vi.clearAllMocks() })
afterEach(() => { stop?.(); stop = undefined; resetPerfAnalysisStore() })

describe('the perf analysis cadence', () => {
  it('follows the loop own accepted verdict, not a refresh that landed mid-pass', async () => {
    const loopPass = startEffect()

    // The loop's pass starts and stalls on its analysis.
    let finish = (analysis: PerfComparison): void => { void analysis }
    analyses.push(new Promise<PerfComparison>((resolve) => { finish = resolve }))
    const pending = loopPass()

    // A manual refresh runs to completion while that pass is in flight. Its
    // verdict is older (lower `seq`) and awaits a sample, so it asks to come
    // back soon.
    analyses.push(Promise.resolve(verdict(1, true)))
    await runPerfAnalysisNow(repo, WS)
    expect(loop.rearmIn).toHaveBeenLastCalledWith(RECHECK_MS)

    // Now the loop's own pass finishes with the newer verdict the store accepts.
    finish(verdict(2, false))

    // Returning a delay is not enough: the job discards one from a pass that a
    // re-arm has superseded, which is exactly what the refresh above did.
    expect(await pending).toBeUndefined()
    expect(loop.rearmIn).toHaveBeenLastCalledWith(REANALYZE_MS)
  })

  it('comes back soon after a refused pass rather than adopting its verdict', async () => {
    const loopPass = startEffect()

    // Published first, so the pass below is superseded and the store refuses it.
    analyses.push(Promise.resolve(verdict(5, false)))
    await runPerfAnalysisNow(repo, WS)
    loop.rearmIn.mockClear()

    analyses.push(Promise.resolve(verdict(4, false)))
    expect(await loopPass()).toBe(RECHECK_MS)
    expect(loop.rearmIn).not.toHaveBeenCalled()
  })
})
