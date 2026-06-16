/**
 * Effect ↔ runtime-capture contract + effect lifecycle reconciliation
 * (audit B1(4)).
 *
 * Problem: `AppRuntimeProvider` builds a fresh `FacetRuntime` on every
 * swap (base → base+dynamic load, extension toggle). App effects capture
 * the runtime they were started with — they `read` it, subscribe via
 * `onFacetChange`, and write transient buckets via
 * `setRuntimeContributions` (theme apply-actions, keybinding overrides),
 * and the agent-runtime bridge captures it for command execution. So if
 * we keep an unchanged effect running across a swap (the whole point of
 * "restart only changed effects"), it strands on the dead runtime — the
 * bug that reverted the #152 effect-diffing attempt.
 *
 * Fix: effects capture a stable `LiveRuntimeHandle` instead of a raw
 * `FacetRuntime`. The handle is a `FacetRuntime` (so nothing downstream
 * re-types) that delegates every read to a swappable `current`. On a
 * swap, `setCurrent` migrates the kept effects' subscriptions and
 * transient buckets onto the fresh runtime and re-fires subscribers so
 * they re-sync — without restarting the effect. `EffectReconciler` then
 * diffs `appEffectsFacet` by id and starts/stops only the delta.
 */

import {
  FacetRuntime,
  type Facet,
  type FacetContribution,
  type FacetResolveContext,
  type RuntimeSourceId,
} from '@/facets/facet.js'
import {
  appEffectsFacet,
  type AppEffect,
  type AppEffectCleanup,
  type AppEffectContext,
} from '@/extensions/core.js'
import type { Repo } from '@/data/repo'

interface ForwardedListener {
  readonly facetId: string
  readonly listener: () => void
  /** Disposer for the subscription on the *current* runtime; replaced on
   *  every `setCurrent`. */
  unsub: () => void
}

interface RememberedBucket {
  readonly facet: Facet<unknown, unknown>
  readonly contributions: readonly unknown[]
  readonly durable?: boolean
}

/** A `FacetRuntime` facade effects capture so they survive runtime swaps.
 *  It owns no contribution state of its own — the inherited `super`
 *  storage is never read because every public method is overridden:
 *  reads/writes/subscriptions delegate to `current`, and
 *  `adoptDurableContributionsFrom` throws (the handle is never a swap
 *  target). It just forwards to whichever runtime is installed and
 *  re-points the effect's subscriptions / transient buckets when that
 *  runtime swaps. */
export class LiveRuntimeHandle extends FacetRuntime {
  private current: FacetRuntime
  private readonly forwarded = new Set<ForwardedListener>()
  /** Transient (effect-owned) buckets written through this handle, keyed
   *  facetId → sourceId. Replayed onto the fresh runtime on `setCurrent`
   *  because the owning effect is NOT restarted across the swap, so it
   *  won't re-push them itself. Cleared when the effect writes `[]`
   *  (its cleanup) so a removed effect doesn't strand. */
  private readonly buckets = new Map<string, Map<RuntimeSourceId, RememberedBucket>>()

  constructor(initial: FacetRuntime) {
    super(initial.context, [])
    this.current = initial
  }

  override read<Input, Output>(facet: Facet<Input, Output>): Output {
    return this.current.read(facet)
  }

  override contributions<Input>(facet: Facet<Input, unknown>): FacetContribution<Input>[] {
    return this.current.contributions(facet)
  }

  override contributionsById(facetId: string): FacetContribution<unknown>[] {
    return this.current.contributionsById(facetId)
  }

  override facetIds(): string[] {
    return this.current.facetIds()
  }

  /** Unsupported on the handle: it is a stable wrapper effects hold, never
   *  a runtime a swap installs, so it is never the *target* of a durable
   *  adoption. Overridden to fail loud rather than silently write into the
   *  dead inherited `super` storage that the delegating reads never
   *  consult (which would lose the durable data with no error). */
  override adoptDurableContributionsFrom(): void {
    throw new Error(
      '[LiveRuntimeHandle] adoptDurableContributionsFrom is not supported — ' +
      'the handle is a stable wrapper, never a swap target',
    )
  }

  override onFacetChange(facetId: string, listener: () => void): () => void {
    const reg: ForwardedListener = {
      facetId,
      listener,
      unsub: this.current.onFacetChange(facetId, listener),
    }
    this.forwarded.add(reg)
    return () => {
      reg.unsub()
      this.forwarded.delete(reg)
    }
  }

  override setRuntimeContributions<Input>(
    facet: Facet<Input, unknown>,
    sourceId: RuntimeSourceId,
    contributions: readonly Input[],
    options?: { durable?: boolean },
  ): void {
    if (contributions.length === 0) {
      const bySource = this.buckets.get(facet.id)
      bySource?.delete(sourceId)
      if (bySource && bySource.size === 0) this.buckets.delete(facet.id)
    } else {
      const bySource = this.buckets.get(facet.id) ?? new Map<RuntimeSourceId, RememberedBucket>()
      bySource.set(sourceId, {
        facet: facet as Facet<unknown, unknown>,
        contributions: contributions as readonly unknown[],
        durable: options?.durable,
      })
      this.buckets.set(facet.id, bySource)
    }
    this.current.setRuntimeContributions(facet, sourceId, contributions, options)
  }

