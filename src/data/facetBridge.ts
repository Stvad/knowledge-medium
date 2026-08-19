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
  AnyValuePresetCore,
  TypeContribution,
} from '@/data/api'
import type {PropertyDefinitionRegistrySnapshot} from '@/data/propertyDefinitionRegistry'
import {
  buildPropertyDefinitionRegistry,
  buildUnboundPropertySchemas,
} from '@/data/propertyDefinitionRegistry'
import type {TypeDefinitionRegistrySnapshot} from '@/data/typeDefinitionRegistry'
import {
  buildTypeDefinitionRegistry,
  buildUnboundTypes,
  harvestNestedPropertySeeds,
} from '@/data/typeDefinitionRegistry'
import type {
  Facet,
  FacetRuntime,
  WorkspaceRuntimeContributionOptions,
} from '@/facets/facet'
import { CallbackSet } from '@/utils/callbackSet'
import type { InvalidationRule } from './invalidation'
import {
  invalidationRulesFacet,
  definitionSeedsFacet,
  mutatorsFacet,
  postCommitProcessorsFacet,
  propertyEditorOverridesFacet,
  projectedPropertyDefinitionsFacet,
  projectedTypeDefinitionsFacet,
  queriesFacet,
  sameTxProcessorsFacet,
  typeSeedsFacet,
  valuePresetCoresFacet,
  valuePresetPresentationsFacet,
  workspaceBackfillsFacet,
  type WorkspaceBackfill,
} from './facets'
import { changedRefSchemaNames } from './internals/refProjection'
import {
  changedPropertyDefinitions,
  type PropertyDefinitionChange,
} from './internals/propertyDefinitionMigrations'
import {readValuePresetRegistry} from './valuePresetRegistry'

/** A named rebuild step. Declares which facets it reads via `inputs` so
 *  the runtime-contribution path can run only the steps whose inputs
 *  changed. Outputs are written to the target by the `run` callback's
 *  side effect; we don't return them so the framework stays minimal. */
interface RebuildStep {
  readonly id: string
  readonly inputs: readonly Facet<unknown, unknown>[]
  readonly run: (runtime: FacetRuntime) => void
  /** Re-run synchronously when the active-workspace read filter changes. */
  readonly workspaceScoped?: boolean
}

/** Sink the bridge writes facet-derived state into — implemented by `Repo`
 *  as closures over its registries. Keeping it a callback bag (rather than
 *  a `Repo` reference) keeps the bridge decoupled and testable. */
export interface FacetBridgeTarget {
  /** Current merged property-schema map, read as the "before" snapshot for
   *  the ref-change diff that decides whether a swap needs reprojection. */
  getPropertySchemas(): ReadonlyMap<string, AnyPropertySchema>
  /** Whether the workspace's persisted property-definition projection has
   * produced its first complete result. Seed synthesis must not claim names
   * before this is true: an empty projection and a not-yet-loaded projection
   * have different winner semantics. */
  getPropertyDefinitionProjector(): {
    isPrimedFor(workspaceId: string): boolean
  } | undefined
  applyMutators(mutators: Map<string, AnyMutator>): void
  applyProcessors(processors: Map<string, AnyPostCommitProcessor>): void
  applySameTxProcessors(processors: Map<string, AnySameTxProcessor>): void
  applyInvalidationRules(rules: readonly InvalidationRule[]): void
  applyWorkspaceBackfills(backfills: readonly WorkspaceBackfill[]): void
  applyTypesAndSchemas(
    types: ReadonlyMap<string, TypeContribution>,
    propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
    propertyDefinitions: PropertyDefinitionRegistrySnapshot | null,
    propertySeedNameCounts: ReadonlyMap<string, number>,
    typeDefinitions: TypeDefinitionRegistrySnapshot | null,
  ): void
  applyPropertyEditorOverrides(overrides: ReadonlyMap<string, AnyPropertyEditorOverride>): void
  applyValuePresetCores(presets: ReadonlyMap<string, AnyValuePresetCore>): void
  applyQueries(queries: Map<string, AnyQuery>): void
  /** Defer a ref-typed-property reprojection for the names whose ref-ness
   *  changed in this swap (off the cold-start critical path). */
  scheduleReprojection(
    names: readonly string[],
    schemas: ReadonlyMap<string, AnyPropertySchema>,
  ): void
  /** Current property-definition registry snapshot — the "before" side of
   *  the per-fieldId rename/codec diff (PR #288 §7, slice B2). */
  getPropertyDefinitions(): PropertyDefinitionRegistrySnapshot | null
  /** Defer the rename-reproject / codec re-encode migration pass for
   *  definitions whose identity-stable metadata changed in this swap. */
  schedulePropertyDefinitionMigrations(
    workspaceId: string,
    changes: readonly PropertyDefinitionChange[],
  ): void
}

