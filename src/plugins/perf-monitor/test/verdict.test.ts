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
  recordingBlockedBy: null,
  baseline: { interaction: 12, startup: 12 },
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

  // "Still building" promises something that will never arrive when no recorder
  // can write in this environment at all.
  it('reports a blocked environment as disabled, not as still building', () => {
    const v = summarize(analysis({
      recordingBlockedBy: 'no-persistent-client',
      insufficientHistory: true,
    }))
    expect(v.headline).toBe('Performance history disabled')
    expect(v.notes.join(' ')).toContain('durable client id')
  })

  // The count belongs to the series that was judged; reporting the other one's
  // is how a startup-only verdict claimed "compared against 0 sessions".
  it('reports the baseline count of the series it actually compared', () => {
    const v = summarize(analysis({
      ready: { interaction: false, startup: true },
      baseline: { interaction: 0, startup: 14 },
    }))
    expect(v.notes.join(' ')).toContain('14 recent sessions')
    expect(v.notes.join(' ')).not.toContain('0 recent sessions')
  })

  // Dropping the pending notes for a bare count is how a workspace switch came
  // to read as "building a baseline" for a user with months of history.
  it('keeps the explanation when it says it is building a baseline', () => {
    const v = summarize(analysis({
      insufficientHistory: true,
      interactionComparable: false,
      ready: { interaction: false, startup: false },
      baseline: { interaction: 20, startup: 0 },
    }))
    expect(v.headline).toBe('Building a baseline')
    expect(v.notes.join(' ')).toContain('more than one workspace')
  })

  // Blocked recording stops the series GROWING; it does not invalidate history
  // already on disk or this session's own counters, so a real finding against
  // them must survive.
  it('still reports a regression when recording is disabled', () => {
    const v = summarize(analysis({
      recordingBlockedBy: 'read-only-workspace',
      regressions: [regression({ ratio: 6 })],
    }))
    expect(v.kind).toBe('regressed')
    expect(v.regressions).toHaveLength(1)
    expect(v.notes.join(' ')).toContain('not being recorded')
  })

  // Read-only stops new samples; it does not invalidate a comparison that just
  // ran cleanly against history already on disk.
  it('keeps a clean verdict when only recording is blocked', () => {
    const v = summarize(analysis({ recordingBlockedBy: 'read-only-workspace' }))
    expect(v.kind).toBe('clean')
    expect(v.headline).toBe('No slowdowns vs baseline')
    expect(v.notes.join(' ')).toContain('not being recorded')
  })

  // A rate that went up is not "slower", and the rate is the metric this
  // feature exists to catch.
  it('says a rate got higher, not slower', () => {
    const v = summarize(analysis({
      regressions: [regression({ label: 'handle invalidations per write', unit: 'ratio', ratio: 4 })],
    }))
    expect(v.headline).toContain('higher than baseline')
    expect(v.headline).not.toContain('slower')
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
