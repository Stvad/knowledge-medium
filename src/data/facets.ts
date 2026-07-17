/**
 * Data-layer facets — the bridge between the kernel + plugin
 * contributions and the `Repo` lifecycle (spec §6, §8).
 *
 * Stage 1.4 ships `mutatorsFacet` only. The remaining facets
 * (`queriesFacet`, `propertyEditorOverridesFacet`,
 * `postCommitProcessorsFacet`) land in stages 1.5+ as the matching
 * machinery comes online.
 */

import { defineFacet, keyedMapFacet } from '@/facets/facet'
import type {
  AnyMutator,
  AnyPostCommitProcessor,
  AnyPropertySeedDeclaration,
  AnyPropertyEditorOverride,
  AnyQuery,
  AnySameTxProcessor,
  AnyValuePresetCore,
  AnyValuePresetPresentation,
  ChangeScope,
  Tx,
  TypeContribution,
} from '@/data/api'
import type {ProjectedPropertyDefinition} from '@/data/propertyDefinitionRegistry'
import type {ProjectedTypeDefinition} from '@/data/typeDefinitionRegistry'
import type { AnyDefinitionBlockProjector } from './projectorRuntime.ts'
import type { InvalidationRule } from './invalidation.ts'
import type { Repo } from './repo.ts'
import {isPropertySeedDeclaration} from './propertySeeds.ts'
import {isTypeSeedDeclaration, type TypeSeedDeclaration} from './typeSeeds.ts'

export interface LocalSchemaDb {
  execute: (sql: string) => Promise<unknown>
  getOptional: <T>(sql: string) => Promise<T | null>
}

export interface LocalSchemaBackfill {
  id: string
  run: (db: LocalSchemaDb) => Promise<void>
}

