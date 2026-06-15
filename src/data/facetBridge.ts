/**
 * Facet→registry bridge (audit D1(c)). The data layer bootstraps its
 * registries directly, but a `FacetRuntime` is the source of truth for the
 * merged kernel + plugin contribution set; this bridge keeps the two in
 * sync. It owns:
 *
 *   - the installed `FacetRuntime` + the per-facet `onFacetChange`
 *     subscriptions;
 *   - the named **rebuild steps** (each declares the facets it reads, so a
 *     single runtime-contribution change re-runs only the affected steps);
 *   - the React-facing change channels (`propertySchemas`, `types`,
 *     `propertyEditorOverrides`, `valuePresets`).
 *
 * It does NOT own the registries themselves — those stay on `Repo` (the
 * dispatch surface). A step writes its result back through the
 * `FacetBridgeTarget` callbacks, so the bridge is unit-testable with a
 * plain mock target and a `FacetRuntime`, no full `Repo` required.
 *
 * Swap ordering is preserved exactly (spec §8): replay the outgoing
 * runtime's runtime-contributions → run every rebuild step → (re)wire the
 * per-facet change listeners.
 */

import type {
  AnyMutator,
  AnyPostCommitProcessor,
  AnyPropertyEditorOverride,
  AnyPropertySchema,
  AnyQuery,
  AnySameTxProcessor,
  AnyValuePreset,
  TypeContribution,
} from '@/data/api'
import type { Facet, FacetRuntime } from '@/facets/facet'
import { CallbackSet } from '@/utils/callbackSet'
import type { InvalidationRule } from './invalidation'
import {
  invalidationRulesFacet,
  mutatorsFacet,
  postCommitProcessorsFacet,
  propertyEditorOverridesFacet,
  propertySchemasFacet,
  queriesFacet,
  sameTxProcessorsFacet,
  typesFacet,
  valuePresetsFacet,
  workspaceBackfillsFacet,
  type WorkspaceBackfill,
} from './facets'
import { changedRefSchemaNames, mergeLiftedSchemas } from './internals/refProjection'

/** A named rebuild step. Declares which facets it reads via `inputs` so
 *  the runtime-contribution path can run only the steps whose inputs
 *  changed. Outputs are written to the target by the `run` callback's
 *  side effect; we don't return them so the framework stays minimal. */
interface RebuildStep {
  readonly id: string
  readonly inputs: readonly Facet<unknown, unknown>[]
  readonly run: (runtime: FacetRuntime) => void
}

/** Sink the bridge writes facet-derived state into — implemented by `Repo`
 *  as closures over its registries. Keeping it a callback bag (rather than
 *  a `Repo` reference) keeps the bridge decoupled and testable. */
export interface FacetBridgeTarget {
  /** Current merged property-schema map, read as the "before" snapshot for
   *  the ref-change diff that decides whether a swap needs reprojection. */
  getPropertySchemas(): ReadonlyMap<string, AnyPropertySchema>
  applyMutators(mutators: Map<string, AnyMutator>): void
  applyProcessors(processors: Map<string, AnyPostCommitProcessor>): void
  applySameTxProcessors(processors: Map<string, AnySameTxProcessor>): void
  applyInvalidationRules(rules: readonly InvalidationRule[]): void
  applyWorkspaceBackfills(backfills: readonly WorkspaceBackfill[]): void
  applyTypesAndSchemas(
    types: ReadonlyMap<string, TypeContribution>,
    propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
  ): void
  applyPropertyEditorOverrides(overrides: ReadonlyMap<string, AnyPropertyEditorOverride>): void
  applyValuePresets(presets: ReadonlyMap<string, AnyValuePreset>): void
  applyQueries(queries: Map<string, AnyQuery>): void
  /** Defer a ref-typed-property reprojection for the names whose ref-ness
   *  changed in this swap (off the cold-start critical path). */
  scheduleReprojection(
    names: readonly string[],
    schemas: ReadonlyMap<string, AnyPropertySchema>,
  ): void
}

export class FacetBridge {
  /** Currently-installed FacetRuntime. Null until the first
   *  `setFacetRuntime` call. */
  private runtime: FacetRuntime | null = null
  /** Per-facet listener disposers from `onFacetChange` registrations.
   *  Cleared when `setFacetRuntime` swaps to a fresh runtime — old
   *  listeners would fire against stale rebuild closures otherwise. */
  private runtimeFacetUnsubs: Array<() => void> = []
  /** Durable runtime contribution buckets. Persisted across
   *  `setFacetRuntime` swaps and replayed onto the fresh runtime so
   *  user-data schemas (et al.) added via `setRuntimeContributions`
   *  survive the dynamic-extension reload. Without this, a bucket would
   *  live only on whichever FacetRuntime was current when it was set and
   *  evaporate on the next swap.
   *
   *  Scope note: this mirrors only buckets written through *this* method
   *  (durable owners — `UserSchemasService` / `UserTypesService`). App
   *  effects that write directly to `runtime.setRuntimeContributions`
   *  (e.g. the theme apply-actions / keybinding overrides) are NOT
   *  mirrored here — they re-push on their own restart each swap, so
   *  replaying them would strand stale contributions when their owning
   *  plugin is toggled off. */
  private readonly runtimeContributionBuckets = new Map<string, Map<string, readonly unknown[]>>()
  /** Per-facet refs needed to replay buckets onto a fresh runtime —
   *  `setRuntimeContributions` takes a `Facet` reference (not a string
   *  id), so we cache it the first time the caller passes one. */
  private readonly runtimeContributionFacets = new Map<string, Facet<unknown, unknown>>()

