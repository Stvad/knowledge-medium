// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { claimFromProperties, createGraphBackfillClaim, decideClaim, type GraphBackfillClaim } from './graphBackfillClaim'

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

describe('a live row that is not a decodable claim', () => {
  it('is repaired rather than treated as a peer claim', () => {
    // The wedge this pins: such a row reads as UNCLAIMED to every reader
    // (`claimFromProperties` -> null), so yielding to it on mere existence
    // left the post-settle read unclaimed too and `tryClaim` returned false
    // on every future open.
    expect(claimFromProperties({})).toBeNull()
    expect(claimFromProperties({'migration:claimant': 'device-a'})).toBeNull()
    expect(claimFromProperties({'migration:claimed-at': 1000})).toBeNull()
    // A well-formed one still decodes, so a genuine peer claim is preserved.
    expect(claimFromProperties({
      'migration:claimant': 'device-a', 'migration:claimed-at': 1000,
    })).toEqual({claimantId: 'device-a', claimedAt: 1000})
  })
})

describe('a claim that arrives between the read and the transaction', () => {
  it('is honoured — tryClaim returns false rather than running anyway', async () => {
    // The interleaving: the pre-read sees nothing, so we decide to claim; by
    // the time the writing tx holds the row, a peer's claim has landed. The
    // tx correctly declines to overwrite it — and the CALLER has to be told,
    // or it runs a migration it just watched someone else take.
    const peerClaim = {
      'migration:claimant': 'device-peer',
      'migration:claimed-at': 1000,
    }
    const claim = createGraphBackfillClaim({
      // Pre-read: unclaimed.
      db: {getOptional: async () => null},
      // In-tx: the peer's claim is already there.
      tx: async <R,>(fn: (tx: never) => Promise<R>): Promise<R> => fn({
        get: async () => ({deleted: false, properties: peerClaim}),
        create: async () => 'unused',
        update: async () => undefined,
        delete: async () => undefined,
        restore: async () => undefined,
      } as never),
      claimantId: 'device-a',
      ensureHome: async () => undefined,
    } as unknown as Parameters<typeof createGraphBackfillClaim>[0])

    expect(await claim.tryClaim('ws', 'race-v1')).toBe(false)
  })
})
