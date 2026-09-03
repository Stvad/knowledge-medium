// @vitest-environment node
/**
 * The single statement both surfaces render. The cases here are the ones where
 * an empty regression list means opposite things.
 */
import { describe, expect, it } from 'vitest'
import { analysisFixture as analysis, regressionFixture as regression } from './fixtures'
import { summarize as summarizeWith } from '../verdict'

/** Most of these are about the COMPARISON, not the environment, so the live
 *  facts default to "recording is fine" and the two tests that care pass their
 *  own. */
const summarize = (
  analysis: Parameters<typeof summarizeWith>[0],
  live: Parameters<typeof summarizeWith>[1] = { blockedBy: null },
) => summarizeWith(analysis, live)




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

  // The interaction recorder is togglable independently of the monitor, so its
  // series can be permanently short while everything else looks healthy.
  // "Still building" is then a remedy that never arrives.
  it('says an interaction series is not filling rather than still building', () => {
    const v = summarize(analysis({
      ready: { interaction: false, startup: true },
      interactionAwaitingCurrentSample: true,
    }))
    expect(v.notes.join(' ')).toContain('interaction recording may be off')
    expect(v.notes.join(' ')).not.toContain('interaction history still building')
  })

  // Both series unjudged for want of their CURRENT sample, with plenty of
  // history on disk. "Building a baseline" would point at the one thing that is
  // not the problem, next to a note reporting a healthy count.
  it('does not call an unrecorded session a building baseline', () => {
    const v = summarize(analysis({
      ready: { interaction: false, startup: false },
      interactionAwaitingCurrentSample: true,
      startupAwaitingCurrentSample: true,
      recorded: { interaction: 40, startup: 40 },
    }))
    expect(v.kind).toBe('pending')
    expect(v.headline).not.toBe('Building a baseline')
    expect(v.notes.join(' ')).toContain('40 interaction and 40 startup sessions recorded')
  })

  // ...and it still says so when a series really is just short of history.
  it('calls a genuinely short history a building baseline', () => {
    const v = summarize(analysis({
      ready: { interaction: false, startup: false },
      interactionAwaitingCurrentSample: false,
      startupAwaitingCurrentSample: false,
      recorded: { interaction: 2, startup: 2 },
    }))
    expect(v.headline).toBe('Building a baseline')
  })

  // "Still building" promises something that will never arrive when no recorder
  // can write in this environment at all.
  it('reports a blocked environment as disabled, not as still building', () => {
    const v = summarize(
      analysis({ ready: { interaction: false, startup: false } }),
      { blockedBy: 'no-persistent-client' },
    )
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
    expect(v.notes.join(' ')).toContain('14 recent startup sessions')
    expect(v.notes.join(' ')).not.toContain('0 recent')
  })

  // Both series were judged, and they fill independently against their own
  // windows. One bare number here is the other series' count misreported as
  // this one's.
  it('reports both counts, labelled, when both series were judged', () => {
    const v = summarize(analysis({
      ready: { interaction: true, startup: true },
      baseline: { interaction: 7, startup: 31 },
    })).notes.join(' ')
    expect(v).toContain('7 interaction')
    expect(v).toContain('31 startup')
  })

  // A bare count says nothing about WHICH series is missing, or that one of
  // them can never fill this session.
  it('keeps the explanation when it says it is building a baseline', () => {
    const v = summarize(analysis({
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
    const v = summarize(
      analysis({ regressions: [regression({ ratio: 6 })] }),
      { blockedBy: 'read-only-workspace' },
    )
    expect(v.kind).toBe('regressed')
    expect(v.regressions).toHaveLength(1)
    expect(v.notes.join(' ')).toContain('not being recorded')
  })

  // Read-only stops new samples; it does not invalidate a comparison that just
  // ran cleanly against history already on disk.
  it('keeps a clean verdict when only recording is blocked', () => {
    const v = summarize(analysis(), { blockedBy: 'read-only-workspace' })
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

/**
 * "Still building" is a promise that waiting will resolve it. When this session
 * simply contributed no startup record — the recorder is independently
 * togglable — no amount of history helps, and the chip would send the user to
 * wait for something that is never coming.
 */
describe('an unjudged startup series', () => {
  const startupUnjudged = (over: Parameters<typeof analysis>[0]) =>
    summarize(analysis({ ready: { interaction: true, startup: false }, ...over }))

  it('says history is building when that is what is happening', () => {
    expect(startupUnjudged({}).notes.join(' ')).toContain('startup history still building')
  })

  it('names the missing current sample instead, when waiting cannot help', () => {
    const notes = startupUnjudged({ startupAwaitingCurrentSample: true }).notes.join(' ')
    expect(notes).toContain('no startup record for this session')
    expect(notes).not.toContain('still building')
  })
})

/**
 * The pending note counts records ON DISK. Built from `baseline` it would be a
 * constant zero — nothing was judged in this branch, which is what `baseline`
 * measures — while the trend dialog beside it shows the history it was
 * supposedly counted from.
 */
describe('the pending-session count', () => {
  it('reports what is recorded, not what was judged', () => {
    const verdict = summarize(analysis({
      ready: { interaction: false, startup: false },
      baseline: { interaction: 0, startup: 0 },
      recorded: { interaction: 5, startup: 40 },
    }))
    expect(verdict.kind).toBe('pending')
    expect(verdict.notes.join(' ')).toContain('5 interaction and 40 startup sessions recorded so far')
  })
})
