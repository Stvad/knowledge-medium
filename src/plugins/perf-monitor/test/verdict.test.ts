// @vitest-environment node
/**
 * The single statement both surfaces render. The cases here are the ones where
 * an empty regression list means opposite things.
 */
import { describe, expect, it } from 'vitest'
import type { PerfAnalysis } from '../analyze'
import { summarize } from '../verdict'

const analysis = (over: Partial<PerfAnalysis> = {}): PerfAnalysis => ({
  workspaceId: 'ws-1',
  analyzedAt: 1000,
  baselineSessions: 12,
  regressions: [],
  insufficientHistory: false,
  ready: { interaction: true, startup: true },
  interactionComparable: true,
  graphGrowth: null,
  ...over,
})

const regression = (over = {}) => ({
  metric: 'query:backlinks.forBlock',
  label: 'backlinks.forBlock p95',
  baseline: 10, current: 40, ratio: 4, unit: 'ms' as const,
  ...over,
})

describe('summarize', () => {
  it('calls a fully judged, unregressed comparison clean', () => {
    const v = summarize(analysis())
    expect(v.kind).toBe('clean')
    expect(v.headline).toBe('No slowdowns vs baseline')
  })

  // The day-one state for every existing user: startup history, no interaction
  // history. An empty regression list here is not a clean bill of health.
  it('does not call a partial comparison clean', () => {
    const v = summarize(analysis({ ready: { interaction: false, startup: true } }))
    expect(v.kind).toBe('pending')
    expect(v.notes.join(' ')).toContain('interaction history still building')
  })

  // Waiting fixes one of these and not the other, so they are not one message.
  it('separates a series still filling from counters it can never compare', () => {
    const blended = summarize(analysis({ interactionComparable: false }))
    expect(blended.notes.join(' ')).toContain('more than one workspace')
    expect(blended.notes.join(' ')).not.toContain('interaction history still building')
  })

  it('leads with the worst regression and keeps the graph-growth context', () => {
    const v = summarize(analysis({
      regressions: [regression({ ratio: 9 }), regression({ metric: 'query:other', ratio: 3 })],
      graphGrowth: 1.4,
    }))
    expect(v.kind).toBe('regressed')
    expect(v.headline).toContain('9×')
    expect(v.notes.join(' ')).toContain('40% larger')
  })
})
