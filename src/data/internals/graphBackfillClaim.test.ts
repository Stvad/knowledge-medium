// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { claimFromProperties, createGraphBackfillClaim, decideClaim, resolveClaimantId, type GraphBackfillClaim } from './graphBackfillClaim'

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
        get: async () => ({workspaceId: 'ws', deleted: false, properties: peerClaim}),
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

describe('the claimant identity', () => {
  const fakeStorage = (initial: Record<string, string> = {}) => {
    const store = {...initial}
    return {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      store,
    }
  }

  it('survives a reload, so the device that started a pass can resume it', () => {
    // `decideClaim` proceeds only when a live claim names US. A per-session id
    // meant a closed or crashed tab left a claim nobody could match again, and
    // the migration was wedged for the whole graph until someone deleted the
    // block by hand.
    const storage = fakeStorage()
    let n = 0
    const first = resolveClaimantId(storage, () => `id-${++n}`)
    const second = resolveClaimantId(storage, () => `id-${++n}`)

    expect(second).toBe(first)
  })

  it('still yields an id when storage is unavailable', () => {
    const blocked = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    expect(resolveClaimantId(blocked, () => 'fallback')).toBe('fallback')
    expect(resolveClaimantId(undefined, () => 'fallback')).toBe('fallback')
  })
})

describe('an operator reclaiming a completed pass', () => {
  /** A claim row as the DB holds it, with whatever bookkeeping is passed. */
  const claimWith = (properties: Record<string, unknown>) => {
    const updates: Record<string, unknown>[] = []
    const claim = createGraphBackfillClaim({
      db: {getOptional: async () => ({
        id: 'c', workspace_id: 'ws', deleted: 0, properties_json: JSON.stringify(properties),
      })},
      tx: async <R,>(fn: (tx: never) => Promise<R>): Promise<R> => fn({
        get: async () => ({workspaceId: 'ws', deleted: false, properties}),
        create: async () => 'unused',
        update: async (_id: string, patch: {properties?: Record<string, unknown>}) => {
          if (patch.properties) updates.push(patch.properties)
        },
        delete: async () => undefined,
        restore: async () => undefined,
      } as never),
      claimantId: 'device-a',
      ensureHome: async () => undefined,
    } as unknown as Parameters<typeof createGraphBackfillClaim>[0])
    return {claim, updates}
  }

  const completed = {
    'migration:claimant': 'device-b',
    'migration:claimed-at': 1000,
    'migration:completed-at': 2000,
  }
  const running = {'migration:claimant': 'device-b', 'migration:claimed-at': 1000}

  it('replaces the completion stamp with a fresh claim', async () => {
    // Without the overwrite the reclaim is a NO-OP that still reports success
    // to nobody: the completed row decodes as a valid claim, so the in-tx
    // guard returns false and the operator is told "already done" — the exact
    // outcome `reclaimCompleted` exists to prevent. Asserted against the real
    // claim rather than the test-repo stub, which cannot model this.
    const {claim, updates} = claimWith(completed)

    expect(await claim.tryClaim('ws', 'pass-v1', {reclaimCompleted: true})).toBe(true)
    expect(updates).toHaveLength(1)
    expect(updates[0]!['migration:claimant']).toBe('device-a')
    expect(updates[0]!['migration:completed-at']).toBeUndefined()
  })

  it('still refuses a claim someone is holding right now', async () => {
    // Mutual exclusion is the claim's real safety property and is NOT what
    // the flag overrides: a pass in flight elsewhere must not gain a second
    // writer.
    const {claim, updates} = claimWith(running)

    expect(await claim.tryClaim('ws', 'pass-v1', {reclaimCompleted: true})).toBe(false)
    expect(updates).toEqual([])
  })

  it('leaves a completed pass alone when nobody asked to re-run it', async () => {
    const {claim} = claimWith(completed)

    expect(await claim.tryClaim('ws', 'pass-v1')).toBe(false)
  })
})

