import { describe, expect, it, vi } from 'vitest'
import { defineFacet, resolveFacetRuntimeSync } from '@/facets/facet.js'
import { appEffectsFacet, type AppEffect } from '@/extensions/core.js'
import { EffectReconciler, LiveRuntimeHandle } from '@/extensions/liveRuntime.js'
import type { Repo } from '@/data/repo'

const repo = {} as unknown as Repo

const labels = defineFacet<string, string>({
  id: 'test.live-labels',
  combine: values => values.join(','),
  empty: () => '',
})
const out = defineFacet<string, string>({
  id: 'test.live-out',
  combine: values => values.join(','),
  empty: () => '',
})

describe('LiveRuntimeHandle', () => {
  it('delegates reads to the current runtime', () => {
    const rt = resolveFacetRuntimeSync([labels.of('a')])
    const handle = new LiveRuntimeHandle(rt)
    expect(handle.read(labels)).toBe('a')
  })

  it('re-points a forwarded onFacetChange subscription onto the new runtime', () => {
    const first = resolveFacetRuntimeSync([])
    const handle = new LiveRuntimeHandle(first)
    const fired = vi.fn()
    handle.onFacetChange(labels.id, fired)

    const second = resolveFacetRuntimeSync([])
    handle.setCurrent(second)
    fired.mockClear() // ignore the re-sync fire from setCurrent itself

    // A change on the OLD runtime must NOT reach the listener anymore.
    first.setRuntimeContributions(labels, 'svc', ['stale'])
    expect(fired).not.toHaveBeenCalled()
    // A change on the NEW runtime must.
    second.setRuntimeContributions(labels, 'svc', ['live'])
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('replays transient buckets written through it onto the new runtime', () => {
    const first = resolveFacetRuntimeSync([])
    const handle = new LiveRuntimeHandle(first)
    handle.setRuntimeContributions(out, 'effect', ['kept'])

    const second = resolveFacetRuntimeSync([])
    handle.setCurrent(second)
    expect(second.read(out)).toBe('kept')
  })

  it('does not replay a bucket that was cleared before the swap', () => {
    const first = resolveFacetRuntimeSync([])
    const handle = new LiveRuntimeHandle(first)
    handle.setRuntimeContributions(out, 'effect', ['gone'])
    handle.setRuntimeContributions(out, 'effect', [])

    const second = resolveFacetRuntimeSync([])
    handle.setCurrent(second)
    expect(second.read(out)).toBe('')
  })

  it('re-fires forwarded listeners on swap so subscribers re-sync', () => {
    const first = resolveFacetRuntimeSync([labels.of('a')])
    const handle = new LiveRuntimeHandle(first)
    const apply = vi.fn(() => {
      handle.setRuntimeContributions(out, 'mirror', [handle.read(labels)])
    })
    apply()
    handle.onFacetChange(labels.id, apply)
    expect(first.read(out)).toBe('a')

    const second = resolveFacetRuntimeSync([labels.of('b')])
    handle.setCurrent(second)
    expect(second.read(out)).toBe('b')
  })
})

/** Build a runtime carrying the given effects + an optional `labels`
 *  static value, so the reconciler can `read(appEffectsFacet)`. */
const runtimeWith = (effects: readonly AppEffect[], label?: string) =>
  resolveFacetRuntimeSync([
    ...(label === undefined ? [] : [labels.of(label)]),
    ...effects.map(effect => appEffectsFacet.of(effect)),
  ])

describe('EffectReconciler', () => {
  it('starts every effect on first reconcile', () => {
    const start = vi.fn()
    const r = new EffectReconciler()
    r.reconcile(repo, runtimeWith([{ id: 'a', start }, { id: 'b', start }]), 'ws', false)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('keeps unchanged effects running across a runtime-only swap', () => {
    const start = vi.fn()
    const cleanup = vi.fn()
    start.mockReturnValue(cleanup)
    const effect: AppEffect = { id: 'kept', start }
    const r = new EffectReconciler()

    r.reconcile(repo, runtimeWith([effect]), 'ws', false)
    r.reconcile(repo, runtimeWith([effect]), 'ws', false) // new runtime, same ctx

    expect(start).toHaveBeenCalledTimes(1) // NOT restarted
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('restarts an effect whose contribution object changed (same id, new start)', () => {
    const oldCleanup = vi.fn()
    const oldStart = vi.fn(() => oldCleanup)
    const newStart = vi.fn()
    const r = new EffectReconciler()

    r.reconcile(repo, runtimeWith([{ id: 'e', start: oldStart }]), 'ws', false)
    // Same id, different contribution object (e.g. a live-edited plugin
    // recompiled to a new module): tear the old impl down and start the new.
    r.reconcile(repo, runtimeWith([{ id: 'e', start: newStart }]), 'ws', false)

    expect(oldStart).toHaveBeenCalledTimes(1)
    expect(oldCleanup).toHaveBeenCalledTimes(1) // old impl torn down
    expect(newStart).toHaveBeenCalledTimes(1) // new impl started
  })

  it('starts added and stops removed effects on a runtime-only swap', () => {
    const keptStart = vi.fn()
    const removedCleanup = vi.fn()
    const removedStart = vi.fn(() => removedCleanup)
    const addedStart = vi.fn()
    const kept: AppEffect = { id: 'kept', start: keptStart }

    const r = new EffectReconciler()
    r.reconcile(repo, runtimeWith([kept, { id: 'removed', start: removedStart }]), 'ws', false)
    r.reconcile(repo, runtimeWith([kept, { id: 'added', start: addedStart }]), 'ws', false)

    expect(keptStart).toHaveBeenCalledTimes(1) // survived
    expect(removedCleanup).toHaveBeenCalledTimes(1) // torn down
    expect(addedStart).toHaveBeenCalledTimes(1) // newly started
  })

  it('restarts all effects when the captured context changes', () => {
    const start = vi.fn()
    const cleanup = vi.fn()
    start.mockReturnValue(cleanup)
    const effect: AppEffect = { id: 'e', start }
    const r = new EffectReconciler()

    r.reconcile(repo, runtimeWith([effect]), 'ws-1', false)
    r.reconcile(repo, runtimeWith([effect]), 'ws-2', false) // workspace switch

    expect(start).toHaveBeenCalledTimes(2)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('dispose stops every running effect', () => {
    const cleanup = vi.fn()
    const r = new EffectReconciler()
    r.reconcile(repo, runtimeWith([{ id: 'e', start: () => cleanup }]), 'ws', false)
    r.dispose()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  // The reverted #152 regression: a kept effect that captured its
  // start-time runtime (reads a facet, subscribes, writes a derived
  // bucket) must keep targeting the LIVE runtime after a swap — not
  // strand its output on the dead one.
  it('a kept mirror-style effect re-syncs to the new runtime instead of stranding', () => {
    const start = vi.fn<AppEffect['start']>(({ runtime }) => {
      const apply = () => runtime.setRuntimeContributions(out, 'mirror', [runtime.read(labels)])
      apply()
      return runtime.onFacetChange(labels.id, apply)
    })
    const mirror: AppEffect = { id: 'mirror', start }

    const r = new EffectReconciler()
    const first = runtimeWith([mirror], 'a')
    r.reconcile(repo, first, 'ws', false)
    expect(first.read(out)).toBe('a')

    const second = runtimeWith([mirror], 'b')
    r.reconcile(repo, second, 'ws', false)

    expect(second.read(out)).toBe('b') // re-synced to the live runtime
    expect(start).toHaveBeenCalledTimes(1) // and it was NOT restarted
  })
})
