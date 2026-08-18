// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createGraphBackfillClaim, decideClaim, type GraphBackfillClaim } from './graphBackfillClaim'

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

describe('tryClaim and the sync-settled gate', () => {
  /** A gate shaped like the real `onSyncSettled`: it registers a listener and
   *  hands back a disposer that CANCELS it. The test gates elsewhere return a
   *  no-op disposer, which is why they could not catch a caller that disposes
   *  eagerly. */
  const cancellableGate = () => {
    let cancelled = false
    let pending: (() => void) | null = null
    return {
      gate: (cb: () => void) => { pending = cb; return () => { cancelled = true } },
      settle: () => { if (!cancelled && pending) pending() },
      wasCancelled: () => cancelled,
      isRegistered: () => pending !== null,
    }
  }

  /** Minimal in-memory stand-in for the block store the claim reads/writes. */
  const fakeDeps = (gate: (cb: () => void) => () => void, claimantId: string) => {
    const rows = new Map<string, Record<string, unknown>>()
    return {
      db: {
        getOptional: async <T,>(_sql: string, params?: unknown[]): Promise<T | null> => {
          const row = rows.get(String(params?.[0]))
          return (row ? {properties_json: JSON.stringify(row)} : null) as T | null
        },
      },
      tx: async <R,>(fn: (tx: never) => Promise<R>): Promise<R> => fn({
        get: async (id: string) => (rows.has(id) ? {properties: rows.get(id)!} : null),
        create: async (input: {id: string; properties: Record<string, unknown>}) => {
          rows.set(input.id, input.properties); return input.id
        },
        update: async () => undefined,
        delete: async () => undefined,
      } as never),
      syncSettled: gate,
      claimantId,
      ensureHome: async () => undefined,
    }
  }

  it('keeps the settle listener alive instead of disposing it before it fires', async () => {
    const g = cancellableGate()
    const claim = createGraphBackfillClaim(
      fakeDeps(g.gate, 'device-a') as unknown as Parameters<typeof createGraphBackfillClaim>[0],
    )

    const pending = claim.tryClaim('ws', 'probe-v1')
    // Fence on the observable precondition rather than a fixed number of
    // ticks: `tryClaim` awaits ensureHome, a read and a write before it ever
    // reaches the gate.
    for (let i = 0; i < 100 && !g.isRegistered(); i++) await Promise.resolve()
    expect(g.isRegistered()).toBe(true)

    // The bug this pins: disposing here unregisters the listener, so the
    // callback can never fire and `tryClaim` hangs for the session — while
    // the claim it just wrote makes every other device back off.
    expect(g.wasCancelled()).toBe(false)

    g.settle()
    await expect(pending).resolves.toBe(true)
  }, 10_000)
})
