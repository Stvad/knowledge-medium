/** Shared lifecycle for *definition-block projectors* — the
 *  "data-defined contributions over facets" pattern from issue #90.
 *
 *  A projector watches the workspace's blocks of a meta-type, builds a
 *  contribution per matching block, and publishes the set into a
 *  facet's `'user-data'` runtime-contribution bucket. Two instances
 *  exist today and were hand-copied then DIVERGED:
 *    - `UserSchemasService` — `'property-schema'` blocks → `propertySchemasFacet`
 *    - `UserTypesService`   — `'block-type'`    blocks → `typesFacet`
 *
 *  This module owns the ONE copy of the safety-critical lifecycle the
 *  two surfaces must not drift on again:
 *    - pin the workspace at start(); throw if none / on double-start;
 *    - subscribe to `{workspaceId, types:[metaType]}` and rebuild;
 *    - a `primed` gate so a cross-projector publish on the secondary
 *      signal during a workspace-switch handoff can't rebuild against
 *      rows this projector doesn't own yet;
 *    - on dispose: reset in-memory state AND clear the captured workspace's
 *      bucket (scoped filtering prevents visibility leaks; clearing bounds
 *      durable state and forces a current-row rebuild on restart);
 *    - one `disposed` flag checked before every synchronous publish, so a
 *      publish from a torn-down container (a queued subscription/secondary
 *      callback, or a write landing during the dispose→restart gap) can't
 *      reach the bucket. This unifies the in-flight-write guard the two
 *      services expressed two different ways (schemas via `latestBlocks=[]`,
 *      types via `subscriptionPrimed`). Note its LIMIT: the per-projector
 *      container is reused across workspace switches and `start()` re-arms
 *      `disposed`, so the flag alone does NOT stop an async write that
 *      resolves *after* the next workspace has started. A synchronous write
 *      path that can span a switch (schemas' `addSchema`) additionally pins
 *      its workspace at the call site and skips the publish if it changed.
 *
 *  The per-projector specifics — the builder, the row form (raw
 *  `BlockData` vs hydrated `Block` facades), the secondary re-resolve
 *  signal, and the distinct public surface (schemas' `addSchema` write
 *  path + getters, types' `getTypeBlockId` + schemas→types dependency)
 *  — stay OUTSIDE, in the descriptor's hooks and the thin service
 *  facades. Per #90: this is the narrow unification of the two existing
 *  instances; the third (commands / saved queries) lands by registering
 *  one more descriptor in `definitionBlockProjectorFacet`. */

import type { BlockData, Unsubscribe } from '@/data/api'
import type { Facet } from '@/facets/facet'
import type { Repo } from '@/data/repo'
import { definitionBlockProjectorFacet } from '@/data/facets'

/** Read handle onto a started projector's resolved state. Service
 *  facades and sibling projectors (via the build ctx) read through this
 *  rather than reaching into the lifecycle. */
export interface ProjectorHandle<Contribution = unknown> {
  /** Block id that materialised the contribution registered under
   *  `key` (a schema name / a type id). */
  blockIdForKey(key: string): string | undefined
  /** Contribution currently materialised from `blockId`. */
  contributionForBlockId(blockId: string): Contribution | undefined
  /** Synchronously upsert one contribution and publish — the
   *  schemas `addSchema` path registers before the subscription tick.
   *  The explicit workspace plus lifecycle generation prevent an outgoing
   *  async path from publishing through a container re-armed elsewhere. */
  upsert(contribution: Contribution, blockId: string, workspaceId: string): void
  isPrimedFor(workspaceId: string): boolean
  whenPrimed(workspaceId: string): Promise<void>
}

type PrimeOutcome = 'primed' | 'cancelled'

interface PrimeDeferred {
  readonly workspaceId: string
  readonly generation: number
  readonly promise: Promise<PrimeOutcome>
  settle(outcome: PrimeOutcome): void
}

const createPrimeDeferred = (workspaceId: string, generation: number): PrimeDeferred => {
  let settlePromise!: (outcome: PrimeOutcome) => void
  let settled = false
  const promise = new Promise<PrimeOutcome>(resolve => { settlePromise = resolve })
  return {
    workspaceId,
    generation,
    promise,
    settle: outcome => {
      if (settled) return
      settled = true
      settlePromise(outcome)
    },
  }
}

/** Handed to a descriptor's `project` / `hydrate` so it can reach the
 *  repo (e.g. `valuePresets`) and sibling projector handles (e.g. the
 *  type projector resolving refs through the schema projector). */
