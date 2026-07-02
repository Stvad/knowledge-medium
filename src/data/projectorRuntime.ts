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
 *    - on dispose: reset in-memory state AND clear the bucket (the Repo
 *      is a per-user singleton reused across workspace switches and
 *      `setFacetRuntime` carries durable buckets forward, so a stale
 *      bucket would leak into the next workspace until its first tick);
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
   *  No-op once the container is disposed (guards a publish from a
   *  torn-down container; see the module header for the cross-workspace
   *  limit this does NOT cover). */
  upsert(contribution: Contribution, blockId: string): void
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
  /** False until dispose(); the in-flight-write guard (see module
   *  header). Starts false so the synchronous write path (`upsert`,
   *  used by schemas' `addSchema`) works even when the subscription was
   *  never started — e.g. the Roam importer registers schemas in batch
   *  without a live workspace subscription. `start()` re-arms it after a
   *  prior dispose so a reused container publishes again. */
  private disposed = false

  constructor(
    private readonly repo: Repo,
    private readonly descriptor: DefinitionBlockProjector<Row, Contribution>,
    private readonly ctx: ProjectorBuildContext,
  ) {}

  start(): void {
    if (this.subscriptionDisposer) {
      throw new Error(`[projector ${this.descriptor.id}] already started`)
    }
    // Pin the workspace at start() time. The driver restarts projectors
    // on workspace switch, so capturing here pairs the subscription's
    // lifetime to one workspace explicitly.
    const workspaceId = this.repo.activeWorkspaceId
    if (!workspaceId) {
      throw new Error(`[projector ${this.descriptor.id}] no active workspace at start()`)
    }
    // Re-arm after a prior dispose (the container is reused across
    // workspace switches; see ProjectorRuntime).
    this.disposed = false

    this.subscriptionDisposer = this.repo.subscribeBlocks(
      { workspaceId, types: [this.descriptor.metaType] },
      rows => this.rebuild(this.hydrate(rows)),
    )

    const secondarySignal = this.descriptor.secondarySignal
    if (secondarySignal) {
      this.secondaryDisposer = secondarySignal(this.repo, () => {
        // Ignore until our own subscription has primed (workspace-switch
        // handoff: another projector may publish first and fire this
        // signal) and never run after teardown.
        if (!this.primed || this.disposed) return
        this.rebuild(this.latestRows)
      })
    }
  }

  dispose(): void {
    this.disposed = true
    this.subscriptionDisposer?.()
    this.subscriptionDisposer = null
    this.secondaryDisposer?.()
    this.secondaryDisposer = null
    // Reset in-memory state AND clear the bucket — the invariant that
    // diverged between the two copied services (see module header).
    this.latestRows = []
    this.contributions = []
    this.byKey = new Map()
    this.byBlockId = new Map()
    this.primed = false
    this.repo.setRuntimeContributions(this.descriptor.targetFacet, this.descriptor.sourceId, [])
  }

  blockIdForKey(key: string): string | undefined {
    return this.byKey.get(key)
  }

  contributionForBlockId(blockId: string): Contribution | undefined {
    return this.byBlockId.get(blockId)
  }

  upsert(contribution: Contribution, blockId: string): void {
    if (this.disposed) return
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
    if (this.disposed) return
    this.repo.setRuntimeContributions(
      this.descriptor.targetFacet,
      this.descriptor.sourceId,
      this.contributions,
    )
  }
}

/** Registry + driver for definition-block projectors. One instance per
 *  Repo (`repo.projectors`).
 *
 *  Each projector's lifecycle container is created lazily and KEPT for
 *  the life of the Repo — not torn down on `dispose`. Two reasons:
 *    - the synchronous write path / read getters must work without a
 *      live subscription (the importer registers schemas in batch; the
 *      property panel reads `getSchemaForBlockId` before any start);
 *    - keeping the disposed container (rather than deleting + lazily
 *      re-creating a fresh one) is what makes the `disposed` in-flight
 *      guard durable: a write completing after a workspace-switch
 *      teardown re-reads the SAME disposed container and no-ops, instead
 *      of resurrecting a fresh container that would republish.
 *  `start()` re-arms a reused container; `dispose()` just deactivates +
 *  resets it. */
export class ProjectorRuntime {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous lifecycles share the registry slot
  private readonly lifecycles = new Map<string, ProjectorLifecycle<any, any>>()
  private readonly ctx: ProjectorBuildContext

  constructor(private readonly repo: Repo) {
    this.ctx = {
      repo,
      handle: id => this.obtain(id),
    }
  }

  /** Read handle onto a projector's state — for the service facades and
   *  cross-projector `ctx` lookups. Lazily materialises the container
   *  from the facet descriptor; undefined only when no projector with
   *  that id is registered. */
  handle<Contribution = unknown>(projectorId: string): ProjectorHandle<Contribution> | undefined {
    return this.obtain(projectorId) as ProjectorHandle<Contribution> | undefined
  }

  /** Start a projector by id, resolving its descriptor from
   *  `definitionBlockProjectorFacet`. The service facades' `start()`
   *  funnel through here so the descriptor stays data-defined. Throws on
   *  double-start (the `[...] already started` invariant). Returns a
   *  disposer. */
  startById(projectorId: string): Unsubscribe {
    const lifecycle = this.obtain(projectorId)
    if (!lifecycle) {
      throw new Error(`[ProjectorRuntime] no projector registered with id ${projectorId}`)
    }
    lifecycle.start()
    return () => this.disposeProjector(projectorId)
  }

  /** Start every registered projector in dependency order — the
   *  production entry point. Adding a projector is then just registering
   *  a descriptor. Returns a disposer that tears them down in reverse. */
  startAll(): Unsubscribe {
    const ordered = orderByDependencies(this.descriptors())
    const disposers: Unsubscribe[] = []
    const disposeStarted = (): void => {
      for (let i = disposers.length - 1; i >= 0; i--) disposers[i]()
    }
    for (const descriptor of ordered) {
      try {
        disposers.push(this.startById(descriptor.id))
      } catch (err) {
        // Roll back the projectors already started this call so a partial
        // failure can't strand live subscriptions the caller never got a
        // disposer for.
        disposeStarted()
        throw err
      }
    }
    return disposeStarted
  }

  /** Deactivate + reset a projector (idempotent). The container is kept
   *  for reuse / the in-flight guard (see class doc). */
  disposeProjector(projectorId: string): void {
    this.lifecycles.get(projectorId)?.dispose()
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
    const existing = this.lifecycles.get(projectorId)
    if (existing) return existing
    const descriptor = this.descriptors().find(d => d.id === projectorId)
    if (!descriptor) return undefined
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
