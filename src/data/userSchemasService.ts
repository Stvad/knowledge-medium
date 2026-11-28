/** Property-schema blocks → a workspace-scoped, field-id-keyed projection
 *  with mandatory metadata and optional locally-buildable behavior. The
 *  bridge derives the public name-keyed registry from this bucket. See
 *  user-defined-properties.md §5 + §7.
 *
 *  The reactive lifecycle (subscribe / pin / publish / reset+clear on
 *  dispose) lives in the shared `ProjectorRuntime` core, configured by
 *  `userSchemasProjector` below. This file keeps only the schema-side
 *  specifics: the builder (`tryBuildSchema`, which needs `valuePresets`)
 *  and the distinct public surface — `addSchema` / `appendUserSchema`
 *  and the `getSchemaBlockId` / `getSchemaForBlockId` lookups. */

import {
  ChangeScope,
  normalizePresetDefault,
  type AnyPropertySchema,
  type AnyResolvedPropertySchema,
  type AnyValuePresetCore,
  type BlockData,
  type Tx,
} from '@/data/api'
import type { Repo } from '@/data/repo'
import {PROMOTION_NAMESPACE, promotedPropertyDefinitionId} from '@/data/derivedIds'
import {derivedIdNamespaceInTx, resolveDerivedIdNamespace} from '@/data/workspaceIdNamespace'
import type { DefinitionBlockProjector } from '@/data/projectorRuntime'
import {
  parsePropertyDefinitionMetadata,
  type PropertyDefinitionMetadata,
} from '@/data/propertyDefinitionMetadata'
import {
  effectivePropertyDefinitionName,
  isParsedPropertyDefinition,
  projectedPropertyDefinitionFieldId,
  type ProjectedPropertyDefinition,
} from '@/data/propertyDefinitionRegistry'
import {definitionNameOf, readLivePropertyDefinitionNames, requirePropertyRegistryFor} from '@/data/internals/propertyKeyScan'
import {readLiveRowsForIds} from '@/data/internals/kernelQueries'
import {resolveSelectedPropertyDefinition} from '@/data/internals/propertySchemaResolution'
import {peekRowProperty} from '@/data/rowProperty'
import {
  presetConfigProp,
  presetIdProp,
  propertyDefaultProp,
  propertyNameProp,
} from '@/data/properties'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { isGrammarShapedLabel, isRoundTrippableReferenceLabel } from '@/data/referenceBlock'
import {
  projectedPropertyDefinitionsFacet,
} from '@/data/facets'
import {createChild as createChildMutator} from '@/data/mutators'

/** The one place a property-schema name is judged. `addSchema` throws on the
 *  reason; callers that must decide BEFORE acting — content promotion has to
 *  decline a key before it hoists anything, since a subtractive consumer
 *  drops the source bullet and the text would be the property's only copy —
 *  ask `isRegistrablePropertyName`. Kept as one function so a new rule cannot
 *  land on the throwing path while the predicate keeps saying yes.
 *
 *  Both rules are name hygiene (docs/properties-as-blocks-migration.html §7). A name must survive the
 *  `[[wikilink]]` round trip — `]]` is lossy there — and must not itself BE a
 *  reference span: the definition keeps its name in a property rather than
 *  its content, so it mints nothing on its own, but the name is written as
 *  `[[name]]` wherever a definition is addressed by name, and one shaped like
 *  `((id))` reads as a different reference entirely downstream. */
export const propertySchemaNameRejection = (name: string): string | null => {
  if (!name) return 'name is required'
  if (!isRoundTrippableReferenceLabel(name)) {
    return `name ${JSON.stringify(name)} cannot round-trip as a [[wikilink]]; rename without "]]"`
  }
  if (isGrammarShapedLabel(name)) {
    return `name ${JSON.stringify(name)} is itself a reference span; rename it`
  }
  return null
}

export const isRegistrablePropertyName = (name: string): boolean =>
  propertySchemaNameRejection(name.trim()) === null

/** Projector id for the user-defined property-schema bridge. */
export const USER_SCHEMAS_PROJECTOR_ID = 'user-schemas'

const USER_DATA_SOURCE_ID = 'user-data'

