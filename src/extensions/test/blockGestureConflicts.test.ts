import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import {
  blockGestureConflictsFacet,
  claimBlockGesture,
  releaseBlockGesture,
  __resetBlockGestureClaimsForTest,
} from '@/extensions/blockGestureConflicts.js'

describe('blockGestureConflictsFacet', () => {
  beforeEach(() => {
    __resetBlockGestureClaimsForTest()
  })

  afterEach(() => {
    __resetBlockGestureClaimsForTest()
  })

  it('fires the previous gesture\'s onCancel when a new gesture claims the same block', () => {
    const onCancelA = vi.fn()
    const onCancelB = vi.fn()
    const runtime = resolveFacetRuntimeSync([
      blockGestureConflictsFacet.of({id: 'a', onCancel: onCancelA}),
      blockGestureConflictsFacet.of({id: 'b', onCancel: onCancelB}),
    ])

    claimBlockGesture(runtime, 'block-1', 'a')
    claimBlockGesture(runtime, 'block-1', 'b')

    expect(onCancelA).toHaveBeenCalledTimes(1)
    expect(onCancelA).toHaveBeenCalledWith('block-1')
    expect(onCancelB).not.toHaveBeenCalled()
  })

  it('keeps claims independent across blocks', () => {
    const onCancelA = vi.fn()
    const onCancelB = vi.fn()
    const runtime = resolveFacetRuntimeSync([
      blockGestureConflictsFacet.of({id: 'a', onCancel: onCancelA}),
      blockGestureConflictsFacet.of({id: 'b', onCancel: onCancelB}),
    ])

    claimBlockGesture(runtime, 'block-1', 'a')
    claimBlockGesture(runtime, 'block-2', 'b')

    expect(onCancelA).not.toHaveBeenCalled()
    expect(onCancelB).not.toHaveBeenCalled()
  })

  it('does not self-cancel when the same gesture re-claims the same block', () => {
    const onCancelA = vi.fn()
    const runtime = resolveFacetRuntimeSync([
      blockGestureConflictsFacet.of({id: 'a', onCancel: onCancelA}),
    ])

    claimBlockGesture(runtime, 'block-1', 'a')
    claimBlockGesture(runtime, 'block-1', 'a')
    claimBlockGesture(runtime, 'block-1', 'a')

    expect(onCancelA).not.toHaveBeenCalled()
  })

  it('releases the slot so a later claim by a new gesture does not fire onCancel', () => {
    const onCancelA = vi.fn()
    const onCancelB = vi.fn()
    const runtime = resolveFacetRuntimeSync([
      blockGestureConflictsFacet.of({id: 'a', onCancel: onCancelA}),
      blockGestureConflictsFacet.of({id: 'b', onCancel: onCancelB}),
    ])

    claimBlockGesture(runtime, 'block-1', 'a')
    releaseBlockGesture('block-1', 'a')
    claimBlockGesture(runtime, 'block-1', 'b')

    // 'a' already released — nothing to evict when 'b' claims.
    expect(onCancelA).not.toHaveBeenCalled()
    expect(onCancelB).not.toHaveBeenCalled()
  })

  it('releaseBlockGesture is a no-op when the slot is held by a different gesture', () => {
    const onCancelA = vi.fn()
    const onCancelB = vi.fn()
    const runtime = resolveFacetRuntimeSync([
      blockGestureConflictsFacet.of({id: 'a', onCancel: onCancelA}),
      blockGestureConflictsFacet.of({id: 'b', onCancel: onCancelB}),
    ])

    claimBlockGesture(runtime, 'block-1', 'a')
    claimBlockGesture(runtime, 'block-1', 'b')
    // After eviction, 'a' calling release shouldn't disturb 'b'.
    releaseBlockGesture('block-1', 'a')
    claimBlockGesture(runtime, 'block-1', 'a')

    // 'b' is evicted by 'a' re-claiming — onCancelB fires now.
    expect(onCancelB).toHaveBeenCalledTimes(1)
    expect(onCancelB).toHaveBeenCalledWith('block-1')
    // 'a' was already evicted earlier; only the eventual re-claim cycle
    // hits its onCancel — and that hasn't happened in this scenario.
    expect(onCancelA).toHaveBeenCalledTimes(1)
    expect(onCancelA).toHaveBeenCalledWith('block-1')
  })

  it('tolerates a null runtime and a missing contribution', () => {
    // Production sites pass `block.repo.facetRuntime` which can be null
    // before mount; eviction should silently skip rather than throw.
    expect(() => {
      claimBlockGesture(null, 'block-1', 'a')
      claimBlockGesture(null, 'block-1', 'b')
    }).not.toThrow()

    // Claim id with no matching contribution: the eviction lookup
    // returns null and nothing fires.
    const runtime = resolveFacetRuntimeSync([])
    __resetBlockGestureClaimsForTest()
    claimBlockGesture(runtime, 'block-2', 'a')
    expect(() => claimBlockGesture(runtime, 'block-2', 'b')).not.toThrow()
  })
})