export class FacetBridge {
  /** Currently-installed FacetRuntime. Null until the first
   *  `setFacetRuntime` call. */
  private runtime: FacetRuntime | null = null
  private activeWorkspaceId: string | null = null
  /** Workspace-scoped inputs may each notify during a filter flip. Their
   * owning steps run once after the runtime reaches the complete new view. */
  private workspacePinInProgress = false
  /** Per-facet listener disposers from `onFacetChange` registrations.
   *  Cleared when `setFacetRuntime` swaps to a fresh runtime — old
   *  listeners would fire against stale rebuild closures otherwise. */
  private runtimeFacetUnsubs: Array<() => void> = []
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

    const previous = this.runtime
    this.runtime = runtime

    // Carry the previous runtime's DURABLE runtime-contribution buckets
    // (repo-owned user data — user property schemas / types) forward
    // onto the fresh runtime. This is the runtime's own job now (B1(2)):
    // the bridge no longer keeps a separate mirror. Only durable buckets
    // are adopted, so transient effect-owned buckets can't strand.
    // Doing this before running rebuild steps means the steps see the
    // merged view on first read (no flicker through a state where
    // user-data is missing and then re-added).
    if (previous) runtime.adoptDurableContributionsFrom(previous)
    runtime.setActiveWorkspaceId(this.activeWorkspaceId)

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
        for (const step of steps) {
          if (this.workspacePinInProgress && step.workspaceScoped) continue
          step.run(runtime)
        }
      })
      this.runtimeFacetUnsubs.push(unsub)
    }
  }

  /** Replace the durable runtime contribution bucket for `facet` keyed by
   *  `sourceId`. Triggers a re-run of every rebuild step whose declared
   *  inputs include this facet (via the `onFacetChange` listener wired in
   *  `setFacetRuntime`), plus per-facet listener fan-out for React
   *  subscribers. Written as `{durable: true}` so the runtime carries the
   *  bucket forward across the next `setFacetRuntime` swap
   *  (`adoptDurableContributionsFrom`) — no separate bridge mirror.
   *  Throws if no runtime is installed. */
  setRuntimeContributions<Input>(
    facet: Facet<Input, unknown>,
    sourceId: string,
    contributions: readonly Input[],
    options?: WorkspaceRuntimeContributionOptions,
  ): void {
    if (!this.runtime) {
      throw new Error('[FacetBridge.setRuntimeContributions] called before setFacetRuntime')
    }
    this.runtime.setRuntimeContributions(facet, sourceId, contributions, {
      durable: true,
      workspaceId: options?.workspaceId,
    })
  }

  /** Synchronously flip the workspace filter on the installed runtime.
   * The pin is retained across future runtime swaps. */
  setActiveWorkspaceId(workspaceId: string | null): void {
    this.activeWorkspaceId = workspaceId
    if (this.runtime) {
      this.workspacePinInProgress = true
      try {
        this.runtime.setActiveWorkspaceId(workspaceId)
      } finally {
        this.workspacePinInProgress = false
      }
      for (const step of this.rebuildSteps) {
        if (step.workspaceScoped) step.run(this.runtime)
      }
    }
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

  private unavailableActiveWorkspaceId(): string | null {
    const projector = this.target.getPropertyDefinitionProjector()
    return this.activeWorkspaceId
      && projector?.isPrimedFor(this.activeWorkspaceId) === false
      ? this.activeWorkspaceId
      : null
  }

  private canBuildPropertyDefinitionsForWorkspace(workspaceId: string): boolean {
    return workspaceId !== this.unavailableActiveWorkspaceId()
  }

  /** Rebuild step list. Order matters: value presets run before property
   * schemas so a runtime swap re-resolves block behavior against the incoming
   * cores before the final registry snapshot; types are read by the schema
   * step for the transitional type lift. */
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
        id: 'valuePresets',
        inputs: [
          valuePresetCoresFacet as Facet<unknown, unknown>,
          valuePresetPresentationsFacet as Facet<unknown, unknown>,
        ],
        // Fires on any core/presentation change so `userSchemasService`
        // re-resolves schemas when a preset's plugin loads.
        run: (rt) => {
          const presets = readValuePresetRegistry(rt)
          target.applyValuePresetCores(presets.cores)
          this.valuePresetsListeners.notify()
        },
      },
      {
        // Owns `repo.types` + `propertySchemas`. Types: fold the block-built
        // rows (`projectedTypeDefinitionsFacet`) + declared type seeds
        // (`typeSeedsFacet`) into the declaration-authoritative registry — the
        // sole type source now that the static `typesFacet` registration path
        // is gone (Slice D). Schemas: build the property registry from the
        // property seeds + block-built rows; type-embedded properties reach it
        // as seeds (explicit or harvested — `harvestNestedPropertySeeds`), not
        // via the retired type-lift.
        id: 'propertySchemas',
        inputs: [
          projectedTypeDefinitionsFacet as Facet<unknown, unknown>,
          typeSeedsFacet as Facet<unknown, unknown>,
          projectedPropertyDefinitionsFacet as Facet<unknown, unknown>,
          definitionSeedsFacet as Facet<unknown, unknown>,
        ],
        workspaceScoped: true,
        run: (rt) => {
          const previousPropertySchemas = target.getPropertySchemas()
          const previousPropertyDefinitions = target.getPropertyDefinitions()
          const seedTypes = rt.read(typeSeedsFacet)
          // The type-definition registry needs a workspace to scope its rows;
          // before a pin it stays null (identity resolution / `getTypeBlockId` is
          // correctly unavailable). No priming gate (unlike the property
          // registry): an unprimed projection is simply an empty projected-rows
          // map — the registry then holds only declared seeds, which are
          // code-owned and must be present pre-materialization anyway.
          const typeDefinitions = this.activeWorkspaceId
            ? buildTypeDefinitionRegistry({
              workspaceId: this.activeWorkspaceId,
              projectedDefinitions: rt.read(projectedTypeDefinitionsFacet),
              seeds: seedTypes,
            })
            : null
          // The kernel/plugin type seeds live in `typeSeedsFacet`. Mirror
          // `buildUnboundPropertySchemas` (the `X?.field ?? buildUnbound(...)`
          // shape used for schemas just below): before a workspace pins the
          // registry (and in the runtime-install→first-pin window, where
          // `repo._types` is already facet-driven, not the static `KERNEL_TYPES`
          // fallback) fall back to the unbound seed synthesis so seeded types
          // are still readable.
          const types = typeDefinitions?.typesById ?? buildUnboundTypes(seedTypes)
          const explicitPropertySeeds = rt.read(definitionSeedsFacet)
          // Auto-contribute the property seeds a type embedded in its `properties` but
          // the author didn't seed separately (own-owned only) so an inline-only
          // property still materializes a backing block instead of dangling — see
          // `harvestNestedPropertySeeds`. Scoped to the pinned branch: harvest needs
          // the winner set (`typeDefinitions`), and nothing materializes pre-pin. The
          // harvested seeds flow through the SAME property-registry build below, so
          // they reach schema resolution AND `workspaceSeeds` materialization for free.
          const harvested = typeDefinitions
            ? harvestNestedPropertySeeds(typeDefinitions, explicitPropertySeeds)
            : []
          // Avoid copying the (potentially large) explicit set on every rebuild when
          // no type carries an own-owned inline property — the common case.
          const seeds = harvested.length > 0
            ? [...explicitPropertySeeds, ...harvested]
            : explicitPropertySeeds
          const propertySeedNameCounts = new Map<string, number>()
          for (const seed of seeds) {
            propertySeedNameCounts.set(
              seed.name,
              (propertySeedNameCounts.get(seed.name) ?? 0) + 1,
            )
          }
          const propertyDefinitions = this.activeWorkspaceId
            && this.canBuildPropertyDefinitionsForWorkspace(this.activeWorkspaceId)
            ? buildPropertyDefinitionRegistry({
              workspaceId: this.activeWorkspaceId,
              projectedDefinitions: rt.read(projectedPropertyDefinitionsFacet),
              seeds,
            })
            : null
          const propertySchemas = propertyDefinitions?.schemas
            ?? buildUnboundPropertySchemas(seeds)
          target.applyTypesAndSchemas(
            types,
            propertySchemas,
            propertyDefinitions,
            propertySeedNameCounts,
            typeDefinitions,
          )
          // Reproject rows whose ref-ness changed in this rebuild (e.g. a plugin
          // load makes a name ref-typed). A newly-OPENED workspace's existing
          // rows are handled separately, once per workspace, by
          // `scheduleWorkspaceRefBackfill` from `bootstrapWorkspace` — the
          // prev-vs-new diff here can't see them when a ref-typed name is
          // unchanged from the previously-active workspace.
          const refSchemaChanges = changedRefSchemaNames(previousPropertySchemas, propertySchemas)
          if (refSchemaChanges.length > 0) {
            target.scheduleReprojection(refSchemaChanges, propertySchemas)
          }
          // Codec-TYPE-change migrations (PR #288 §7/§9, slice B2): diff the
          // registry snapshots by durable fieldId. RENAMES are no longer
          // scheduled here — they are re-keyed atomically in the editing tx by
          // the `core.migratePropertyRename` same-tx processor (one undoable
          // step, no deferred plan-capture staleness, no half-migrated window).
          // A codec-TYPE change still needs this deferred pass because it must
          // build the NEW codec to re-encode values, which the same-tx registry
          // snapshot can't. A combined rename+codec edit rides both: the
          // processor re-keys the cell, this pass re-encodes values under the
          // new codec — both converge on the new cell key. Same workspace only
          // (the helper refuses cross-workspace diffs); synced-in changes are
          // reconciled on the flipped-workspace open path (#389 item 2).
          const codecChanges = changedPropertyDefinitions(
            previousPropertyDefinitions, propertyDefinitions,
          ).filter(change => change.codecChanged)
          if (codecChanges.length > 0 && propertyDefinitions) {
            target.schedulePropertyDefinitionMigrations(
              propertyDefinitions.workspaceId, codecChanges,
            )
          }
          // No property-SPECIFIC reference-target rederive here. Recognition
          // is form-agnostic (a whole-block reference that resolves to a
          // definition, §7) and resolution uses the ONE normal alias policy,
          // so a definition add/rename needs no bespoke property rederive. If
          // auto-claim (a later change) makes a definition name-resolvable,
          // that alias claim rides the normal alias-creation path, whose
          // generic late-binding rederive (referencesProcessor) already
          // repairs `[[name]]` rows — exactly like a `[[Foo]]` row reclaiming
          // when page Foo is created.
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
        id: 'queries',
        inputs: [queriesFacet as Facet<unknown, unknown>],
        run: (rt) => { target.applyQueries(new Map(rt.read(queriesFacet))) },
      },
    ]
  }
}
