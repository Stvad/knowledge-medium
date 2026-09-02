// @vitest-environment node
/**
 * Publication ordering. The cadenced pass and the trend view's manual refresh
 * are not serialised, so the two can be in flight together and finish in either
 * order.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { analysisFixture as analysis } from './fixtures'
import { clearPerfAnalyses, getPerfAnalysisFor, nextAnalysisSeq, publishPerfAnalysis, resetPerfAnalysisStore, subscribePerfAnalysis } from '../store'
import { perfAnalysisEffect, resetPerfSchedulingState } from '../schedule'

afterEach(() => { resetPerfAnalysisStore(); resetPerfSchedulingState() })

describe('publishPerfAnalysis', () => {
  // Ordered on a sequence, not the wall clock: two runs starting in the same
  // millisecond share an `analyzedAt` and a strict `>` lets the older win.
  it('keeps the verdict from the run that started most recently', () => {
    publishPerfAnalysis(analysis({ seq: 2, analyzedAt: 2000, baseline: { interaction: 9, startup: 9 } }))
    // The older run resuming after its history reads — it has nothing newer to
    // say, and the chip would carry its verdict until the next scheduled pass.
    publishPerfAnalysis(analysis({ seq: 1, analyzedAt: 1000, baseline: { interaction: 1, startup: 1 } }))

    expect(getPerfAnalysisFor('ws-1')?.analyzedAt).toBe(2000)
  })

  it('orders runs that share a millisecond', () => {
    publishPerfAnalysis(analysis({ seq: 2, analyzedAt: 1000, baseline: { interaction: 9, startup: 9 } }))
    publishPerfAnalysis(analysis({ seq: 1, analyzedAt: 1000, baseline: { interaction: 1, startup: 1 } }))
    expect(getPerfAnalysisFor('ws-1')?.baseline.interaction).toBe(9)
  })

  it('publishes a newer run over an older one', () => {
    publishPerfAnalysis(analysis({ seq: 1, analyzedAt: 1000 }))
    publishPerfAnalysis(analysis({ seq: 2, analyzedAt: 2000 }))
    expect(getPerfAnalysisFor('ws-1')?.analyzedAt).toBe(2000)
  })

  // The sequence is allocated when a run STARTS, not when it returns, so a run
  // that begins first and finishes last cannot overwrite a fresher verdict.
  it('allocates the sequence before its asynchronous work', async () => {
    const seqs: number[] = []
    const slow = (async () => { seqs.push(nextAnalysisSeq()); await Promise.resolve() })()
    const fast = (async () => { seqs.push(nextAnalysisSeq()) })()
    await Promise.all([slow, fast])
    expect(seqs[0]).toBeLessThan(seqs[1])
  })

  // Ordering is per workspace: an older run for one must not veto the first
  // publication for another, which has no verdict at all to keep.
  it('does not let one workspace\'s ordering block another', () => {
    publishPerfAnalysis(analysis({ seq: 2, analyzedAt: 2000 }))
    publishPerfAnalysis(analysis({ workspaceId: 'ws-2', seq: 1, analyzedAt: 1000 }))
    expect(getPerfAnalysisFor('ws-2')?.analyzedAt).toBe(1000)
  })
})

/**
 * A Repo swap invalidates the VERDICTS, not the components reading them.
 *
 * The chip and the trend dialog subscribe through `useSyncExternalStore`, which
 * re-subscribes only when the `subscribe` identity changes — and this one is
 * module-stable. So a listener dropped here is dropped for the life of the
 * page: no remount, no notification, ever again. The store therefore has two
 * clears, and only the test one may touch listeners.
 */
describe('a Repo swap', () => {
  // The effect arms an idle job; left running it would fire against these stubs
  // after the test that made them has finished.
  const stops: Array<() => void> = []
  afterEach(() => { while (stops.length) stops.pop()?.() })

  const repoStub = () => ({
    activeWorkspaceId: 'ws-1',
    isReadOnly: false,
    metrics: () => ({ epoch: 0, epochWorkspaceId: null }),
  })
  const startFor = async (repo: object, workspaceId = 'ws-1') => {
    const stop = await perfAnalysisEffect.start({ repo, workspaceId } as Parameters<
      typeof perfAnalysisEffect.start
    >[0])
    if (stop) stops.push(stop)
  }

  it('drops the stale verdicts', async () => {
    await startFor(repoStub())
    publishPerfAnalysis(analysis({ seq: 1 }))
    expect(getPerfAnalysisFor('ws-1')).not.toBeNull()

    await startFor(repoStub())

    expect(getPerfAnalysisFor('ws-1')).toBeNull()
  })

  it('keeps the subscribers, and tells them to re-read', async () => {
    await startFor(repoStub())

    let notified = 0
    subscribePerfAnalysis(() => { notified++ })

    // The swap itself is a change the subscriber has to hear about: what it was
    // showing is gone.
    await startFor(repoStub())
    expect(notified).toBe(1)

    // ...and it is still attached for everything after.
    publishPerfAnalysis(analysis({ seq: 5 }))
    expect(notified).toBe(2)
  })

  // Guards the distinction itself: if `clearSnapshots` ever grows a
  // `listeners.clear()`, the test above still passes on its first assertion.
  it('is not what the test-only reset does', () => {
    let notified = 0
    subscribePerfAnalysis(() => { notified++ })
    clearPerfAnalyses()
    expect(notified).toBe(1)

    resetPerfAnalysisStore()
    publishPerfAnalysis(analysis({ seq: 9 }))
    expect(notified).toBe(1)
  })
})

/**
 * A workspace change invalidates the verdicts too, not only a Repo swap.
 *
 * The counters a verdict rests on are page-global: once the page has been in a
 * second workspace they are no longer attributable to the first, so the cached
 * verdict describes a comparison that would no longer be made. `A→B→A` would
 * otherwise present it again immediately, since the Repo never changed.
 */
describe('a workspace change', () => {
  const stops: Array<() => void> = []
  afterEach(() => { while (stops.length) stops.pop()?.() })

  const repoStub = (activeWorkspaceId: string) => ({
    activeWorkspaceId,
    isReadOnly: false,
    metrics: () => ({ epoch: 0, epochWorkspaceId: null }),
  })
  const startFor = async (repo: object, workspaceId: string) => {
    const stop = await perfAnalysisEffect.start({ repo, workspaceId } as Parameters<
      typeof perfAnalysisEffect.start
    >[0])
    if (stop) stops.push(stop)
  }

  it('drops the verdict cached for the workspace it left', async () => {
    const repo = repoStub('ws-1')
    await startFor(repo, 'ws-1')
    publishPerfAnalysis(analysis({ seq: 1 }))
    expect(getPerfAnalysisFor('ws-1')).not.toBeNull()

    // Same Repo — only the workspace moved.
    repo.activeWorkspaceId = 'ws-2'
    await startFor(repo, 'ws-2')

    expect(getPerfAnalysisFor('ws-1')).toBeNull()
  })
})
