// @vitest-environment node
/**
 * Publication ordering. The cadenced pass and the trend view's manual refresh
 * are not serialised, so the two can be in flight together and finish in either
 * order.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { analysisFixture as analysis } from './fixtures'
import { getPerfAnalysisFor, publishPerfAnalysis, resetPerfAnalysisStore } from '../store'

afterEach(() => { resetPerfAnalysisStore() })

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

  // Ordering is per workspace: an older run for one must not veto the first
  // publication for another, which has no verdict at all to keep.
  it('does not let one workspace\'s ordering block another', () => {
    publishPerfAnalysis(analysis({ seq: 2, analyzedAt: 2000 }))
    publishPerfAnalysis(analysis({ workspaceId: 'ws-2', seq: 1, analyzedAt: 1000 }))
    expect(getPerfAnalysisFor('ws-2')?.analyzedAt).toBe(1000)
  })
})