  /** Listeners for property-schema map changes (full rebuild OR
   *  runtime-bucket update). Used by `usePropertySchemas` to drive React
   *  reruns. */
  private readonly propertySchemasListeners = new CallbackSet<[]>('Repo.propertySchemas')
  /** Listeners for `_types` map changes. Symmetric to
   *  propertySchemasListeners. Used by `createTypeBlock`'s commit→
   *  registration handoff to bridge two txs without polling. */
  private readonly typesListeners = new CallbackSet<[]>('Repo.types')
  /** Listeners for property-editor-override map changes. */
  private readonly propertyEditorOverridesListeners = new CallbackSet<[]>('Repo.propertyEditorOverrides')
  /** Listeners for value-preset map changes. */
  private readonly valuePresetsListeners = new CallbackSet<[]>('Repo.valuePresets')

  private readonly rebuildSteps: readonly RebuildStep[]

  constructor(private readonly target: FacetBridgeTarget) {
    this.rebuildSteps = this.makeRebuildSteps()
  }

  /** Read-only handle on the currently-installed FacetRuntime. Used by
   *  non-React callers that need to consult facets at action-handler time
   *  (e.g. `pickBlockDateAdapter` from a multi-select handler where
   *  `useAppRuntime()` isn't available). Returns null before the first
   *  `setFacetRuntime` call. */
  get facetRuntime(): FacetRuntime | null {
    return this.runtime
  }

  /** Update the data-layer registries from a FacetRuntime (spec §8).
   *  Decomposes into the named rebuild steps; the same set runs for full
   *  swaps and for the per-facet `setRuntimeContributions` change path. */
  setFacetRuntime(runtime: FacetRuntime): void {
    // Drop any per-facet change subscriptions on the previous runtime —
    // we're about to rewire to a fresh one. Subscriptions live on the
    // FacetRuntime instance, so swapping runtimes implicitly drops them;
    // this list just clears our tracking.
    for (const dispose of this.runtimeFacetUnsubs) dispose()
    this.runtimeFacetUnsubs = []

    this.runtime = runtime

    // Replay the persisted durable contribution buckets onto the fresh
    // runtime so user-data schemas survive the swap. Doing this before
    // running rebuild steps means the steps see the merged view on first
    // read (no flicker through a state where user-data is missing and
    // then re-added).
    for (const [facetId, bucketsBySource] of this.runtimeContributionBuckets) {
      const facet = this.runtimeContributionFacets.get(facetId)
      if (!facet) continue
      for (const [sourceId, contributions] of bucketsBySource) {
        runtime.setRuntimeContributions(facet, sourceId, contributions)
      }
    }

    // Run every rebuild step on the fresh runtime.
    for (const step of this.rebuildSteps) step.run(runtime)

    // Wire per-facet change notifications: when a runtime-contribution
    // bucket on `facet` changes, re-run only the steps that read it.
    const stepsByFacetId = new Map<string, RebuildStep[]>()
    for (const step of this.rebuildSteps) {
      for (const input of step.inputs) {
        const list = stepsByFacetId.get(input.id) ?? []
        list.push(step)
        stepsByFacetId.set(input.id, list)
      }
    }
    for (const [facetId, steps] of stepsByFacetId) {
      const unsub = runtime.onFacetChange(facetId, () => {
        for (const step of steps) step.run(runtime)
      })
      this.runtimeFacetUnsubs.push(unsub)
    }
  }