describe('a foreign block sitting at the claim id', () => {
  const foreignRow = {id: 'x', workspaceId: 'other-ws', deleted: false, properties: {}}

  /** Every write path reaches its row through `tx.get`, which selects on id
   *  alone. All three must refuse a foreign occupant, not just the one that
   *  happened to be written first. */
  const claimOverForeignRow = () => createGraphBackfillClaim({
    db: {getOptional: async () => null},
    tx: async <R,>(fn: (tx: never) => Promise<R>): Promise<R> => fn({
      get: async () => foreignRow,
      create: async () => 'unused',
      update: async () => { throw new Error('must not write to a foreign row') },
      restore: async () => { throw new Error('must not restore a foreign row') },
      delete: async () => { throw new Error('must not delete a foreign row') },
    } as never),
    claimantId: 'device-a',
    ensureHome: async () => undefined,
  } as unknown as Parameters<typeof createGraphBackfillClaim>[0])

  it('markComplete refuses it — the pass ran, but not into someone else\'s data', async () => {
    await expect(claimOverForeignRow().markComplete('ws', 'foreign-v1'))
      .rejects.toThrow(/workspace/i)
  })

  it('releaseClaim refuses it', async () => {
    await expect(claimOverForeignRow().releaseClaim('ws', 'foreign-v1'))
      .rejects.toThrow(/workspace/i)
  })

  it('is refused, not updated — a deterministic id is not a licence to write', async () => {
    // `tx.get` selects on id alone, and the branches below rewrite properties
    // and restore tombstones. On another workspace's block that is a
    // cross-workspace write.
    const claim = createGraphBackfillClaim({
      db: {getOptional: async () => null},
      tx: async <R,>(fn: (tx: never) => Promise<R>): Promise<R> => fn({
        get: async () => foreignRow,
        create: async () => 'unused',
        update: async () => { throw new Error('must not write to a foreign row') },
        restore: async () => { throw new Error('must not restore a foreign row') },
        delete: async () => undefined,
      } as never),
      claimantId: 'device-a',
      ensureHome: async () => undefined,
    } as unknown as Parameters<typeof createGraphBackfillClaim>[0])

    await expect(claim.tryClaim('ws', 'foreign-v1')).rejects.toThrow(/workspace/i)
  })
})

describe('completing a claim that was tombstoned underneath us', () => {
  it('restores it rather than stamping a deleted row', async () => {
    // Two operators on different devices is accepted, so the one that aborts
    // releases the claim they share and its delete can sync in before the
    // survivor completes. Stamping completedAt onto a tombstone records
    // NOTHING — readGraphBackfillClaim filters deleted=0 — so every device
    // still reads unclaimed and the next operator repeats the migration,
    // while this one was told it ran.
    const calls: string[] = []
    const claim = createGraphBackfillClaim({
      db: {getOptional: async () => null},
      tx: async <R,>(fn: (tx: never) => Promise<R>): Promise<R> => fn({
        get: async () => ({workspaceId: 'ws', deleted: true, properties: {}}),
        restore: async () => { calls.push('restore') },
        update: async () => { calls.push('update') },
        create: async () => 'unused',
        delete: async () => undefined,
      } as never),
      claimantId: 'device-a',
      ensureHome: async () => undefined,
    } as unknown as Parameters<typeof createGraphBackfillClaim>[0])

    await claim.markComplete('ws', 'tomb-v1')
    expect(calls).toEqual(['restore', 'update'])
  })

  it('refuses to report completion when the claim block is gone entirely', async () => {
    const claim = createGraphBackfillClaim({
      db: {getOptional: async () => null},
      tx: async <R,>(fn: (tx: never) => Promise<R>): Promise<R> => fn({
        get: async () => null,
        restore: async () => undefined,
        update: async () => undefined,
        create: async () => 'unused',
        delete: async () => undefined,
      } as never),
      claimantId: 'device-a',
      ensureHome: async () => undefined,
    } as unknown as Parameters<typeof createGraphBackfillClaim>[0])

    // Silently succeeding would report "ran" for a migration nothing records.
    await expect(claim.markComplete('ws', 'gone-v1')).rejects.toThrow(/claim block is gone/)
  })
})