export interface ProjectorBuildContext {
  readonly repo: Repo
  handle(projectorId: string): ProjectorHandle | undefined
}

/** Data description of a projector. Registered as a contribution to
 *  `definitionBlockProjectorFacet`; the divergent bits live here as
 *  hooks so the lifecycle stays one parameterized core. */
export interface DefinitionBlockProjector<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance escape: descriptors are stored type-erased in the facet (mirrors AnyMutator/AnyQuery)
  Row extends { id: string } = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance escape, see above
  Contribution = any,
> {
  /** Stable projector id (e.g. `'user-schemas'`). */
  readonly id: string
  /** Meta-type of the blocks this projector watches. */
  readonly metaType: string
  /** Facet whose `'user-data'` bucket receives the contributions. */
  readonly targetFacet: Facet<Contribution, unknown>
  /** Runtime-contribution source id (always `'user-data'` today). */
  readonly sourceId: string
  /** Other projector ids that must start before this one (so their
   *  handles are available to `project` via the ctx). */
  readonly dependsOn?: readonly string[]
  /** Build a contribution from a row, or null to skip it. */
  project(row: Row, ctx: ProjectorBuildContext): Contribution | null
  /** Registry key for a contribution (schema name / type id) — drives
   *  the `blockIdForKey` index. */
  keyOf(contribution: Contribution): string
  /** Map the delivered raw rows into the form `project` expects.
   *  Omit for raw `BlockData` (schemas); types hydrate to `Block`
   *  facades through `ctx.repo.block`. */
  hydrate?(rows: readonly BlockData[], ctx: ProjectorBuildContext): readonly Row[]
  /** Short-circuit a rebuild when nothing materially changed. Types
   *  use it to break the feedback loop with the propertySchemas
   *  rebuild step; schemas omit it (always republish). */
  dedup?(next: readonly Contribution[], prev: readonly Contribution[]): boolean
  /** Subscribe to an external dependency change that should re-resolve
   *  this projector (schemas: `onValuePresetsChange`; types:
   *  `onPropertySchemasChange`). Returns its disposer. */
  secondarySignal?(repo: Repo, rebuild: () => void): Unsubscribe
}

/** Type-erased descriptor as stored in the facet — mirrors the
 *  `AnyMutator` / `AnyQuery` variance-escape convention. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance escape for facet storage
export type AnyDefinitionBlockProjector = DefinitionBlockProjector<any, any>

/** One running projector. Private to this module — `ProjectorRuntime`
 *  owns instances; everything else reads through `ProjectorHandle`. */
