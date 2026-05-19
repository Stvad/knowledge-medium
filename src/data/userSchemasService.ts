/** Reactive bridge between user-defined `'property-schema'` blocks and
 *  the `propertySchemasFacet`'s `'user-data'` runtime contribution
 *  bucket. See user-defined-properties.md §5 + §7. */

import {
  ChangeScope,
  type AnyPropertySchema,
  type AnyValuePreset,
  type Tx,
  type Unsubscribe,
} from '@/data/api'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import {
  presetConfigProp,
  presetIdProp,
  propertyNameProp,
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

  /** Maps a registered schema's `name` to the property-schema block
   *  that materialised it. Lets UI surfaces (e.g. the property panel
   *  glyph button) open the schema block in a panel for in-place
   *  editing. Built from the same subscription that produces
   *  `contributions`, so it's always in sync. */
  private nameToBlockId = new Map<string, string>()

  /** Per-name CAS token. Every mutation (`appendUserSchema`,
   *  `removeUserSchema`, subscription rebuild) generates a fresh symbol
   *  for the affected name. `withProvisionalSchema` captures the token
   *  right after its append and compares in the catch arm: if the
   *  current token matches, no one has touched this slot since our
   *  append, so rollback is safe. If it differs, someone else has
   *  mutated the slot — skip rollback to avoid clobbering their entry.
   *  blockId alone isn't a sufficient sentinel because two overlapping
   *  calls (retries / duplicate submits) can legitimately share the
   *  same (name, blockId) pair. */
  private contributionTokens = new Map<string, symbol>()

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

  /** Look up the property-schema block id for a registered user-data
   *  schema name. Returns undefined for kernel/plugin schemas (which
   *  don't have backing blocks) or names that aren't registered. */
  getSchemaBlockId(name: string): string | undefined {
    return this.nameToBlockId.get(name)
  }

  start(): () => void {
    if (this.subscriptionDisposer) {
      throw new Error('[UserSchemasService] already started')
    }

    const rebuildFromBlocks = (blocks: readonly Block[]) => {
      this.latestBlocks = blocks
      const presets = this.repo.valuePresets
      const next: AnyPropertySchema[] = []
      const nextNameToBlockId = new Map<string, string>()
      const nextTokens = new Map<string, symbol>()
      for (const block of blocks) {
        const built = this.tryBuildSchema(block, presets)
        if (built) {
          next.push(built)
          nextNameToBlockId.set(built.name, block.id)
          nextTokens.set(built.name, Symbol('rebuild'))
        }
      }
      this.contributions = next
      this.nameToBlockId = nextNameToBlockId
      this.contributionTokens = nextTokens
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
   *  write-initial-value" flow doesn't race the subscription tick.
   *  `blockId` is the property-schema block that produced `schema`. */
  appendUserSchema(schema: AnyPropertySchema, blockId: string): void {
    this.contributions = [
      ...this.contributions.filter(s => s.name !== schema.name),
      schema,
    ]
    this.nameToBlockId.set(schema.name, blockId)
    this.contributionTokens.set(schema.name, Symbol('appendUserSchema'))
    this.repo.setRuntimeContributions(propertySchemasFacet, USER_DATA_SOURCE_ID, this.contributions)
  }

  /** Capture the currently-registered user-data schema for `name`,
   *  along with its source block id. Returns undefined when either the
   *  schema or its block id is missing (kernel/plugin schemas don't
   *  live in `contributions` / `nameToBlockId`). Used by
   *  `withProvisionalSchema` to snapshot prior registrations so a
   *  rollback can restore them rather than wiping them.
   *
   *  `rebuildFromBlocks` pushes duplicate-name entries unconditionally
   *  (one per matching block), and `nameToBlockId` is last-wins.
   *  `propertySchemasFacet.combine` is also last-wins on duplicate
   *  names, so the LIVE schema is the last occurrence in
   *  `contributions`. `findLast` snapshots that one — pairing it with
   *  the (also last-wins) `nameToBlockId.get(name)` so restore can't
   *  end up with an older schema mapped to a newer block's id. */
  peekContribution(name: string): {contribution: AnyPropertySchema; blockId: string} | undefined {
    const contribution = this.contributions.findLast(s => s.name === name)
    if (!contribution) return undefined
    const blockId = this.nameToBlockId.get(name)
    if (!blockId) return undefined
    return {contribution, blockId}
  }

  /** Symmetric to `appendUserSchema`: drop a user-data schema from the
   *  runtime bucket and republish. Used by `withProvisionalSchema` to
   *  unregister a provisional schema when its tx aborts and no prior
   *  registration existed for the name. */
  removeUserSchema(name: string): void {
    this.contributions = this.contributions.filter(s => s.name !== name)
    this.nameToBlockId.delete(name)
    this.contributionTokens.delete(name)
    this.repo.setRuntimeContributions(propertySchemasFacet, USER_DATA_SOURCE_ID, this.contributions)
  }

  /** Register `schema` provisionally, run `body` inside a repo tx, and
   *  on tx failure either restore the previously-registered schema for
   *  `schema.name` (if one existed) or drop the provisional registration
   *  (if none did). The capture-and-restore shape lets callers register
   *  a user-data schema *before* an in-tx write that depends on it
   *  (e.g. retagging blocks against a new isa) without permanently
   *  wiping a legitimate prior registration on retry.
   *
   *  Mirrors `addSchema`'s tx convention by default (BlockDefault scope,
   *  a descriptive label). Callers can override either via `opts`. */
  async withProvisionalSchema<T>(
    schema: AnyPropertySchema,
    blockId: string,
    body: (tx: Tx) => Promise<T>,
    opts: {scope?: ChangeScope; description?: string} = {},
  ): Promise<T> {
    const prior = this.peekContribution(schema.name)
    this.appendUserSchema(schema, blockId)
    // Snapshot our token IMMEDIATELY after appendUserSchema — this is
    // the per-call sentinel for the CAS check below. blockId isn't
    // unique enough: two overlapping calls (retries / duplicate
    // submits) can legitimately share the same (name, blockId) pair.
    // A fresh symbol per appendUserSchema makes ownership identifiable.
    const ourToken = this.contributionTokens.get(schema.name)
    try {
      return await this.repo.tx(body, {
        scope: opts.scope ?? ChangeScope.BlockDefault,
        description: opts.description ?? 'withProvisionalSchema',
      })
    } catch (err) {
      // CAS: only roll back if our token is still the live one. Any
      // intervening appendUserSchema / removeUserSchema / subscription
      // rebuild generates a fresh token, so a token mismatch means
      // someone else has taken ownership of this slot — skip rollback.
      if (this.contributionTokens.get(schema.name) === ourToken) {
        if (prior) {
          this.appendUserSchema(prior.contribution, prior.blockId)
        } else {
          this.removeUserSchema(schema.name)
        }
      }
      throw err
    }
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
      // Lift property-schema type membership through Repo.addTypeInTx
      // so types invariants stay consistent (block_types row + the
      // typesProp lift). The remaining property-schema fields are
      // written directly since they're scoped to this block.
      await this.repo.addTypeInTx(tx, childId, PROPERTY_SCHEMA_TYPE, {})
      await tx.setProperty(childId, propertyNameProp, name)
      await tx.setProperty(childId, presetIdProp, args.presetId)
      await tx.setProperty(childId, presetConfigProp, persistConfig as Record<string, unknown>)
    }, {scope: ChangeScope.BlockDefault, description: `addSchema ${name}`})

    // Register synchronously, before returning. The subscription will
    // fire later (the block write triggers it) but arrives at an
    // idempotent state.
    this.appendUserSchema(newSchema, childId)
    return newSchema
  }
}