export interface LocalSchemaContribution {
  id: string
  statements?: readonly string[]
  triggerNames?: readonly string[]
  backfills?: readonly LocalSchemaBackfill[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

const isLocalSchemaBackfill = (value: unknown): value is LocalSchemaBackfill =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.run === 'function'

const isLocalSchemaContribution = (value: unknown): value is LocalSchemaContribution =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  (value.statements === undefined || isStringArray(value.statements)) &&
  (value.triggerNames === undefined || isStringArray(value.triggerNames)) &&
  (
    value.backfills === undefined ||
    (Array.isArray(value.backfills) && value.backfills.every(isLocalSchemaBackfill))
  )

/**
 * A workspace-scoped, one-shot data backfill that runs through `repo.tx` — the
 * synced-table counterpart to a `LocalSchemaContribution.backfill`.
 *
 * A LocalSchema backfill writes via a raw `db.execute`, which leaves
 * `tx_context.source = NULL`: fine for local derived-index tables, but a write
 * to a *synced* table (blocks/workspaces/workspace_members) never fires the
 * upload trigger and silently never syncs (the daily-note:date bug; guarded by
 * `syncedTableWriteGuard`). A `WorkspaceBackfill` instead writes through
 * `repo.tx`, so its rows carry `source = 'user'` and actually upload — the
 * server, and every other client, converge.
 *
 * The repo runs each registered backfill at most once per (workspace, id),
 * deferred off the workspace-open critical path — see
 * `Repo.scheduleWorkspaceBackfills`.
 */
export interface WorkspaceBackfill {
  /** Stable id; doubles as the per-workspace completion-marker suffix. Change
   *  it to force a re-run on every workspace. */
  readonly id: string
  run: (ctx: WorkspaceBackfillContext) => Promise<void>
}

export interface WorkspaceBackfillContext {
  /** The single workspace this run is scoped to. Every read and write MUST be
   *  filtered to it — a backfill never touches another workspace (that was the
   *  cross-workspace cold-start hazard the original raw backfill had). */
  readonly workspaceId: string
  /** Raw read against the local DB — use to find candidate rows. */
  getAll: <T>(sql: string, params?: readonly unknown[]) => Promise<T[]>
  /** Run a writing transaction. Routes through `repo.tx`, so writes carry
   *  source='user' and upload (the whole point — a raw write would not). */
  tx: <R>(
    fn: (tx: Tx) => Promise<R>,
    opts: {scope: ChangeScope; description?: string},
  ) => Promise<R>
}

const isWorkspaceBackfill = (value: unknown): value is WorkspaceBackfill =>
  isRecord(value) && typeof value.id === 'string' && typeof value.run === 'function'

const isInvalidationRule = (value: unknown): value is InvalidationRule =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  (
    value.collectFromSnapshots === undefined ||
    typeof value.collectFromSnapshots === 'function'
  )

const isDefinitionBlockProjector = (value: unknown): value is AnyDefinitionBlockProjector =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.metaType === 'string' &&
  typeof value.sourceId === 'string' &&
  typeof value.project === 'function' &&
  typeof value.keyOf === 'function' &&
  isRecord(value.targetFacet) &&
  typeof (value.targetFacet as { id?: unknown }).id === 'string'

/** Key the registry by `Mutator.name`; duplicates log a warning and
 *  last-wins (per §6 convention). Mutators with heterogeneous
 *  Args/Result types share the registry slot via `AnyMutator` (variance
 *  escape); call-site dispatch (`repo.mutate.X`, `tx.run(m, args)`)
 *  recovers precise types via the `MutatorRegistry` augmentation. */
export const mutatorsFacet = keyedMapFacet<AnyMutator>('data.mutators', m => m.name)

/** Future facets — declared empty for now so plugin authors can
 *  reference them at compile time without runtime breakage when no
 *  contributions exist. Wired up in stages 1.5+. */

export const queriesFacet = keyedMapFacet<AnyQuery>('data.queries', q => q.name)

/** Code-owned property definitions. The declaration object is also the typed
 * PropertyHandle returned by seedProperty. This is deliberately a list facet,
 * not a last-wins map: duplicate seed identities are an authoring error the
 * materializer must observe and reject before any write. */
export const definitionSeedsFacet = defineFacet<
  AnyPropertySeedDeclaration,
  readonly AnyPropertySeedDeclaration[]
>({
  id: 'data.definition-seeds',
  validate: isPropertySeedDeclaration,
})

/** Block-built property definitions keyed by durable field id. Metadata is
 * always present; locally-buildable behavior is optional. */
export const projectedPropertyDefinitionsFacet = keyedMapFacet<ProjectedPropertyDefinition>(
  'data.projected-property-definitions',
  definition => definition.metadata.fieldId,
)

export const typesFacet = keyedMapFacet<TypeContribution>('data.types', t => t.id)

/** Block-built type definitions keyed by durable block id — the type-side
 * twin of `projectedPropertyDefinitionsFacet`. The `userTypesProjector`
 * publishes one `ProjectedTypeDefinition` (codec-less identity/display metadata
 * + resolved `block-type:properties` schemas) per `'block-type'` block; the
 * facet bridge derives the merged, §9-resolved `repo.types` from this bucket +
 * `typeSeedsFacet` via `buildTypeDefinitionRegistry`. Keyed by block id (not the
 * `block-type:type-id` claim) so the declaration-authoritative registry — not a
 * last-wins facet fold — decides membership ids. */
export const projectedTypeDefinitionsFacet = keyedMapFacet<ProjectedTypeDefinition>(
  'data.projected-type-definitions',
  definition => definition.metadata.blockId,
)

/** Code-owned block-type definitions. The declaration object is also the
 * `TypeContribution` returned by `seedType`. A list facet (not a last-wins map)
 * for the same reason as `definitionSeedsFacet`: a duplicate seed id/key is an
 * authoring error the materializer must observe and reject before any write. */
export const typeSeedsFacet = defineFacet<
  TypeSeedDeclaration,
  readonly TypeSeedDeclaration[]
>({
  id: 'data.type-seeds',
  validate: isTypeSeedDeclaration,
})

export const propertyEditorOverridesFacet = keyedMapFacet<AnyPropertyEditorOverride>('data.property-editor-overrides', c => c.seedKey)

/** Data-only codec factories available to projectors and headless surfaces. */
export const valuePresetCoresFacet = keyedMapFacet<AnyValuePresetCore>('data.value-preset-cores', p => p.id)

/** React presentation contributions, joined live to cores by id. */
export const valuePresetPresentationsFacet = keyedMapFacet<AnyValuePresetPresentation>('data.value-preset-presentations', p => p.id)

export const postCommitProcessorsFacet = keyedMapFacet<AnyPostCommitProcessor>('data.postCommitProcessors', p => p.name)

// Sibling to `postCommitProcessorsFacet`. Same-tx processors run
// inside the user's writeTransaction; the commit pipeline iterates
// this facet's snapshot between `fn` returning and the
// `command_events` insert. See `src/data/api/sameTxProcessor.ts`.
//
// Two facets (rather than one with a mode discriminator) because the
// two processor types have genuinely different `ctx` shapes (same-tx
// gets a live `Tx`; post-commit gets `db + repo`) and different
// pipeline placement — keeping them separate makes "where does this
// run" a typed reference rather than a string match, and forces a
// deliberate refactor on the rare cases that need to flip modes.
export const sameTxProcessorsFacet = keyedMapFacet<AnySameTxProcessor>('data.sameTxProcessors', p => p.name)

export const localSchemaFacet = defineFacet<LocalSchemaContribution, readonly LocalSchemaContribution[]>({
  id: 'data.localSchema',
  validate: isLocalSchemaContribution,
})

export const workspaceBackfillsFacet = defineFacet<WorkspaceBackfill, readonly WorkspaceBackfill[]>({
  id: 'data.workspaceBackfills',
  validate: isWorkspaceBackfill,
})

/**
 * A per-workspace singleton page that must exist EARLY — before the workspace's
 * landing/first-run seed runs. Owners (kernel + plugins) declare theirs; the
 * bootstrap materialises them all via `Repo.ensureSystemPages` before any
 * landing resolver runs.
 *
 * Why eager: `[[Name]]` is auto-create (Roam-style) — the references processor
 * mints a page at an alias-"seat" id when no page with that alias exists yet.
 * Singleton pages (Journal/Properties/Types/Locations) are created elsewhere at
 * their OWN deterministic ids and claim a reserved alias, so a wiki-link that
 * resolves first auto-creates a rival claimant → two blocks, one alias →
 * `alias.collision`. Creating the canonical page first means `aliasLookup` hits
 * and no rival is minted.
 *
 * `ensure` MUST be idempotent and write at a deterministic, workspace-derived
 * id (see `getOrCreateKernelPage`) so repeated bootstraps and offline-
 * converging clients all land on the same row.
 */
export interface SystemPage {
  /** Stable id, for facet dedup. */
  readonly id: string
  /** Returns `Promise<unknown>` so the existing get-or-create helpers
   *  (which resolve to the created `Block`) assign directly; the result is
   *  ignored by `ensureSystemPages`. */
  ensure: (repo: Repo, workspaceId: string) => Promise<unknown>
}

const isSystemPage = (value: unknown): value is SystemPage =>
  isRecord(value) && typeof value.id === 'string' && typeof value.ensure === 'function'

export const systemPagesFacet = defineFacet<SystemPage, readonly SystemPage[]>({
  id: 'data.systemPages',
  validate: isSystemPage,
})

/** Default inner-property to use when filtering a `ref`/`refList`
 *  property whose target is of a given block type. Contributed by the
 *  *target* type's plugin (e.g. daily-notes contributes
 *  `{targetType: 'daily-note', property: 'daily-note:date'}`) so that
 *  filter UIs can present "filter this ref as a date" without baking
 *  daily-note knowledge into the filter component. The compiled
 *  predicate uses the typed-query `target` traversal — no
 *  query-engine extension required.
 *
 *  Lookup is by target type id; last-wins on collision. Keyed by
 *  target type (not ref property name) because the contract belongs to
 *  the target — any user-defined ref pointing at a daily note should
 *  get the same affordance without per-property registration. */
export interface RefTargetFilterDefault {
  readonly targetType: string
  /** Name of a registered `PropertySchema` on the target block type. */
  readonly property: string
}

export const refTargetFilterDefaultsFacet = keyedMapFacet<RefTargetFilterDefault>('data.refTargetFilterDefaults', d => d.targetType)

export const invalidationRulesFacet = defineFacet<InvalidationRule, readonly InvalidationRule[]>({
  id: 'data.invalidationRules',
  validate: isInvalidationRule,
})

/** Registry of definition-block projectors — the "data-defined
 *  contributions over facets" pattern (issue #90). Each contribution
 *  watches blocks of a meta-type and mirrors them into a target
 *  facet's `'user-data'` bucket; `ProjectorRuntime` drives the shared
 *  lifecycle. List-valued (started in `dependsOn` order), not keyed,
 *  since nothing looks a projector up by id through the facet — the
 *  driver enumerates them. */
export const definitionBlockProjectorFacet = defineFacet<
  AnyDefinitionBlockProjector,
  readonly AnyDefinitionBlockProjector[]
>({
  id: 'data.definitionBlockProjectors',
  validate: isDefinitionBlockProjector,
})
