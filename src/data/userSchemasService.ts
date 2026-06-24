/** User-defined `'property-schema'` blocks → the `propertySchemasFacet`
 *  `'user-data'` runtime-contribution bucket. See
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
  type AnyValuePreset,
  type BlockData,
  type PropertySchema,
} from '@/data/api'
import type { Repo } from '@/data/repo'
import type { DefinitionBlockProjector } from '@/data/projectorRuntime'
import {
  presetConfigProp,
  presetIdProp,
  propertyNameProp,
} from '@/data/properties'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { propertySchemasFacet } from '@/data/facets'

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

/** Validates a schema block against the current presets and returns the
 *  schema if it parses, or null with a logged diagnostic if not. Three
 *  skip paths: (1) preset not loaded, (2) name empty, (3)
 *  configCodec.decode throws. The block stays in the database
 *  untouched; a fix re-runs this on the next subscription tick (or the
 *  `onValuePresetsChange` re-resolve when a missing preset's plugin
 *  loads). */
const tryBuildSchema = (
  row: BlockData,
  presets: ReadonlyMap<string, AnyValuePreset>,
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
  const name = peekRowProperty(row, propertyNameProp) ?? ''
  if (!name) {
    console.warn(`[UserSchemasService] schema block ${row.id} has empty propertyName`)
    return null
  }
  let config: unknown
  if (preset.configCodec) {
    try {
      const raw = peekRowProperty(row, presetConfigProp) ?? {}
      config = preset.configCodec.decode(raw)
    } catch (err) {
      console.warn(
        `[UserSchemasService] schema "${name}" has invalid config: ${(err as Error).message}; skipping until fixed`,
      )
      return null
    }
  } else {
    config = undefined
  }
  return {
    name,
    fieldId: row.id,
    codec: preset.build(config as never),
    defaultValue: preset.defaultValue,
    changeScope: ChangeScope.BlockDefault,
  }
}

/** Descriptor wiring the schema bridge into the shared projector
 *  lifecycle. Raw `BlockData` rows (no hydrate — see `peekRowProperty`);
 *  re-resolves on `onValuePresetsChange` so a schema skipped for an
 *  unknown preset resolves when that preset's plugin loads. */
export const userSchemasProjector: DefinitionBlockProjector<BlockData, AnyPropertySchema> = {
  id: USER_SCHEMAS_PROJECTOR_ID,
  metaType: PROPERTY_SCHEMA_TYPE,
  targetFacet: propertySchemasFacet,
  sourceId: USER_DATA_SOURCE_ID,
  keyOf: schema => schema.name,
  project: (row, ctx) => tryBuildSchema(row, ctx.repo.valuePresets),
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
 *  Roam importer) all hit the same in-memory bucket. */
export class UserSchemasService {
  constructor(private readonly repo: Repo) {}

  private get handle() {
    return this.repo.projectors.handle<AnyPropertySchema>(USER_SCHEMAS_PROJECTOR_ID)
  }

  /** Start the schema projector for the active workspace. Returns a
   *  disposer; throws on double-start / no active workspace. */
  start(): () => void {
    return this.repo.projectors.startById(USER_SCHEMAS_PROJECTOR_ID)
  }

  dispose(): void {
    this.repo.projectors.disposeProjector(USER_SCHEMAS_PROJECTOR_ID)
  }

  /** Look up the property-schema block id for a registered user-data
   *  schema name. Returns undefined for kernel/plugin schemas (which
   *  don't have backing blocks) or names that aren't registered. */
  getSchemaBlockId(name: string): string | undefined {
    return this.handle?.blockIdForKey(name)
  }

  /** Look up the published user-data schema for a property-schema
   *  block id. Returns undefined for blocks that aren't currently
   *  materializing a schema — including blocks pending hydration,
   *  blocks failing `tryBuildSchema` validation (empty name, unknown
   *  preset, invalid config), and ids that simply don't exist. */
  getSchemaForBlockId(blockId: string): AnyPropertySchema | undefined {
    return this.handle?.contributionForBlockId(blockId)
  }

  /** Synchronously add a user-data schema to the runtime bucket. Used
   *  by `addSchema` after persisting the schema block — registers
   *  before any dependent property write so the form's "create-then-
   *  write-initial-value" flow doesn't race the subscription tick.
   *  `blockId` is the property-schema block that produced `schema`. */
  appendUserSchema(schema: AnyPropertySchema, blockId: string): void {
    this.handle?.upsert(schema, blockId)
  }

  /** Create a property-schema block in the workspace's Properties
   *  page AND register the schema synchronously. Returns the freshly
   *  registered schema. */
  async addSchema(args: AddSchemaArgs): Promise<AnyPropertySchema> {
    const name = args.name.trim()
    if (!name) throw new Error('[addSchema] name is required')

    const preset = this.repo.valuePresets.get(args.presetId)
    if (!preset) {
      throw new Error(`[addSchema] no preset registered for id ${JSON.stringify(args.presetId)}`)
    }

    // Run caller config through the same validation boundary the
    // subscription uses. Only `undefined` falls back to defaultConfig;
    // `null` is preserved so configCodec can reject it.
    let parsedConfig: unknown
    if (preset.configCodec) {
      const raw = args.config === undefined ? preset.defaultConfig ?? {} : args.config
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

    const newSchema: AnyPropertySchema = {
      name,
      fieldId: childId,
      codec: preset.build(parsedConfig as never),
      defaultValue: preset.defaultValue,
      changeScope: ChangeScope.BlockDefault,
    }

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
    // into the (workspace-agnostic) 'user-data' bucket after a switch would
    // leak it into the new workspace. The projector's `disposed` guard can't
    // catch this — the per-projector container is reused and re-armed across
    // the switch — so the in-flight write is pinned to its workspace here.
    // Skipping is safe: when `workspaceId` is active again, its subscription
    // re-materialises the block. The subscription otherwise arrives at an
    // idempotent state.
    if (this.repo.activeWorkspaceId === workspaceId) {
      this.appendUserSchema(newSchema, childId)
    }
    return newSchema
  }
}
