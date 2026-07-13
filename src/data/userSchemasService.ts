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
  type AnyPropertySchema,
  type AnyValuePresetCore,
  type BlockData,
  type PropertySchema,
} from '@/data/api'
import type { Repo } from '@/data/repo'
import type { DefinitionBlockProjector } from '@/data/projectorRuntime'
import {
  parsePropertyDefinitionMetadata,
  type PropertyDefinitionMetadata,
} from '@/data/propertyDefinitionMetadata'
import type {ProjectedPropertyDefinition} from '@/data/propertyDefinitionRegistry'
import {
  presetConfigProp,
  presetIdProp,
  propertyDefaultProp,
  propertyNameProp,
} from '@/data/properties'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import {
  projectedPropertyDefinitionsFacet,
} from '@/data/facets'

/** Projector id for the user-defined property-schema bridge. */
export const USER_SCHEMAS_PROJECTOR_ID = 'user-schemas'

const USER_DATA_SOURCE_ID = 'user-data'

/** Decode a single property straight off a raw row — same logic as
 *  `Block.peekProperty`, minus the cache-backed facade. The block
 *  subscription already hands us the authoritative `BlockData`, so
 *  reading it directly avoids the hydration race where `repo.block(id)`
 *  could transiently read an un-hydrated facade (peekProperty → undefined)
 *  and drop a freshly-created schema from the rebuild. */
const peekRowProperty = <T>(row: BlockData, schema: PropertySchema<T>): T | undefined => {
  const stored = row.properties[schema.name]
  return stored === undefined ? undefined : schema.codec.decode(stored)
}

const rawPresetConfig = (
  preset: AnyValuePresetCore,
  stored: unknown,
): unknown => {
  if (stored !== undefined) return stored
  if (preset.defaultConfig === undefined || preset.configCodec === undefined) return {}
  return preset.configCodec.encode(preset.defaultConfig)
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
  const hasStoredDefault = Object.prototype.hasOwnProperty.call(
    row.properties,
    propertyDefaultProp.name,
  )
  return {
    name: metadata.name,
    codec,
    defaultValue: hasStoredDefault
      ? codec.decode(row.properties[propertyDefaultProp.name])
      : preset.defaultValue,
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

/** Thin facade over the `'user-schemas'` projector. Holds no state of
 *  its own — the lifecycle + the contribution list / id maps live in
 *  the projector's `ProjectorHandle`, reached through `repo.projectors`.
 *  Singleton on `Repo` so imperative call sites (AddPropertyForm, the
 *  Roam importer) all hit the Repo-pin-owned projector generation. */
export class UserSchemasService {
  constructor(private readonly repo: Repo) {}

  private get handle() {
    return this.repo.projectors.handle<ProjectedPropertyDefinition>(USER_SCHEMAS_PROJECTOR_ID)
  }

  /** Look up the property-schema block id for a registered user-data
   *  schema name. Returns undefined for kernel/plugin schemas (which
   *  don't have backing blocks) or names that aren't registered. */
  getSchemaBlockId(name: string): string | undefined {
    return this.repo.propertyDefinitions?.definitionsByName.get(name)?.[0]?.fieldId
  }

  /** Look up the published user-data schema for a property-schema
   *  block id. Returns undefined for blocks that aren't currently
   *  materializing a schema — including blocks pending hydration,
   *  blocks failing `tryBuildSchema` validation (empty name, unknown
   *  preset, invalid config), and ids that simply don't exist. */
  getSchemaForBlockId(blockId: string): AnyPropertySchema | undefined {
    return this.handle?.contributionForBlockId(blockId)?.schema
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

    const workspaceId = this.repo.activeWorkspaceId
    const propertiesPageId = this.repo.propertiesPageId
    if (!workspaceId || !propertiesPageId) {
      throw new Error('[addSchema] no active workspace; properties page unavailable')
    }

    const childId: string = await this.repo.mutate.createChild({
      parentId: propertiesPageId,
      position: {kind: 'last'},
    })

    await this.repo.tx(async tx => {
      // Lift property-schema type membership through Repo.addTypeInTx
      // so types invariants stay consistent (block_types row + the
      // typesProp lift). The remaining property-schema fields are
      // written directly since they're scoped to this block.
      await this.repo.addTypeInTx(tx, childId, PROPERTY_SCHEMA_TYPE, {})
      await tx.setProperty(childId, propertyNameProp, name)
      await tx.setProperty(childId, presetIdProp, args.presetId)
      await tx.setProperty(childId, presetConfigProp, persistConfig as Record<string, unknown>)
    }, {scope: ChangeScope.BlockDefault, description: `addSchema ${name}`})

    // Register synchronously, before returning — but only if the workspace
    // didn't change while the create/tx was in flight. The schema block is
    // durably persisted under `workspaceId`'s Properties page; publishing it
    // into the wrong workspace-scoped bucket after a switch would corrupt that
    // bucket's snapshot. The projector's generation guard protects subscription
    // callbacks; this imperative async path additionally pins at the call site.
    // Skipping is safe: when `workspaceId` is active again, its subscription
    // re-materialises the block. The subscription otherwise arrives at an
    // idempotent state.
    if (this.repo.activeWorkspaceId === workspaceId) {
      this.appendUserSchema(newSchema, childId, workspaceId)
    }
    return newSchema
  }
}