const rawPresetConfig = (
  preset: AnyValuePresetCore,
  stored: unknown,
): unknown => {
  if (stored !== undefined) return stored
  if (preset.defaultConfig === undefined || preset.configCodec === undefined) return {}
  return preset.configCodec.encode(preset.defaultConfig)
}

/** The value `preset.build` is called with for a definition row's stored
 *  `property-schema:config` — `undefined` for a preset declaring no
 *  `configCodec`. Throws whatever that codec throws.
 *
 *  Exported for the install-time preset-identity check
 *  (`@/plugins/agent-runtime/presetIdentity`), which has to build the codec a
 *  definition would ACTUALLY get from a candidate preset core. A second
 *  reading of the same two inputs beside this one is how the two would drift
 *  into disagreeing about what a row's codec is.
 *
 *  `preset.build` deliberately stays at the call site: a config decode is
 *  caught here (a stale config is a fixable row), while a throwing `build` is
 *  extension code failing and each caller has its own answer for it — the
 *  projector publishes metadata only, `buildSchemaOrNull` swallows it rather
 *  than aborting the user's transaction, and the check below reports it. */
export const decodePresetConfig = (
  preset: AnyValuePresetCore,
  storedConfig: unknown,
): unknown =>
  preset.configCodec
    ? preset.configCodec.decode(rawPresetConfig(preset, storedConfig))
    : undefined

/** Decode the row's stored default with the built codec, falling back to the
 *  preset default when the stored value is incompatible. An incompatible stored
 *  default is a stale *value* (e.g. a `null` optional-string default left behind
 *  when a seed revision — or an out-of-band edit — switches the preset to plain
 *  string), not a broken codec: the property keeps working with the preset
 *  default instead of collapsing to metadata-only and losing all behavior.
 *  Missing default → preset default, unchanged. */
const decodeStoredDefault = (
  row: BlockData,
  preset: AnyValuePresetCore,
  codec: ReturnType<AnyValuePresetCore['build']>,
  name: string,
): unknown => {
  if (!Object.prototype.hasOwnProperty.call(row.properties, propertyDefaultProp.name)) {
    return normalizePresetDefault(preset, codec)
  }
  try {
    return codec.decode(row.properties[propertyDefaultProp.name])
  } catch (err) {
    console.warn(
      `[UserSchemasService] schema "${name}" stored default is incompatible with preset ` +
      `${JSON.stringify(preset.id)}; using the preset default: ${(err as Error).message}`,
    )
    return normalizePresetDefault(preset, codec)
  }
}

/** Why a definition row builds no codec on this device. */
export type UnbuildableCause =
  /** The row names no preset at all. */
  | 'no-preset'
  /** No plugin (or app build) on this device registers the preset. */
  | 'preset-not-loaded'
  /** The preset is registered and cannot decode the row's stored config. */
  | 'config-unreadable'
  /** The preset is registered, reads its config, and `build` throws. */
  | 'build-failed'

type SchemaSteps =
  | {readonly schema: AnyPropertySchema}
  | {
      readonly schema: null
      readonly cause: Exclude<UnbuildableCause, 'build-failed'>
      readonly presetId: string
      readonly error?: Error
    }

/** The one walk from a definition row to its codec. Unlogged, and it does
 *  not catch `preset.build` (or the default's normalization) throwing — each
 *  caller has its own answer for extension code failing. */
const buildSchemaSteps = (
  row: BlockData,
  presets: ReadonlyMap<string, AnyValuePresetCore>,
  metadata: PropertyDefinitionMetadata,
): SchemaSteps => {
  const presetId = peekRowProperty(row, presetIdProp) ?? ''
  if (!presetId) return {schema: null, cause: 'no-preset', presetId}
  const preset = presets.get(presetId)
  if (!preset) return {schema: null, cause: 'preset-not-loaded', presetId}
  let config: unknown
  try {
    config = decodePresetConfig(preset, peekRowProperty(row, presetConfigProp))
  } catch (err) {
    return {schema: null, cause: 'config-unreadable', presetId, error: err as Error}
  }
  const codec = preset.build(config as never)
  return {
    schema: {
      name: metadata.name,
      codec,
      defaultValue: decodeStoredDefault(row, preset, codec, metadata.name),
      changeScope: metadata.changeScope,
    },
  }
}

