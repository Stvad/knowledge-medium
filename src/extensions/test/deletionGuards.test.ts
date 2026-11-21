// @vitest-environment node
/**
 * `resolveDeletionRefusal` against MISBEHAVING guards. Guards come from
 * user-installable extensions, so the contract is that a broken one can degrade
 * the affordance but never take deletion away: every failure mode has to
 * resolve to "allow". A delete is soft and undoable; a Delete key that hangs is
 * not recoverable at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import {
  blockDeletionGuardsFacet,
  resolveDeletionRefusal,
  type BlockDeletionGuard,
} from '@/extensions/core'

const block = {id: 'target'} as Block

/** A repo stub: `resolveDeletionRefusal` only ever reads `facetRuntime`. */
const repoWith = (...guards: BlockDeletionGuard[]): Repo => ({
  facetRuntime: resolveFacetRuntimeSync(
    guards.map((guard, index) => blockDeletionGuardsFacet.of(guard, {source: `test-${index}`})),
  ),
} as unknown as Repo)

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('resolveDeletionRefusal', () => {
  it('allows when there is no facet runtime at all (headless, early boot)', async () => {
    expect(await resolveDeletionRefusal({} as Repo, block)).toBeNull()
  })

  it('returns the first refusal and stops asking', async () => {
    const later = vi.fn(() => 'second')
    expect(await resolveDeletionRefusal(repoWith(() => 'first', later), block)).toBe('first')
    expect(later).not.toHaveBeenCalled()
  })

  it('allows past a guard that throws or rejects, still consulting the rest', async () => {
    const throws = () => { throw new Error('boom') }
    const rejects = () => Promise.reject(new Error('boom'))
    expect(await resolveDeletionRefusal(repoWith(throws, rejects), block)).toBeNull()
    expect(await resolveDeletionRefusal(repoWith(throws, () => 'real'), block)).toBe('real')
  })

  it('allows past a guard that never settles, instead of hanging the gesture', async () => {
    vi.useFakeTimers()
    const later = vi.fn(() => 'real')
    const pending = resolveDeletionRefusal(repoWith(() => new Promise<null>(() => {}), later), block)
    await vi.advanceTimersByTimeAsync(10_000)
    // Without the timeout this promise never settles and `Delete` is dead.
    expect(await pending).toBe('real')
  })

  it('does not report a prompt guard as timed out, nor leave a timer pending', async () => {
    vi.useFakeTimers()
    const settled = await resolveDeletionRefusal(repoWith(() => null), block)
    expect(settled).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('ignores a truthy non-string reason rather than toasting an object', async () => {
    const bogus = (() => ({reason: 'nope'})) as unknown as BlockDeletionGuard
    expect(await resolveDeletionRefusal(repoWith(bogus, () => 'real'), block)).toBe('real')
  })
})
