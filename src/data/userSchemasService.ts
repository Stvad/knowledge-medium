/** Reactive bridge between user-defined `'property-schema'` blocks and
 *  the `propertySchemasFacet`'s `'user-data'` runtime contribution
 *  bucket. See user-defined-properties.md §5 + §7. */

import {
  ChangeScope,
  type AnyPropertySchema,
  type AnyValuePreset,
  type Unsubscribe,
} from '@/data/api'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import {
  presetConfigProp,
  presetIdProp,
  propertyNameProp,
  typesProp,
} from '@/data/properties'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { propertySchemasFacet } from '@/data/facets'

const USER_DATA_SOURCE_ID = 'user-data'

export interface AddSchemaArgs {
  name: string
  presetId: string
  /** Caller-supplied config. Runs through `preset.configCodec.decode`
   *  for validation. Pass `undefined` to fall back to
   *  `preset.defaultConfig` — `null` is a real (typically invalid)
   *  value that's passed through to the codec so it can reject. */
  config?: unknown
}

export class UserSchemasService {
  /** Single source of truth for the user-data bucket. Both the
   *  subscription rebuild and `appendUserSchema` assign to this field
   *  and publish via `setRuntimeContributions`. */
  private contributions: readonly AnyPropertySchema[] = []

  /** Active block-subscription disposer, set by `start()`. */
  private subscriptionDisposer: Unsubscribe | null = null

  /** Disposer for the value-preset listener; we re-resolve when
   *  presets change (a plugin contributing a new preset id makes
   *  previously-skipped schemas resolvable). */
  private presetsListenerDisposer: (() => void) | null = null

  /** Latest blocks list captured by the subscription. Stored so the
   *  value-preset change path can re-resolve without a fresh DB read. */
  private latestBlocks: readonly Block[] = []

  constructor(private readonly repo: Repo) {}

  start(): () => void {
    if (this.subscriptionDisposer) {
      throw new Error('[UserSchemasService] already started')
    }

    const rebuildFromBlocks = (blocks: readonly Block[]) => {
      this.latestBlocks = blocks
      const presets = this.repo.valuePresets
      const next: AnyPropertySchema[] = []
      for (const block of blocks) {
        const built = this.tryBuildSchema(block, presets)
        if (built) next.push(built)
      }
      this.contributions = next
      this.repo.setRuntimeContributions(propertySchemasFacet, USER_DATA_SOURCE_ID, this.contributions)
    }

    this.subscriptionDisposer = this.repo.subscribeBlocks(
      {types: [PROPERTY_SCHEMA_TYPE]},
      blocks => {
        // Hydrate to Block facades so we can read codec-decoded
        // properties (block.get) rather than poking at raw
        // properties_json shapes.
        rebuildFromBlocks(blocks.map(b => this.repo.block(b.id)))
      },
    )

    this.presetsListenerDisposer = this.repo.onValuePresetsChange(() => {
      rebuildFromBlocks(this.latestBlocks)
    })

    return () => this.dispose()
  }

  dispose(): void {
    this.subscriptionDisposer?.()
    this.subscriptionDisposer = null
    this.presetsListenerDisposer?.()
    this.presetsListenerDisposer = null
  }

  /** Validates a schema block against the current presets and returns
   *  the schema if it parses, or null with a logged diagnostic if not.
   *  Three skip paths: (1) preset not loaded, (2) name empty,
   *  (3) configCodec.decode throws. The block stays in the database
   *  untouched; a fix re-runs this on the next subscription tick. */
  private tryBuildSchema(
    block: Block,
    presets: ReadonlyMap<string, AnyValuePreset>,
  ): AnyPropertySchema | null {
    const presetId = block.peekProperty(presetIdProp) ?? ''
    if (!presetId) {
      console.warn(`[UserSchemasService] schema block ${block.id} has no presetId`)
      return null
    }
    const preset = presets.get(presetId)
    if (!preset) {
      console.warn(
        `[UserSchemasService] schema block ${block.id} references unknown preset ${JSON.stringify(presetId)}; ` +
        `preset's plugin may not be loaded`,
      )
      return null
    }
    const name = block.peekProperty(propertyNameProp) ?? ''
    if (!name) {
      console.warn(`[UserSchemasService] schema block ${block.id} has empty propertyName`)
      return null
    }
    let config: unknown
    if (preset.configCodec) {
      try {
        const raw = block.peekProperty(presetConfigProp) ?? {}
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
      codec: preset.build(config as never),
      defaultValue: preset.defaultValue,
      changeScope: ChangeScope.BlockDefault,
    }
  }

  /** Synchronously add a user-data schema to the runtime bucket. Used
   *  by `addSchema` after persisting the schema block — registers
   *  before any dependent property write so the form's "create-then-
   *  write-initial-value" flow doesn't race the subscription tick. */
  appendUserSchema(schema: AnyPropertySchema): void {
    this.contributions = [
      ...this.contributions.filter(s => s.name !== schema.name),
      schema,
    ]
    this.repo.setRuntimeContributions(propertySchemasFacet, USER_DATA_SOURCE_ID, this.contributions)
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

    const propertiesPageId = this.repo.propertiesPageId
    if (!propertiesPageId) {
      throw new Error('[addSchema] no active workspace; properties page unavailable')
    }

    const childId: string = await this.repo.mutate.createChild({
      parentId: propertiesPageId,
      position: {kind: 'last'},
    })

    await this.repo.tx(async tx => {
      await tx.update(childId, {
        properties: {
          [typesProp.name]: typesProp.codec.encode([PROPERTY_SCHEMA_TYPE]),
          [propertyNameProp.name]: propertyNameProp.codec.encode(name),
          [presetIdProp.name]: presetIdProp.codec.encode(args.presetId),
          [presetConfigProp.name]: presetConfigProp.codec.encode(persistConfig as Record<string, unknown>),
        },
      })
    }, {scope: ChangeScope.BlockDefault, description: `addSchema ${name}`})

    // Register synchronously, before returning. The subscription will
    // fire later (the block write triggers it) but arrives at an
    // idempotent state.
    this.appendUserSchema(newSchema)
    return newSchema
  }
}