/** Builds optional local behavior for already-validated definition metadata.
 *  Missing presets and invalid configs return null with a diagnostic.
 *
 *  Exported because the properties migration republishes converged definitions
 *  and must produce the SAME schema the projector will a tick later — building
 *  a second one beside this was how a config-carrying preset ended up skipped
 *  and an extension-replaced one ended up published under the kernel codec. The block stays in the database
 *  untouched; a fix re-runs this on the next subscription tick (or the
 *  `onValuePresetsChange` re-resolve when a missing preset's plugin
 *  loads). */
export const tryBuildSchema = (
  row: BlockData,
  presets: ReadonlyMap<string, AnyValuePresetCore>,
  metadata: PropertyDefinitionMetadata,
): AnyPropertySchema | null => {
  const built = buildSchemaSteps(row, presets, metadata)
  if (built.schema !== null) return built.schema
  switch (built.cause) {
    case 'no-preset':
      console.warn(`[UserSchemasService] schema block ${row.id} has no presetId`)
      break
    case 'preset-not-loaded':
      console.warn(
        `[UserSchemasService] schema block ${row.id} references unknown preset ${JSON.stringify(built.presetId)}; ` +
        `preset's plugin may not be loaded`,
      )
      break
    case 'config-unreadable':
      console.warn(
        `[UserSchemasService] schema "${metadata.name}" has invalid config: ${built.error?.message}; skipping until fixed`,
      )
      break
  }
  return null
}

/** The schema a definition row builds on this device, or why it builds none —
 *  the one answer to "can this device read a definition's values". The
 *  definition-change processor refuses every change to a definition whose
 *  CURRENT row builds nothing here, and the schema editor locks its type and
 *  config controls on the same answer. Never throws: `preset.build` is
 *  extension code, and a throwing one is the same answer as a missing preset.
 *  Not logged: the projector warns for the same row on its own rebuild. */
export const definitionSchema = (
  row: BlockData,
  presets: ReadonlyMap<string, AnyValuePresetCore>,
  metadata: PropertyDefinitionMetadata,
): {readonly schema: AnyPropertySchema} | {readonly schema: null; readonly cause: UnbuildableCause} => {
  try {
    return buildSchemaSteps(row, presets, metadata)
  } catch {
    return {schema: null, cause: 'build-failed'}
  }
}

/** {@link definitionSchema}'s schema alone. */
export const buildSchemaOrNull = (
  row: BlockData,
  presets: ReadonlyMap<string, AnyValuePresetCore>,
  metadata: PropertyDefinitionMetadata,
): AnyPropertySchema | null => definitionSchema(row, presets, metadata).schema

const projectDefinition = (row: BlockData, repo: Repo): ProjectedPropertyDefinition => {
  const metadata = parsePropertyDefinitionMetadata(row)
  if (!metadata) {
    return {unparseable: {fieldId: row.id, workspaceId: row.workspaceId}}
  }
  let schema: AnyPropertySchema | null = null
  try {
    schema = tryBuildSchema(row, repo.valuePresetCores, metadata)
  } catch (error) {
    console.warn(
      `[UserSchemasService] schema block ${row.id} behavior failed; publishing metadata only`,
      error,
    )
  }
  return {metadata, ...(schema ? {schema} : {})}
}

/** Descriptor wiring the schema bridge into the shared projector
 *  lifecycle. Raw `BlockData` rows (no hydrate — see `peekRowProperty`);
 *  re-resolves on `onValuePresetsChange` so a schema skipped for an
 *  unknown preset resolves when that preset's plugin loads. */
export const userSchemasProjector: DefinitionBlockProjector<
  BlockData,
  ProjectedPropertyDefinition
> = {
  id: USER_SCHEMAS_PROJECTOR_ID,
  metaType: PROPERTY_SCHEMA_TYPE,
  targetFacet: projectedPropertyDefinitionsFacet,
  sourceId: USER_DATA_SOURCE_ID,
  keyOf: projectedPropertyDefinitionFieldId,
  project: (row, ctx) => projectDefinition(row, ctx.repo),
  secondarySignal: (repo, rebuild) => repo.onValuePresetsChange(rebuild),
}

export interface AddSchemaArgs {
  name: string
  presetId: string
  /** Caller-supplied config. Runs through `preset.configCodec.decode`
   *  for validation. Pass `undefined` to fall back to
   *  `preset.defaultConfig` — `null` is a real (typically invalid)
   *  value that's passed through to the codec so it can reject. */
  config?: unknown
}

