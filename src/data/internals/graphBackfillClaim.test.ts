// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { decideClaim, type GraphBackfillClaim } from './graphBackfillClaim'

const ME = 'device-a'
const THEM = 'device-b'
const inFlight = (claimantId: string): GraphBackfillClaim =>
  ({claimantId, claimedAt: 1000})

describe('decideClaim', () => {
  it('claims when nothing has been written yet', () => {
    expect(decideClaim(null, ME)).toBe('claim')
  })

  it('proceeds when the settled claim names us, and backs off when it names another device', () => {
    expect(decideClaim(inFlight(ME), ME)).toBe('proceed')
    expect(decideClaim(inFlight(THEM), ME)).toBe('back-off')
  })

  it('never re-runs a completed pass — including for the device that ran it', () => {
    // The device that completed the pass still sees its OWN id in the claim
    // on every later workspace open. Reading ownership before completion
    // would have it redo ~650k creates each time.
    const done: GraphBackfillClaim = {claimantId: ME, claimedAt: 1000, completedAt: 2000}
    expect(decideClaim(done, ME)).toBe('already-complete')
    expect(decideClaim(done, THEM)).toBe('already-complete')
  })
})
