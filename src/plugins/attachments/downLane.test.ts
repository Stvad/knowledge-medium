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
const noKey = { ok: false, reason: 'no-content-key' } as const // a prepare-stage (no-egress) failure

describe('reconcileDownLane', () => {
  it('the steady state (all present) costs only probes — zero fetch attempts, nothing skipped', async () => {
    const hashes = ['a', 'b', 'c']
    const { resolver, replicate } = fakeResolver(Object.fromEntries(hashes.map((h) => [h, present])))

    const summary = await reconcileDownLane(hashes.map(req), { resolver })

    expect(summary).toEqual({ present: 3, replicated: 0, failed: 0, unavailable: 0, skipped: 0 })
    expect(replicate).toHaveBeenCalledTimes(3) // every block probed (has()), none skipped
  })

  it('replicates the absent blocks and tallies them', async () => {
    const { resolver } = fakeResolver({ a: present, b: replicated, c: replicated })
    const summary = await reconcileDownLane([req('a'), req('b'), req('c')], { resolver })
    expect(summary).toEqual({ present: 1, replicated: 2, failed: 0, unavailable: 0, skipped: 0 })
  })

  it('caps SUCCESSFUL DOWNLOADS per pass at the budget — the long tail is skipped (not attempted)', async () => {
    const hashes = ['a', 'b', 'c', 'd', 'e'] // all absent, all replicate-able
    const { resolver, replicate } = fakeResolver(Object.fromEntries(hashes.map((h) => [h, replicated])))

    const summary = await reconcileDownLane(hashes.map(req), { resolver, budget: 2 })

    expect(summary).toEqual({ present: 0, replicated: 2, failed: 0, unavailable: 0, skipped: 3 })
    // The 3 skipped were never even probed — the pass STOPS at the budget of successes.
    expect(replicate).toHaveBeenCalledTimes(2)
  })

  it('a budget of 0 replicates NOTHING — the whole list is skipped, nothing is even probed', async () => {
    // The cap is checked before each request, so a 0 budget does no work at all (no
    // off-by-one fetch-then-stop). `?? DEFAULT` preserves an explicit 0, so this is the
    // real meaning of budget 0, not a fallback to the default.
    const hashes = ['a', 'b', 'c']
    const { resolver, replicate } = fakeResolver(Object.fromEntries(hashes.map((h) => [h, replicated])))

    const summary = await reconcileDownLane(hashes.map(req), { resolver, budget: 0 })

    expect(summary).toEqual({ present: 0, replicated: 0, failed: 0, unavailable: 0, skipped: 3 })
    expect(replicate).not.toHaveBeenCalled() // budget spent before any work — zero egress
  })

  it('present blocks are FREE — they do not consume the download budget', async () => {
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

    expect(summary).toEqual({ present: 2, replicated: 2, failed: 0, unavailable: 0, skipped: 1 })
    expect(replicate).toHaveBeenCalledTimes(4) // 2 free probes + 2 budgeted downloads
  })

  it('a failing PREFIX never shadows the healthy tail — failures do not consume the budget (Codex P2)', async () => {
    // Stable request order with 3 permanently-failing OLDER blocks at the head, then 2
    // healthy. budget 2: if a fetch-stage failure consumed the budget (and early-returned),
    // the head would eat both slots every sweep and the healthy tail would NEVER
    // background-replicate. Failures must be FREE so the walk reaches the healthy blocks.
    const { resolver, replicate } = fakeResolver({
      a: fetchFailed, // missing / offline (§9 backstop) — older block
      b: { ok: false, reason: 'hash-mismatch' }, // poisoned older block
      c: fetchFailed,
      d: replicated, // healthy — MUST still replicate
      e: replicated,
    })

    const summary = await reconcileDownLane(['a', 'b', 'c', 'd', 'e'].map(req), { resolver, budget: 2 })

    expect(summary).toEqual({ present: 0, replicated: 2, failed: 3, unavailable: 0, skipped: 0 })
    expect(replicate).toHaveBeenCalledTimes(5) // walked PAST all 3 failures to the healthy tail
  })

  it('a store-failed (quota / storage-wide) HALTS the pass — the tail is skipped, not re-fetched', async () => {
    // Unlike a per-asset fetch failure, a byte-store write failure is storage-wide: every
    // later put would fail the same way. Stop the pass rather than re-download the tail
    // for bytes that can't land; the next sweep retries when storage may have room.
    const { resolver, replicate } = fakeResolver({
      a: replicated,
      b: { ok: false, reason: 'store-failed' },
      c: replicated,
      d: replicated,
    })

    const summary = await reconcileDownLane(['a', 'b', 'c', 'd'].map(req), { resolver, budget: 10 })

    expect(summary).toEqual({ present: 0, replicated: 1, failed: 1, unavailable: 0, skipped: 2 })
    expect(replicate).toHaveBeenCalledTimes(2) // stopped at the store failure; c, d not attempted
  })

  it('a fail-closed block (hash-mismatch) is counted failed but does NOT halt the walk', async () => {
    const { resolver } = fakeResolver({
      a: { ok: false, reason: 'hash-mismatch' },
      b: replicated,
      c: present,
    })
    const summary = await reconcileDownLane([req('a'), req('b'), req('c')], { resolver, budget: 10 })
    expect(summary).toEqual({ present: 1, replicated: 1, failed: 1, unavailable: 0, skipped: 0 })
  })

  it('prepare-stage failures (no key / locked) are FREE — they never burn the fetch budget', async () => {
    // A workspace missing its key: every block fails `no-content-key` BEFORE any fetch.
    // Budget 2, but a [no-key × 3] PREFIX must not consume it — so the two genuinely-
    // absent blocks AFTER the prefix still download, and nothing is skipped.
    const { resolver, replicate } = fakeResolver({
      a: noKey,
      b: noKey,
      c: noKey,
      d: replicated,
      e: replicated,
    })

    const summary = await reconcileDownLane(['a', 'b', 'c', 'd', 'e'].map(req), { resolver, budget: 2 })

    expect(summary).toEqual({ present: 0, replicated: 2, failed: 0, unavailable: 3, skipped: 0 })
    expect(replicate).toHaveBeenCalledTimes(5) // all walked — the free failures didn't starve the tail
  })

  it('an empty work-list is a no-op', async () => {
    const { resolver, replicate } = fakeResolver({})
    expect(await reconcileDownLane([], { resolver })).toEqual({
      present: 0,
      replicated: 0,
      failed: 0,
      unavailable: 0,
      skipped: 0,
    })
    expect(replicate).not.toHaveBeenCalled()
  })
})