class ProjectorLifecycle<Row extends { id: string }, Contribution>
  implements ProjectorHandle<Contribution> {
  private contributions: readonly Contribution[] = []
  /** key (schema name / type id) -> source block id. */
  private byKey = new Map<string, string>()
  /** source block id -> resolved contribution. */
  private byBlockId = new Map<string, Contribution>()
  /** Latest rows captured by the subscription, in the hydrated form
   *  `project` consumes. Stored so the secondary signal re-resolves
   *  without a fresh DB read. */
  private latestRows: readonly Row[] = []
  private subscriptionDisposer: Unsubscribe | null = null
  private secondaryDisposer: Unsubscribe | null = null
  /** True once the workspace-pinned subscription has delivered its
   *  first tick. Gates the secondary-signal rebuild. */
  private primed = false
  private pinnedWorkspaceId: string | null = null
  /** Monotonic lifecycle token: callbacks captured by an outgoing workspace
   * cannot publish after the persistent container is re-armed for another. */
  private generation = 0
  private primeDeferred: PrimeDeferred | null = null
  /** False until dispose(); the in-flight-write guard (see module header).
   * Repo pinning starts the lifecycle before imperative schema writes; a
   * later workspace re-arms the persistent container with a new generation. */
  private disposed = false

  constructor(
    private readonly repo: Repo,
    private readonly descriptor: DefinitionBlockProjector<Row, Contribution>,
    private readonly ctx: ProjectorBuildContext,
  ) {}

  start(workspaceId: string): void {
    if (this.subscriptionDisposer) {
      throw new Error(`[projector ${this.descriptor.id}] already started`)
    }
    if (!workspaceId) {
      throw new Error(`[projector ${this.descriptor.id}] no active workspace at start()`)
    }
    if (this.pinnedWorkspaceId && this.pinnedWorkspaceId !== workspaceId) {
      this.clearWorkspaceBucket(this.pinnedWorkspaceId)
      this.resetState()
    }
    // Re-arm after a prior dispose (the container is reused across
    // workspace switches; see ProjectorRuntime).
    this.disposed = false
    this.pinnedWorkspaceId = workspaceId
    const generation = ++this.generation
    this.primeDeferred = createPrimeDeferred(workspaceId, generation)

    try {
      this.subscriptionDisposer = this.repo.subscribeBlocks(
        { workspaceId, types: [this.descriptor.metaType] },
        rows => {
          if (this.disposed || this.generation !== generation) return
          this.rebuild(this.hydrate(rows))
        },
      )

      const secondarySignal = this.descriptor.secondarySignal
      if (secondarySignal) {
        this.secondaryDisposer = secondarySignal(this.repo, () => {
          // Ignore until our own subscription has primed (workspace-switch
          // handoff: another projector may publish first and fire this
          // signal) and never run after teardown.
          if (!this.primed || this.disposed || this.generation !== generation) return
          this.rebuild(this.latestRows)
        })
      }
    } catch (error) {
      // startById cannot return a disposer when startup throws, so the
      // lifecycle must unwind its own partially-acquired subscriptions.
      this.dispose()
      throw error
    }
  }

  dispose(): void {
    const workspaceId = this.pinnedWorkspaceId
    this.primeDeferred?.settle('cancelled')
    this.primeDeferred = null
    this.disposed = true
    this.generation += 1
    this.subscriptionDisposer?.()
    this.subscriptionDisposer = null
    this.secondaryDisposer?.()
    this.secondaryDisposer = null
    // Reset in-memory state AND clear the bucket — the invariant that
    // diverged between the two copied services (see module header).
    this.resetState()
    this.pinnedWorkspaceId = null
    if (workspaceId) this.clearWorkspaceBucket(workspaceId)
  }

  blockIdForKey(key: string): string | undefined {
    return this.byKey.get(key)
  }

  contributionForBlockId(blockId: string): Contribution | undefined {
    return this.byBlockId.get(blockId)
  }

  isPrimedFor(workspaceId: string): boolean {
    return this.pinnedWorkspaceId === workspaceId && this.primed
  }

  whenPrimed(workspaceId: string): Promise<void> {
    const deferred = this.primeDeferred
    if (
      this.pinnedWorkspaceId !== workspaceId ||
      !this.subscriptionDisposer ||
      !deferred ||
      deferred.workspaceId !== workspaceId ||
      deferred.generation !== this.generation
    ) {
      return Promise.reject(new Error(
        `[projector ${this.descriptor.id}] ${workspaceId} projector readiness unavailable`,
      ))
    }
    if (this.primed) return Promise.resolve()
    return deferred.promise.then(outcome => {
      if (outcome === 'cancelled') {
        throw new Error(`${workspaceId} projector readiness cancelled`)
      }
    })
  }

  upsert(contribution: Contribution, blockId: string, workspaceId: string): void {
    if (this.disposed) return
    if (this.pinnedWorkspaceId === null) {
      throw new Error(`[projector ${this.descriptor.id}] upsert before workspace pin`)
    }
    if (this.pinnedWorkspaceId !== workspaceId) return
    const key = this.descriptor.keyOf(contribution)
    this.contributions = [
      ...this.contributions.filter(c => this.descriptor.keyOf(c) !== key),
      contribution,
    ]
    this.byKey.set(key, blockId)
    this.byBlockId.set(blockId, contribution)
    this.publish()
  }

  private hydrate(rows: readonly BlockData[]): readonly Row[] {
    return this.descriptor.hydrate
      ? this.descriptor.hydrate(rows, this.ctx)
      : (rows as readonly unknown[] as readonly Row[])
  }

  private rebuild(rows: readonly Row[]): void {
    if (this.disposed) return
    this.latestRows = rows
    this.primed = true
    this.primeDeferred?.settle('primed')
    const next: Contribution[] = []
    const nextByKey = new Map<string, string>()
    const nextByBlockId = new Map<string, Contribution>()
    for (const row of rows) {
      // Per-row isolation: project() decodes user-writable properties
      // (codec throws on malformed values — e.g. a string written into
      // a boolean prop via the agent bridge or an import). One bad
      // definition block must degrade to "that row is skipped", not
      // freeze the whole registry with an exception in the
      // subscription callback.
      let built: Contribution | null | undefined
      try {
        built = this.descriptor.project(row, this.ctx)
      } catch (err) {
        console.warn(
          `[projector ${this.descriptor.id}] project() failed for block ${row.id}; skipping row`,
          err,
        )
        continue
      }
      if (built) {
        next.push(built)
        nextByKey.set(this.descriptor.keyOf(built), row.id)
        nextByBlockId.set(row.id, built)
      }
    }
    // Skip AFTER priming + capturing latestRows so the secondary path
    // still has fresh rows to re-resolve from on the next signal.
    if (this.descriptor.dedup?.(next, this.contributions)) return
    this.contributions = next
    this.byKey = nextByKey
    this.byBlockId = nextByBlockId
    this.publish()
  }

  private publish(): void {
    if (this.disposed || !this.pinnedWorkspaceId) return
    this.repo.setRuntimeContributions(
      this.descriptor.targetFacet,
      this.descriptor.sourceId,
      this.contributions,
      {workspaceId: this.pinnedWorkspaceId},
    )
  }

  private clearWorkspaceBucket(workspaceId: string): void {
    this.repo.setRuntimeContributions(
      this.descriptor.targetFacet,
      this.descriptor.sourceId,
      [],
      {workspaceId},
    )
  }

  private resetState(): void {
    this.latestRows = []
    this.contributions = []
    this.byKey = new Map()
    this.byBlockId = new Map()
    this.primed = false
  }

}

