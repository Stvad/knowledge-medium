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
  type AnyValuePresetCore,
  type BlockData,
} from '@/data/api'
import type { Repo } from '@/data/repo'
import type { DefinitionBlockProjector } from '@/data/projectorRuntime'
import {
  parsePropertyDefinitionMetadata,
  type PropertyDefinitionMetadata,
} from '@/data/propertyDefinitionMetadata'
import type {ProjectedPropertyDefinition} from '@/data/propertyDefinitionRegistry'
import {resolveSelectedPropertyDefinition} from '@/data/internals/propertySchemaResolution'
import {peekRowProperty} from '@/data/rowProperty'
import {
  presetConfigProp,
  presetIdProp,
  propertyDefaultProp,
  propertyNameProp,
} from '@/data/properties'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { isRoundTrippableReferenceLabel } from '@/data/referenceBlock'
import {
  projectedPropertyDefinitionsFacet,
} from '@/data/facets'
import {createChild as createChildMutator} from '@/data/mutators'

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

/** Builds optional local behavior for already-validated definition metadata.
 *  Missing presets and invalid configs return null with a diagnostic. The block stays in the database
 *  untouched; a fix re-runs this on the next subscription tick (or the
 *  `onValuePresetsChange` re-resolve when a missing preset's plugin
 *  loads). */
const tryBuildSchema = (
  row: BlockData,
  presets: ReadonlyMap<string, AnyValuePresetCore>,
  metadata: PropertyDefinitionMetadata,
): AnyPropertySchema | null => {
  const presetId = peekRowProperty(row, presetIdProp) ?? ''
  if (!presetId) {
    console.warn(`[UserSchemasService] schema block ${row.id} has no presetId`)
    return null
  }
  const preset = presets.get(presetId)
  if (!preset) {
    console.warn(
      `[UserSchemasService] schema block ${row.id} references unknown preset ${JSON.stringify(presetId)}; ` +
      `preset's plugin may not be loaded`,
    )
    return null
  }
  let config: unknown
  if (preset.configCodec) {
    try {
      const raw = rawPresetConfig(preset, peekRowProperty(row, presetConfigProp))
      config = preset.configCodec.decode(raw)
    } catch (err) {
      console.warn(
        `[UserSchemasService] schema "${metadata.name}" has invalid config: ${(err as Error).message}; skipping until fixed`,
      )
      return null
    }
  } else {
    config = undefined
  }
  const codec = preset.build(config as never)
  return {
    name: metadata.name,
    codec,
    defaultValue: decodeStoredDefault(row, preset, codec, metadata.name),
    changeScope: metadata.changeScope,
  }
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
  keyOf: definition => definition.metadata.fieldId,
  project: (row, ctx) => {
    const metadata = parsePropertyDefinitionMetadata(row)
    if (!metadata) return null
    let schema: AnyPropertySchema | null = null
    try {
      schema = tryBuildSchema(row, ctx.repo.valuePresetCores, metadata)
    } catch (error) {
      console.warn(
        `[UserSchemasService] schema block ${row.id} behavior failed; publishing metadata only`,
        error,
      )
    }
    return {metadata, ...(schema ? {schema} : {})}
  },
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

/** Thin facade over the `'user-schemas'` projector. Projector lifecycle,
 * contribution state, and indexes live in the `ProjectorHandle`, reached
 * through `repo.projectors`; this facade owns only in-flight name reservations
 * that serialize same-Repo creation attempts. Singleton on `Repo` so
 * imperative callers share both the projector generation and reservations. */
export class UserSchemasService {
  private readonly pendingCreations = new Set<string>()

  constructor(private readonly repo: Repo) {}

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
    if (!definition) return undefined
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

  /** Create a property-schema block in the workspace's Properties
   *  page AND register the schema synchronously. Returns the freshly
   *  registered schema. */
  async addSchema(args: AddSchemaArgs): Promise<AnyPropertySchema> {
    const name = args.name.trim()
    if (!name) throw new Error('[addSchema] name is required')
    // A schema name must survive the `[[wikilink]]` round trip — `]]` is
    // lossy there. Field rows are now id-addressed (`((fieldId))`, PR #288 §7)
    // and no longer embed the name, so this is name hygiene (a name that
    // can't be written as a clean `[[name]]` reference) rather than a hard
    // field-row-content requirement; it could be relaxed as a follow-up.
    if (!isRoundTrippableReferenceLabel(name)) {
      throw new Error(
        `[addSchema] name ${JSON.stringify(name)} cannot round-trip as a [[wikilink]]; `
        + 'rename without "]]"',
      )
    }

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
      assertNameAvailable()

      const childId = await this.repo.tx(async tx => {
        // Recheck after acquiring the write transaction and immediately before
        // return. A queued write must not commit against a projector generation
        // or seed/name registry that changed after the optimistic preflight.
        assertGeneration('creation')
        assertNameAvailable()
        const id = await tx.run(createChildMutator, {
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
        assertGeneration('creation')
        assertNameAvailable()
        return id
      }, {scope: ChangeScope.BlockDefault, description: `addSchema ${name}`})

      assertGeneration('registration')
      this.appendUserSchema(newSchema, childId, workspaceId)
      return newSchema
    } finally {
      this.pendingCreations.delete(reservationKey)
    }
  }
}