type OnSchemaCreate = (tx: Tx, fieldId: string) => Promise<void>

export class PromotionViewGapError extends Error {
  override readonly name = 'PromotionViewGapError'
}

const assertPromotionCanMint = async (repo: Repo, workspaceId: string, tx?: Tx): Promise<void> => {
  const gap = await repo.workspaceViewGap(workspaceId, tx)
  if (gap) throw new PromotionViewGapError(`Cannot promote a new property because this device is not caught up. ${gap.reason}`)
}

const promotionHolders = async (repo: Repo, workspaceId: string, names: readonly string[], tx?: Tx) => {
  const db = tx?.readDb ?? repo.db
  const byName = await readLivePropertyDefinitionNames(db, workspaceId, names)
  const stored = await readLiveRowsForIds(db, workspaceId, [...byName.values()].flat())
  const holders = new Map<string | undefined, BlockData[]>()
  for (const row of stored) {
    const metadata = parsePropertyDefinitionMetadata(row)
    // A seed only claims its declared name. An unreadable claimant reserves its stored name.
    const name = metadata
      ? effectivePropertyDefinitionName(metadata, requirePropertyRegistryFor(repo, workspaceId).seedsByKey)
      : definitionNameOf(row.properties)
    const group = holders.get(name) ?? []
    group.push(row)
    holders.set(name, group)
  }
  return holders
}

/** Check the whole import before its first write, including definitions that have arrived ahead of projection. */
export const preflightPropertyPromotion = async (
  repo: Repo, workspaceId: string, names: readonly string[],
): Promise<'reuse' | 'mint'> => {
  const normalized = names.map(name => name.trim())
  const holders = await promotionHolders(repo, workspaceId, normalized)
  if (normalized.every(name => holders.has(name))) return 'reuse'
  await assertPromotionCanMint(repo, workspaceId)
  return 'mint'
}

/** A rename uploaded after our last checkpoint, or a download yet to start just after connecting, can still escape the check. */
const promotionSlot = async (repo: Repo, tx: Tx, workspaceId: string, name: string) => {
  // A live same-name definition at the derived id is reused with its stored codec, including before projection.
  // A legacy random-id claimant owns the name on exactly the same terms and keeps all of its field rows.
  const existing = (await promotionHolders(repo, workspaceId, [name], tx)).get(name)
  if (existing) return {existing: existing.map(row => projectDefinition(row, repo))} as const

  await assertPromotionCanMint(repo, workspaceId, tx)
  const namespace = await derivedIdNamespaceInTx(tx, tx.meta.user.id, workspaceId, PROMOTION_NAMESPACE)
  for (let slot = 0; ; slot++) {
    const id = promotedPropertyDefinitionId(namespace, workspaceId, name, slot)
    // A tombstone reserves its slot so promotion preserves the deletion and its history.
    // A renamed definition reserves its slot so every writer with that history advances without rebinding its fields.
    if (await tx.get(id) === null) return {id} as const
  }
}

/** Thin facade over the `'user-schemas'` projector. Projector lifecycle,
 * contribution state, and indexes live in the `ProjectorHandle`, reached
 * through `repo.projectors`; service views share the in-flight name
 * reservations that serialize same-Repo creation attempts. */
export class UserSchemasService {
  constructor(
    private readonly repo: Repo,
    private readonly pendingCreations = new Set<string>(),
  ) {}

  /** Bind imperative writes to another Repo host while sharing the name
   * reservations owned by the original Repo service. */
  withRepo(repo: Repo): UserSchemasService {
    return new UserSchemasService(repo, this.pendingCreations)
  }

  private get handle() {
    return this.repo.projectors.handle<ProjectedPropertyDefinition>(USER_SCHEMAS_PROJECTOR_ID)
  }

  /** Look up the selected live definition block id for a schema name.
   * Returns undefined while a seed exists only in synthesis (its deterministic
   * row has not materialized yet), or when the name has no live definition. */
  getSchemaBlockId(name: string): string | undefined {
    return this.repo.propertyDefinitions?.definitionsByName.get(name)?.[0]?.fieldId
  }