interface PinnedProjectorGeneration {
  readonly workspaceId: string
  readonly descriptorIds: readonly string[]
  readonly dispose: Unsubscribe
}

/** Registry + driver for definition-block projectors. One instance per
 *  Repo (`repo.projectors`).
 *
 *  Each registered projector's lifecycle container is created lazily and
 *  kept across workspace generations. Keeping the disposed container
 *  (rather than deleting + recreating it) makes the `disposed` in-flight
 *  guard durable: a write completing after a workspace-switch teardown
 *  re-reads the same disposed container and no-ops instead of resurrecting
 *  a fresh container that would republish. Removed descriptors are hidden
 *  from new handle lookups; callbacks that captured their old container
 *  still see its durable disposed guard.
 *  The Repo pin re-arms a reused container; teardown deactivates + resets it. */
export class ProjectorRuntime {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous lifecycles share the registry slot
  private readonly lifecycles = new Map<string, ProjectorLifecycle<any, any>>()
  private readonly ctx: ProjectorBuildContext
  private pinnedGeneration: PinnedProjectorGeneration | null = null

  constructor(private readonly repo: Repo) {
    this.ctx = {
      repo,
      handle: id => this.obtain(id),
    }
  }

  get workspaceId(): string | null {
    return this.pinnedGeneration?.workspaceId ?? null
  }

  /** Read handle onto a projector's state — for the service facades and
   *  cross-projector `ctx` lookups. Lazily materialises the container
   *  from the facet descriptor; undefined only when no projector with
   *  that id is registered. */
  handle<Contribution = unknown>(projectorId: string): ProjectorHandle<Contribution> | undefined {
    return this.obtain(projectorId) as ProjectorHandle<Contribution> | undefined
  }

  /** Internal start for one descriptor in the Repo pin's generation. */
  private startById(projectorId: string, workspaceId: string): Unsubscribe {
    if (!workspaceId) throw new Error(`[ProjectorRuntime] no active workspace for ${projectorId}`)
    const lifecycle = this.obtain(projectorId)
    if (!lifecycle) {
      throw new Error(`[ProjectorRuntime] no projector registered with id ${projectorId}`)
    }
    lifecycle.start(workspaceId)
    return () => this.disposeProjector(projectorId)
  }

  /** Snapshot and start one complete projector generation. */
  private startGeneration(
    workspaceId: string,
    descriptors: readonly AnyDefinitionBlockProjector[],
  ): PinnedProjectorGeneration {
    if (!workspaceId) throw new Error('[ProjectorRuntime] no active workspace')
    const ordered = orderByDependencies(descriptors)
    const disposers: Unsubscribe[] = []
    const disposeStarted = (): void => {
      for (let i = disposers.length - 1; i >= 0; i--) disposers[i]()
    }
    for (const descriptor of ordered) {
      try {
        disposers.push(this.startById(descriptor.id, workspaceId))
      } catch (err) {
        // Roll back the projectors already started this call so a partial
        // failure can't strand live subscriptions the caller never got a
        // disposer for.
        disposeStarted()
        throw err
      }
    }
    return {
      workspaceId,
      descriptorIds: descriptors.map(descriptor => descriptor.id),
      dispose: disposeStarted,
    }
  }