  /** Replace the durable runtime contribution bucket for `facet` keyed by
   *  `sourceId`. Triggers a re-run of every rebuild step whose declared
   *  inputs include this facet (via the `onFacetChange` listener wired in
   *  `setFacetRuntime`), plus per-facet listener fan-out for React
   *  subscribers. The bucket is persisted here so it survives the next
   *  `setFacetRuntime` swap. Throws if no runtime is installed. */
  setRuntimeContributions<Input>(
    facet: Facet<Input, unknown>,
    sourceId: string,
    contributions: readonly Input[],
  ): void {
    if (!this.runtime) {
      throw new Error('[FacetBridge.setRuntimeContributions] called before setFacetRuntime')
    }
    // Persist the bucket so it survives `setFacetRuntime` swaps. We also
    // cache the facet reference (the runtime's setRuntimeContributions
    // takes a Facet, not just an id).
    this.runtimeContributionFacets.set(facet.id, facet as Facet<unknown, unknown>)
    let bucketsBySource = this.runtimeContributionBuckets.get(facet.id)
    if (contributions.length === 0) {
      bucketsBySource?.delete(sourceId)
      if (bucketsBySource && bucketsBySource.size === 0) {
        this.runtimeContributionBuckets.delete(facet.id)
        this.runtimeContributionFacets.delete(facet.id)
      }
    } else {
      if (!bucketsBySource) {
        bucketsBySource = new Map<string, readonly unknown[]>()
        this.runtimeContributionBuckets.set(facet.id, bucketsBySource)
      }
      bucketsBySource.set(sourceId, contributions as readonly unknown[])
    }
    this.runtime.setRuntimeContributions(facet, sourceId, contributions)
  }

  onPropertySchemasChange(listener: () => void): () => void {
    return this.propertySchemasListeners.add(listener)
  }

  onTypesChange(listener: () => void): () => void {
    return this.typesListeners.add(listener)
  }

  onPropertyEditorOverridesChange(listener: () => void): () => void {
    return this.propertyEditorOverridesListeners.add(listener)
  }

  onValuePresetsChange(listener: () => void): () => void {
    return this.valuePresetsListeners.add(listener)
  }

  /** Rebuild step list. Order matters: types runs before propertySchemas
   *  (the merge folds in type-lifted schemas); propertySchemas runs before
   *  the query swap if a future step ever needs it. */
  private makeRebuildSteps(): readonly RebuildStep[] {
    const target = this.target
    return [
      {
        id: 'mutators',
        inputs: [mutatorsFacet as Facet<unknown, unknown>],
        run: (rt) => { target.applyMutators(new Map(rt.read(mutatorsFacet))) },
      },
      {
        id: 'processors',
        inputs: [postCommitProcessorsFacet as Facet<unknown, unknown>],
        run: (rt) => { target.applyProcessors(new Map(rt.read(postCommitProcessorsFacet))) },
      },
      {
        id: 'sameTxProcessors',
        inputs: [sameTxProcessorsFacet as Facet<unknown, unknown>],
        run: (rt) => { target.applySameTxProcessors(new Map(rt.read(sameTxProcessorsFacet))) },
      },
      {
        id: 'invalidationRules',
        inputs: [invalidationRulesFacet as Facet<unknown, unknown>],
        run: (rt) => { target.applyInvalidationRules(rt.read(invalidationRulesFacet)) },
      },
      {
        id: 'workspaceBackfills',
        inputs: [workspaceBackfillsFacet as Facet<unknown, unknown>],
        run: (rt) => { target.applyWorkspaceBackfills(rt.read(workspaceBackfillsFacet)) },
      },
      {
        // Reads typesFacet AND propertySchemasFacet — both inputs feed
        // mergeLiftedSchemas, so a change to either re-runs the merge.
        id: 'propertySchemas',
        inputs: [
          typesFacet as Facet<unknown, unknown>,
          propertySchemasFacet as Facet<unknown, unknown>,
        ],
        run: (rt) => {
          const previousPropertySchemas = target.getPropertySchemas()
          const types = rt.read(typesFacet)
          const propertySchemas = mergeLiftedSchemas(rt.read(propertySchemasFacet), types)
          target.applyTypesAndSchemas(types, propertySchemas)
          const refSchemaChanges = changedRefSchemaNames(previousPropertySchemas, propertySchemas)
          if (refSchemaChanges.length > 0) {
            target.scheduleReprojection(refSchemaChanges, propertySchemas)
          }
          // Notify React subscribers (usePropertySchemas) so panels
          // re-render against the new merged map.
          this.propertySchemasListeners.notify()
          // Notify types subscribers (createTypeBlock's commit→registration
          // bridge, future useTypes-style hooks). Fires unconditionally —
          // same convention as propertySchemasListeners: "the step that owns
          // this map ran" not "this map changed." Spurious firings are
          // tolerated by consumers.
          this.typesListeners.notify()
        },
      },
      {
        id: 'propertyEditorOverrides',
        inputs: [propertyEditorOverridesFacet as Facet<unknown, unknown>],
        run: (rt) => {
          target.applyPropertyEditorOverrides(rt.read(propertyEditorOverridesFacet))
          this.propertyEditorOverridesListeners.notify()
        },
      },
      {
        id: 'valuePresets',
        inputs: [valuePresetsFacet as Facet<unknown, unknown>],
        run: (rt) => {
          target.applyValuePresets(rt.read(valuePresetsFacet))
          this.valuePresetsListeners.notify()
        },
      },
      {
        id: 'queries',
        inputs: [queriesFacet as Facet<unknown, unknown>],
        run: (rt) => { target.applyQueries(new Map(rt.read(queriesFacet))) },
      },
    ]
  }
}