  /** Resolve a property-definition block id through the selected workspace
   * winner. Metadata-only seeded rows use their declaration behavior; unknown,
   * invalid, and shadowed rows return undefined. */
  getSchemaForBlockId(blockId: string): AnyPropertySchema | undefined {
    const definition = this.handle?.contributionForBlockId(blockId)
    if (!definition || !isParsedPropertyDefinition(definition)) return undefined
    return resolveSelectedPropertyDefinition(
      definition.metadata,
      this.repo.propertySchemaResolverFor(definition.metadata.workspaceId),
    )
  }

  /** Synchronously add a projected definition to the runtime bucket. Used
   *  by `addSchema` after persisting the schema block — registers
   *  before any dependent property write so the form's "create-then-
   *  write-initial-value" flow doesn't race the subscription tick.
   *  `blockId` is the property-schema block that produced `schema`. */
  appendUserSchema(schema: AnyPropertySchema, blockId: string, workspaceId: string): void {
    const row = this.repo.block(blockId).peek()
    const metadata = row ? parsePropertyDefinitionMetadata(row) : null
    if (!metadata) {
      throw new Error(`[UserSchemasService] cannot publish metadata for schema block ${blockId}`)
    }
    this.handle?.upsert({metadata, schema}, blockId, workspaceId)
  }

  /** Create a property-schema block in the workspace's Properties page AND
   *  register the schema synchronously. Returns the new definition RESOLVED,
   *  so it keeps resolving by field id through later registry rebuilds. The
   *  plain schema this publishes into the ambient registry would not: the
   *  projector rebuilds each definition's behavior object per tick, and the
   *  boundary admits a plain schema only as the object it currently
   *  publishes. */
  addSchema(args: AddSchemaArgs, onCreate?: OnSchemaCreate): Promise<AnyResolvedPropertySchema> {
    return this.createSchema(args, onCreate)
  }

  ensurePromotedSchema(args: AddSchemaArgs): Promise<AnyResolvedPropertySchema> {
    return this.createSchema(args, 'promotion')
  }