  /** Deactivate + reset a projector (idempotent). The container is kept
   *  for reuse / the in-flight guard (see class doc). */
  private disposeProjector(projectorId: string): void {
    this.lifecycles.get(projectorId)?.dispose()
  }

  /** Repo workspace-pin owner. Synchronously tears down the outgoing
   * generation and starts every projector for the incoming workspace. */
  pinWorkspace(workspaceId: string | null): void {
    const descriptors = workspaceId ? this.descriptors() : []
    const descriptorIds = descriptors.map(descriptor => descriptor.id)
    const previous = this.pinnedGeneration
    if (
      workspaceId === previous?.workspaceId &&
      descriptorIds.length === previous.descriptorIds.length &&
      descriptorIds.every((id, index) => id === previous.descriptorIds[index])
    ) return
    previous?.dispose()
    this.pinnedGeneration = null
    if (!workspaceId) return
    try {
      this.pinnedGeneration = this.startGeneration(workspaceId, descriptors)
    } catch (error) {
      if (previous) {
        try {
          this.pinnedGeneration = this.startGeneration(previous.workspaceId, this.descriptors())
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `[ProjectorRuntime] failed to pin ${workspaceId} and restore ${previous.workspaceId}`,
            {cause: rollbackError},
          )
        }
      }
      throw error
    }
  }

  isPrimed(workspaceId: string): boolean {
    const descriptors = this.descriptors()
    return descriptors.every(descriptor =>
      this.obtain(descriptor.id)?.isPrimedFor(workspaceId) === true,
    )
  }

  async whenPrimed(workspaceId: string): Promise<void> {
    const descriptors = this.descriptors()
    await Promise.all(descriptors.map(descriptor => {
      const lifecycle = this.obtain(descriptor.id)
      if (!lifecycle) throw new Error(`[ProjectorRuntime] missing projector ${descriptor.id}`)
      return lifecycle.whenPrimed(workspaceId)
    }))
  }

  /** Get-or-create the persistent container for `projectorId`, resolving
   *  its descriptor from the facet on first access.
   *
   *  Assumes the descriptor for a given id is STABLE for the life of the
   *  Repo: the container caches the descriptor it was first built with, so
   *  a later `setFacetRuntime` swap that re-registered the same id with a
   *  *different* descriptor would keep serving the original. That holds
   *  today — the two projectors are kernel consts registered once, never
   *  overridden — and `definitionBlockProjectorFacet` is not last-wins, so
   *  a duplicate id surfaces as a `startAll` double-start throw rather than
   *  a silent swap. Revisit this caching if projectors ever become
   *  per-id-overridable (e.g. plugin-replaceable descriptors). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- container generics are erased at the registry boundary
  private obtain(projectorId: string): ProjectorLifecycle<any, any> | undefined {
    const descriptor = this.descriptors().find(d => d.id === projectorId)
    if (!descriptor) return undefined
    const existing = this.lifecycles.get(projectorId)
    if (existing) return existing
    const lifecycle = new ProjectorLifecycle(this.repo, descriptor, this.ctx)
    this.lifecycles.set(projectorId, lifecycle)
    return lifecycle
  }

  private descriptors(): readonly AnyDefinitionBlockProjector[] {
    const runtime = this.repo.facetRuntime
    if (!runtime) throw new Error('[ProjectorRuntime] no FacetRuntime installed')
    return runtime.read(definitionBlockProjectorFacet)
  }
}

/** Stable topological order honoring `dependsOn`. Keeps registration
 *  order among independent projectors; throws on a dependency cycle. */
function orderByDependencies(
  descriptors: readonly AnyDefinitionBlockProjector[],
): readonly AnyDefinitionBlockProjector[] {
  const byId = new Map(descriptors.map(d => [d.id, d]))
  const ordered: AnyDefinitionBlockProjector[] = []
  const done = new Set<string>()
  const onStack = new Set<string>()
  const visit = (descriptor: AnyDefinitionBlockProjector): void => {
    if (done.has(descriptor.id)) return
    if (onStack.has(descriptor.id)) {
      throw new Error(`[ProjectorRuntime] dependency cycle at projector ${descriptor.id}`)
    }
    onStack.add(descriptor.id)
    for (const depId of descriptor.dependsOn ?? []) {
      const dep = byId.get(depId)
      if (dep) visit(dep)
    }
    onStack.delete(descriptor.id)
    done.add(descriptor.id)
    ordered.push(descriptor)
  }
  for (const descriptor of descriptors) visit(descriptor)
  return ordered
}
