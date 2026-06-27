import { describe, expect, it, vi } from 'vitest'
import { reconcileDownLane, type DownLaneDeps } from './downLane.js'
import type { AssetReplicateResult, AssetResolveRequest } from './resolver.js'

const WS = 'ws-A'
const req = (contentHash: string): AssetResolveRequest => ({ workspaceId: WS, contentHash })

/** A resolver whose `replicate` returns a programmed outcome per contentHash, and
 *  records every call so a test can assert which requests were even ATTEMPTED. */
const fakeResolver = (outcomes: Record<string, AssetReplicateResult>) => {
  const replicate = vi.fn(async (r: AssetResolveRequest): Promise<AssetReplicateResult> => {
    const out = outcomes[r.contentHash]
    if (!out) throw new Error(`no programmed outcome for ${r.contentHash}`)
    return out
  })
  return { resolver: { replicate } satisfies DownLaneDeps['resolver'], replicate }
}

const present = { ok: true, status: 'present' } as const
const replicated = { ok: true, status: 'replicated' } as const
const fetchFailed = { ok: false, reason: 'fetch-failed' } as const

describe('reconcileDownLane', () => {
  it('the steady state (all present) costs only probes — zero fetch attempts, nothing skipped', async () => {
    const hashes = ['a', 'b', 'c']
    const { resolver, replicate } = fakeResolver(Object.fromEntries(hashes.map((h) => [h, present])))

    const summary = await reconcileDownLane(hashes.map(req), { resolver })

    expect(summary).toEqual({ present: 3, replicated: 0, failed: 0, skipped: 0 })
    expect(replicate).toHaveBeenCalledTimes(3) // every block probed (has()), none skipped
  })

  it('replicates the absent blocks and tallies them', async () => {
    const { resolver } = fakeResolver({ a: present, b: replicated, c: replicated })
    const summary = await reconcileDownLane([req('a'), req('b'), req('c')], { resolver })
    expect(summary).toEqual({ present: 1, replicated: 2, failed: 0, skipped: 0 })
  })

  it('caps FETCH ATTEMPTS per pass at the budget — the long tail is skipped (not attempted)', async () => {
    const hashes = ['a', 'b', 'c', 'd', 'e'] // all absent
    const { resolver, replicate } = fakeResolver(Object.fromEntries(hashes.map((h) => [h, replicated])))

    const summary = await reconcileDownLane(hashes.map(req), { resolver, budget: 2 })

    expect(summary).toEqual({ present: 0, replicated: 2, failed: 0, skipped: 3 })
    // The 3 skipped were never even probed — the pass STOPS at the budget.
    expect(replicate).toHaveBeenCalledTimes(2)
  })

  it('present blocks are FREE — they do not consume the fetch budget', async () => {
    // [present, present, absent, absent, absent], budget 2: the two presents cost
    // nothing, so BOTH downloads still happen past them; only the 5th is skipped.
    const { resolver, replicate } = fakeResolver({
      a: present,
      b: present,
      c: replicated,
      d: replicated,
      e: replicated,
    })

    const summary = await reconcileDownLane(['a', 'b', 'c', 'd', 'e'].map(req), { resolver, budget: 2 })

    expect(summary).toEqual({ present: 2, replicated: 2, failed: 0, skipped: 1 })
    expect(replicate).toHaveBeenCalledTimes(4) // 2 free probes + 2 budgeted downloads
  })

  it('a FAILED fetch also consumes the budget — offline does not hammer every absent block', async () => {
    const hashes = ['a', 'b', 'c'] // all absent, all offline-miss
    const { resolver, replicate } = fakeResolver(Object.fromEntries(hashes.map((h) => [h, fetchFailed])))

    const summary = await reconcileDownLane(hashes.map(req), { resolver, budget: 2 })

    expect(summary).toEqual({ present: 0, replicated: 0, failed: 2, skipped: 1 })
    expect(replicate).toHaveBeenCalledTimes(2) // stopped after 2 attempts, even though all failed
  })

  it('a fail-closed block (hash-mismatch) is counted failed but does NOT halt the walk', async () => {
    const { resolver } = fakeResolver({
      a: { ok: false, reason: 'hash-mismatch' },
      b: replicated,
      c: present,
    })
    const summary = await reconcileDownLane([req('a'), req('b'), req('c')], { resolver, budget: 10 })
    expect(summary).toEqual({ present: 1, replicated: 1, failed: 1, skipped: 0 })
  })

  it('an empty work-list is a no-op', async () => {
    const { resolver, replicate } = fakeResolver({})
    expect(await reconcileDownLane([], { resolver })).toEqual({ present: 0, replicated: 0, failed: 0, skipped: 0 })
    expect(replicate).not.toHaveBeenCalled()
  })
})