  /** Point the handle at a freshly-installed runtime. Migrates the kept
   *  effects' subscriptions and transient buckets, then re-fires the
   *  subscribers so they re-read the new merged view (e.g. the theme
   *  effect rebuilds its stylesheet + apply-actions for the new theme
   *  set). No-op if `next` is already current. */
  setCurrent(next: FacetRuntime): void {
    if (next === this.current) return
    this.current = next
    // FacetRuntime.context is readonly at the type level, but the live
    // handle must reflect the current runtime's context (e.g. generation
    // bumps on toggle) for callers that read `runtime.context`.
    ;(this as { context: FacetResolveContext }).context = next.context

    // Replay transient buckets so a kept effect's contributions survive
    // the swap (it won't re-push them — it isn't restarted).
    for (const bySource of this.buckets.values()) {
      for (const [sourceId, bucket] of bySource) {
        next.setRuntimeContributions(bucket.facet, sourceId, bucket.contributions, { durable: bucket.durable })
      }
    }

    // Re-subscribe forwarded listeners onto the new runtime.
    for (const reg of this.forwarded) {
      reg.unsub()
      reg.unsub = next.onFacetChange(reg.facetId, reg.listener)
    }

    // Re-fire subscribers so they re-sync against `next` (the facet's
    // contributions may have changed in the swap). Idempotent for the
    // mirror-style effects that use onFacetChange (theme).
    for (const reg of this.forwarded) {
      try {
        reg.listener()
      } catch (error) {
        console.error(`[LiveRuntimeHandle] forwarded listener for ${reg.facetId} threw`, error)
      }
    }
  }
}

interface StartedEffect {
  readonly id: string
  stopped: boolean
  cleanup?: AppEffectCleanup
}

const runCleanup = (cleanup: AppEffectCleanup, effectId: string): void => {
  try {
    const result = cleanup()
    if (result instanceof Promise) {
      result.catch(error => {
        console.error(`App effect cleanup failed for ${effectId}`, error)
      })
    }
  } catch (error) {
    console.error(`App effect cleanup failed for ${effectId}`, error)
  }
}

const startEffect = (effect: AppEffect, context: AppEffectContext): StartedEffect => {
  const entry: StartedEffect = { id: effect.id, stopped: false }
  try {
    const result = effect.start(context)
    // Capture a synchronous cleanup immediately so a same-tick stop
    // (e.g. a removed effect, or unmount right after start) tears it
    // down. Only the Promise-returning path is deferred.
    if (typeof result === 'function') {
      entry.cleanup = result
    } else if (result instanceof Promise) {
      result
        .then(cleanup => {
          if (typeof cleanup !== 'function') return
          if (entry.stopped) {
            runCleanup(cleanup, effect.id)
            return
          }
          entry.cleanup = cleanup
        })
        .catch(error => {
          console.error(`App effect failed to start for ${effect.id}`, error)
        })
    }
  } catch (error) {
    console.error(`App effect failed to start for ${effect.id}`, error)
  }
  return entry
}

const stopEffect = (entry: StartedEffect): void => {
  entry.stopped = true
  if (entry.cleanup) {
    runCleanup(entry.cleanup, entry.id)
    entry.cleanup = undefined
  }
}

/** Drives the app-effect lifecycle across runtime swaps (B1(4)).
 *
 *  - When `repo` / `workspaceId` / `safeMode` change (values effects
 *    capture directly, not through the runtime), every effect restarts —
 *    keeping one alive would strand it on stale context.
 *  - When only the runtime changes (the common toggle / dynamic-load
 *    path), effects are diffed by id: newly-added ones start, removed
 *    ones stop, and unchanged ones keep running on the `LiveRuntimeHandle`
 *    (which `setCurrent` re-points at the fresh runtime). */
export class EffectReconciler {
  private liveRuntime: LiveRuntimeHandle | null = null
  private readonly started = new Map<string, StartedEffect>()
  private capturedCtx: { repo: Repo; workspaceId: string; safeMode: boolean } | null = null

  reconcile(repo: Repo, runtime: FacetRuntime, workspaceId: string, safeMode: boolean): void {
    const ctxChanged =
      this.capturedCtx === null ||
      this.capturedCtx.repo !== repo ||
      this.capturedCtx.workspaceId !== workspaceId ||
      this.capturedCtx.safeMode !== safeMode

    const effects = runtime.read(appEffectsFacet)
    const nextIds = new Set(effects.map(effect => effect.id))

    if (ctxChanged) {
      // Effects captured the previous repo/workspace/safeMode — restart
      // them all against a clean handle.
      this.stopAll()
      this.liveRuntime = new LiveRuntimeHandle(runtime)
      this.capturedCtx = { repo, workspaceId, safeMode }
    } else {
      // Stop removed effects BEFORE re-pointing the handle: a removed
      // transient owner's cleanup clears its bucket from the outgoing
      // runtime + the handle, so `setCurrent` replays only the survivors
      // onto the fresh runtime (no stale replay-then-clear window).
      for (const [id, entry] of this.started) {
        if (!nextIds.has(id)) {
          stopEffect(entry)
          this.started.delete(id)
        }
      }
      this.liveRuntime!.setCurrent(runtime)
    }

    const live = this.liveRuntime!
    for (const effect of effects) {
      if (this.started.has(effect.id)) continue
      this.started.set(
        effect.id,
        startEffect(effect, { repo, runtime: live, workspaceId, safeMode }),
      )
    }
  }

  /** Stop every running effect (provider unmount). */
  dispose(): void {
    this.stopAll()
    this.capturedCtx = null
    this.liveRuntime = null
  }

  private stopAll(): void {
    // Tear down in reverse start order (LIFO), matching the previous
    // provider's `cleanups.toReversed()` so any incidental ordering
    // relationship between independent effects is preserved.
    for (const entry of [...this.started.values()].reverse()) stopEffect(entry)
    this.started.clear()
  }
}