  private async createSchema(args: AddSchemaArgs, creation?: OnSchemaCreate | 'promotion'): Promise<AnyResolvedPropertySchema> {
    const name = args.name.trim()
    const rejection = propertySchemaNameRejection(name)
    if (rejection) throw new Error(`[addSchema] ${rejection}`)
    // Capture the generation before the first await. Creation is a
    // definition-identity write: synthesis is available synchronously, but
    // existing user definitions are complete only after this workspace's
    // projector has delivered its first tick.
    const workspaceId = this.repo.activeWorkspaceId
    const propertiesPageId = this.repo.propertiesPageId
    const generationToken = this.repo.projectors.generationToken
    if (
      !workspaceId ||
      !propertiesPageId ||
      generationToken === null ||
      this.repo.projectors.workspaceId !== workspaceId
    ) {
      throw new Error('[addSchema] no active workspace; properties page unavailable')
    }

    const preset = this.repo.valuePresetCores.get(args.presetId)
    if (!preset) {
      throw new Error(`[addSchema] no preset registered for id ${JSON.stringify(args.presetId)}`)
    }

    // Run caller config through the same validation boundary the
    // subscription uses. Only `undefined` falls back to defaultConfig;
    // `null` is preserved so configCodec can reject it.
    let parsedConfig: unknown
    if (preset.configCodec) {
      const raw = rawPresetConfig(preset, args.config)
      try {
        parsedConfig = preset.configCodec.decode(raw)
      } catch (err) {
        throw new Error(
          `[addSchema] invalid config for preset ${JSON.stringify(args.presetId)}: ${(err as Error).message}`,
          {cause: err},
        )
      }
    } else {
      parsedConfig = undefined
    }

    const newSchema: AnyPropertySchema = {
      name,
      codec: preset.build(parsedConfig as never),
      defaultValue: preset.defaultValue,
      changeScope: ChangeScope.BlockDefault,
    }

    // Persist the *re-encoded* parsed config — round-trips through
    // configCodec to normalize and ensure the subscription's later
    // decode reproduces parsedConfig.
    const persistConfig = preset.configCodec
      ? preset.configCodec.encode(parsedConfig as never)
      : {}

    const reservationKey = `${workspaceId}\u0000${name}`
    if (this.pendingCreations.has(reservationKey)) {
      throw new Error(`[addSchema] name ${JSON.stringify(name)} is already being created`)
    }
    this.pendingCreations.add(reservationKey)
    try {
      const handle = this.handle
      if (!handle) throw new Error('[addSchema] user-schemas projector unavailable')
      const assertGeneration = (phase: 'creation' | 'registration'): void => {
        if (
          this.repo.activeWorkspaceId !== workspaceId ||
          this.repo.projectors.generationToken !== generationToken ||
          !handle.isPrimedFor(workspaceId)
        ) {
          throw new Error(`[addSchema] active workspace generation changed before schema ${phase}`)
        }
      }
      const assertNameAvailable = (): void => {
        const registry = this.repo.propertyDefinitions
        if (!registry || registry.workspaceId !== workspaceId) {
          throw new Error('[addSchema] property definitions unavailable for active workspace')
        }
        const definition = registry.definitionsByName.get(name)?.[0]
        const declaration = registry.seedsByName.get(name)?.[0]
        if (definition || declaration) {
          const claimant = declaration
            ? `seed ${JSON.stringify(declaration.seedKey)}`
            : `definition ${JSON.stringify(definition!.fieldId)}`
          throw new Error(`[addSchema] name ${JSON.stringify(name)} is already claimed by ${claimant}`)
        }
      }
      try {
        await handle.whenPrimed(workspaceId)
      } catch (error) {
        if (
          this.repo.activeWorkspaceId !== workspaceId ||
          this.repo.projectors.generationToken !== generationToken
        ) {
          throw new Error(
            '[addSchema] active workspace generation changed before schema creation',
            {cause: error},
          )
        }
        throw error
      }
      assertGeneration('creation')
      if (creation === 'promotion') {
        if (await preflightPropertyPromotion(this.repo, workspaceId, [name]) === 'mint') {
          await resolveDerivedIdNamespace(this.repo, workspaceId, PROMOTION_NAMESPACE)
        }
      } else {
        assertNameAvailable()
      }

      const result = await this.repo.tx(async tx => {
        // Recheck after acquiring the write transaction and immediately before
        // return. A queued write must not commit against a projector generation
        // or seed/name registry that changed after the optimistic preflight.
        assertGeneration('creation')
        const slot = creation === 'promotion' ? await promotionSlot(this.repo, tx, workspaceId, name) : undefined
        if (slot?.existing) return {existing: slot.existing}
        assertNameAvailable()
        const id = await tx.run(createChildMutator, {
          id: slot?.id,
          parentId: propertiesPageId,
          position: {kind: 'last'},
        })
        // Lift property-schema type membership through Repo.addTypeInTx
        // so types invariants stay consistent (block_types row + the
        // typesProp lift). The remaining property-schema fields are
        // written directly since they're scoped to this block.
        await this.repo.addTypeInTx(tx, id, PROPERTY_SCHEMA_TYPE, {})
        await tx.setProperty(id, propertyNameProp, name)
        await tx.setProperty(id, presetIdProp, args.presetId)
        await tx.setProperty(id, presetConfigProp, persistConfig as Record<string, unknown>)
        if (typeof creation === 'function') await creation(tx, id)
        assertGeneration('creation')
        assertNameAvailable()
        return {id}
      }, {
        scope: ChangeScope.BlockDefault,
        description: `addSchema ${name}`,
        // Another writer can already have fields bound to this shared definition when the importer undoes its content.
        skipUndo: creation === 'promotion',
      })

      assertGeneration('registration')
      if (result.existing) {
        for (const definition of result.existing) {
          handle.upsert(definition, projectedPropertyDefinitionFieldId(definition), workspaceId)
        }
      } else {
        this.appendUserSchema(newSchema, result.id, workspaceId)
      }
      const resolver = this.repo.propertySchemaResolverFor(workspaceId)
      const resolution = result.existing ? resolver.resolve(name) : resolver.resolveField(result.id)
      if (resolution.status !== 'resolved') {
        throw new Error(
          `[addSchema] definition for ${JSON.stringify(name)} ` +
          `does not resolve after registration (${resolution.reason})`,
        )
      }
      return resolution.schema
    } finally {
      this.pendingCreations.delete(reservationKey)
    }
  }
}
