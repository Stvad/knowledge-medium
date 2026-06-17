import { describe, expect, it, vi } from 'vitest'
import { defineFacet, FacetRuntime, resolveFacetRuntimeSync } from '@/facets/facet.js'
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

  it('exposes the current runtime context, live across swaps', () => {
    const first = resolveFacetRuntimeSync([])
    const handle = new LiveRuntimeHandle(first)
    expect(handle.context).toBe(first.context)

    const second = resolveFacetRuntimeSync([])
    handle.setCurrent(second)
    expect(handle.context).toBe(second.context) // delegates, not frozen at construction
  })

  it('setCurrent is a no-op when passed the runtime already current', () => {
    const rt = resolveFacetRuntimeSync([labels.of('a')])
    const handle = new LiveRuntimeHandle(rt)
    const fired = vi.fn()
    handle.onFacetChange(labels.id, fired)

    handle.setCurrent(rt) // same runtime already installed
    expect(fired).not.toHaveBeenCalled() // no re-fire / re-subscribe churn
  })

  it('adoptDurableContributionsFrom throws — the handle is never a swap target', () => {
    const handle = new LiveRuntimeHandle(resolveFacetRuntimeSync([]))
    expect(() => handle.adoptDurableContributionsFrom()).toThrow(/not supported/)
  })

  // Guards the subclass seam: LiveRuntimeHandle owns no contribution state,
  // so any *public* FacetRuntime method it forgets to override would
  // silently serve dead inherited storage. FacetRuntime's `private` helpers
  // (TS-private = runtime-visible) are only called by its own public
  // methods; since the handle overrides every public method to delegate to
  // `current`, those base methods — and thus these helpers — never run on
  // the handle. They're listed as known-unreachable; anything else new must
  // be overridden.
  it('overrides every public FacetRuntime method', () => {
    const internalHelpers = new Set([
      'collectContributions', 'markDurable', 'unmarkDurable', 'notifyFacetListeners',
    ])
    const publicMethods = Object.getOwnPropertyNames(FacetRuntime.prototype)
      .filter(name => name !== 'constructor' && !internalHelpers.has(name))
    const handleOwn = new Set(Object.getOwnPropertyNames(LiveRuntimeHandle.prototype))
    const notOverridden = publicMethods.filter(name => !handleOwn.has(name))
    expect(notOverridden).toEqual([])
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

  // Provider drives this on workspace → null → workspace: the cleared
  // workspace disposes, then a restored one reconciles again. The second
  // reconcile must restart against a fresh handle, not resume the disposed
  // run (capturedCtx was nulled).
  it('reconcile → dispose → reconcile restarts effects against a fresh handle', () => {
    const cleanup = vi.fn()
    const start = vi.fn(() => cleanup)
    const effect: AppEffect = { id: 'e', start }
    const r = new EffectReconciler()

    r.reconcile(repo, runtimeWith([effect]), 'ws', false)
    r.dispose() // workspace cleared
    expect(cleanup).toHaveBeenCalledTimes(1)

    r.reconcile(repo, runtimeWith([effect]), 'ws', false) // workspace restored
    expect(start).toHaveBeenCalledTimes(2) // started fresh, not resumed
  })

  it('duplicate effect id: the last contribution wins and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const firstStart = vi.fn(() => () => {})
    const lastStart = vi.fn()
    const r = new EffectReconciler()

    r.reconcile(repo, runtimeWith([
      { id: 'dup', start: firstStart },
      { id: 'dup', start: lastStart },
    ]), 'ws', false)

    expect(lastStart).toHaveBeenCalledTimes(1) // last-wins, per facet convention
    expect(firstStart).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate effect id "dup"'))
    warn.mockRestore()
  })

  it('runs a late async cleanup immediately when the effect was stopped before start resolved', async () => {
    const cleanup = vi.fn()
    let resolveStart!: (c: () => void) => void
    const start = vi.fn(() => new Promise<() => void>(res => { resolveStart = res }))
    const r = new EffectReconciler()

    r.reconcile(repo, runtimeWith([{ id: 'async', start }]), 'ws', false)
    r.reconcile(repo, runtimeWith([]), 'ws', false) // removed before start resolved → stopped

    resolveStart(cleanup)
    await new Promise(res => setTimeout(res, 0)) // flush the start promise's .then

    expect(cleanup).toHaveBeenCalledTimes(1) // not stranded — torn down on resolve
  })

  it('a throwing cleanup does not prevent the rest of stopAll', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const order: string[] = []
    const r = new EffectReconciler()
    r.reconcile(repo, runtimeWith([
      { id: 'a', start: () => () => { order.push('a') } },
      { id: 'b', start: () => () => { order.push('b'); throw new Error('boom') } },
    ]), 'ws', false)

    expect(() => r.dispose()).not.toThrow()
    expect(order).toEqual(['b', 'a']) // LIFO; b throwing didn't abort a's teardown
    error.mockRestore()
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
