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
  runtimeContributionBucketKey,
  type CapturedFacetContributions,
  type Facet,
  type FacetContribution,
  type RuntimeContributionOptions,
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
  readonly sourceId: RuntimeSourceId
  readonly contributions: readonly unknown[]
  readonly durable?: boolean
  readonly workspaceId?: string
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
  /** Undefined until callers use the handle's pin API. Production usually
   * pins raw runtimes through FacetBridge first; once explicitly set through
   * this stable facade, preserve that choice across warm runtime swaps. */
  private forwardedActiveWorkspaceId: string | null | undefined
  private readonly forwarded = new Set<ForwardedListener>()
  /** Transient (effect-owned) buckets written through this handle, keyed
   *  facetId → (workspaceId, sourceId). Replayed onto the fresh runtime on `setCurrent`
   *  because the owning effect is NOT restarted across the swap, so it
   *  won't re-push them itself. Cleared when the effect writes `[]`
   *  (its cleanup) so a removed effect doesn't strand. */
  private readonly buckets = new Map<string, Map<RuntimeSourceId, RememberedBucket>>()

  constructor(initial: FacetRuntime) {
    super(initial.context, [])
    this.current = initial
    // Callers that consult `runtime.context` (e.g. generation bumps read
    // off the context on toggle) must see the *current* runtime's context,
    // not a snapshot frozen at construction. Replace the data property the
    // super constructor set with an accessor that delegates to `current`,
    // so the value stays live across swaps without `setCurrent` having to
    // cast away `readonly` and repoint it.
    Object.defineProperty(this, 'context', {
      get: () => this.current.context,
      enumerable: true,
      configurable: true,
    })
  }

  override read<Input, Output>(facet: Facet<Input, Output>): Output {
    return this.current.read(facet)
  }

  override readForWorkspace<Input, Output>(
    facet: Facet<Input, Output>,
    workspaceId: string | null,
  ): Output {
    return this.current.readForWorkspace(facet, workspaceId)
  }

  override captureContributions(): CapturedFacetContributions {
    return this.current.captureContributions()
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

  override setActiveWorkspaceId(workspaceId: string | null): void {
    this.forwardedActiveWorkspaceId = workspaceId
    this.current.setActiveWorkspaceId(workspaceId)
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
    options?: RuntimeContributionOptions,
  ): void {
    const bucketKey = runtimeContributionBucketKey(sourceId, options?.workspaceId)
    if (contributions.length === 0) {
      const bySource = this.buckets.get(facet.id)
      bySource?.delete(bucketKey)
      if (bySource && bySource.size === 0) this.buckets.delete(facet.id)
    } else {
      const bySource = this.buckets.get(facet.id) ?? new Map<RuntimeSourceId, RememberedBucket>()
      bySource.set(bucketKey, {
        facet: facet as Facet<unknown, unknown>,
        sourceId,
        contributions: contributions as readonly unknown[],
        durable: options?.durable,
        workspaceId: options?.workspaceId,
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
    if (this.forwardedActiveWorkspaceId !== undefined) {
      next.setActiveWorkspaceId(this.forwardedActiveWorkspaceId)
    }
    // `context` delegates to `current` via the constructor accessor, so it
    // already reflects `next` — nothing to repoint here.

    // Replay transient buckets so a kept effect's contributions survive
    // the swap (it won't re-push them — it isn't restarted).
    for (const bySource of this.buckets.values()) {
      for (const bucket of bySource.values()) {
        next.setRuntimeContributions(bucket.facet, bucket.sourceId, bucket.contributions, {
          durable: bucket.durable,
          workspaceId: bucket.workspaceId,
        })
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
  /** The contribution object this entry was started from. A later
   *  reconcile compares by reference to detect a code change (same id,
   *  new `start`) vs. the same effect re-resolved. */
  readonly effect: AppEffect
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
  const entry: StartedEffect = { id: effect.id, effect, stopped: false }
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

  /** Whether `{repo, workspaceId, safeMode}` differs from the context the
   *  reconciler last captured — i.e. the next `reconcile` would be a full
   *  restart (cold) rather than a runtime-only diff (warm). This is the
   *  single source of truth for "cold vs warm": `AppRuntimeProvider`
   *  queries it to decide whether to commit the sync base runtime (cold
   *  start) or hold the current one for a same-context reload, instead of
   *  tracking the same latch separately. A never-reconciled or
   *  just-disposed reconciler is cold. */
  isColdFor(repo: Repo, workspaceId: string | null, safeMode: boolean): boolean {
    return (
      this.capturedCtx === null ||
      this.capturedCtx.repo !== repo ||
      this.capturedCtx.workspaceId !== workspaceId ||
      this.capturedCtx.safeMode !== safeMode
    )
  }

  reconcile(repo: Repo, runtime: FacetRuntime, workspaceId: string, safeMode: boolean): void {
    const ctxChanged = this.isColdFor(repo, workspaceId, safeMode)

    const effects = runtime.read(appEffectsFacet)
    // Dedup by id, last-wins with a warn — matching the repo-wide facet
    // convention (mutatorsFacet / typesFacet / … all warn + last-wins).
    // The override idiom plugin authors are taught is "register after the
    // kernel to replace it"; a silent first-wins here would drop their
    // override with no signal. Duplicate effect ids are a misconfiguration
    // either way, so we keep the last contribution and warn.
    const nextById = new Map<string, AppEffect>()
    for (const effect of effects) {
      if (nextById.has(effect.id)) {
        console.warn(
          `[appEffectsFacet] duplicate effect id "${effect.id}"; last-wins per facet convention`,
        )
      }
      nextById.set(effect.id, effect)
    }

    if (ctxChanged) {
      // Effects captured the previous repo/workspace/safeMode — restart
      // them all against a clean handle.
      this.stopAll()
      this.liveRuntime = new LiveRuntimeHandle(runtime)
      this.capturedCtx = { repo, workspaceId, safeMode }
    } else {
      // Stop removed AND code-changed effects BEFORE re-pointing the
      // handle. Removed = id no longer present; code-changed = same id
      // but a different contribution object (e.g. a live-edited dynamic
      // extension recompiled to a fresh module — the compile cache hands
      // back a new reference only when the source changed, a stable one
      // otherwise, so an unchanged effect keeps running). Stopping first
      // lets the start loop launch the new implementation, and the
      // cleanup clears any transient bucket before `setCurrent` replays
      // the survivors onto the fresh runtime (no stale replay-then-clear).
      for (const [id, entry] of this.started) {
        const next = nextById.get(id)
        if (next === undefined || next !== entry.effect) {
          stopEffect(entry)
          this.started.delete(id)
        }
      }
      this.liveRuntime!.setCurrent(runtime)
    }

    const live = this.liveRuntime!
    // Iterate the deduped winners (last-wins), not the raw array — starting
    // the array's first occurrence would contradict the dedup above.
    for (const effect of nextById.values()) {
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
