import {ChangeScope, isChangeScope} from './api/changeScope'
import type {EnumOption} from './api/codecs'
import type {PropertyHandle} from './api/propertySchema'
import {normalizePresetDefault, type ValuePresetCore} from './api/valuePresetCore'
import {kernelValuePresetCoresById} from './kernelValuePresetCores'

type KernelPresetCoreMap = typeof kernelValuePresetCoresById
type KernelPresetId = keyof KernelPresetCoreMap
type PresetTypes<TCore> = TCore extends ValuePresetCore<infer TValue, infer TConfig>
  ? {readonly value: TValue; readonly config: TConfig} : never
type PresetValue<TCore> = PresetTypes<TCore>['value']
type PresetConfig<TCore> = PresetTypes<TCore>['config']

/** A code-owned property definition. The declaration is also the typed,
 * workspace-agnostic handle call sites pass to block.get/set; extensions
 * contribute this same object to definitionSeedsFacet for materialization. */
export interface PropertySeedDeclaration<T = unknown, TConfig = unknown>
  extends PropertyHandle<T> {
  readonly revision: number
  readonly presetId: string
  /** Normalized semantic config passed to the preset's build function. */
  readonly config: TConfig
  /** Canonical JSON form persisted in property-schema:config. */
  readonly encodedConfig: unknown
  readonly hidden: boolean
  /** Distinguishes an omitted default from an explicitly supplied undefined. */
  readonly hasExplicitDefault: boolean
  /** Meaningful only when hasExplicitDefault is true. */
  readonly encodedDefaultValue: unknown
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous facet storage
export type AnyPropertySeedDeclaration = PropertySeedDeclaration<any, any>

export interface SeedPropertyArgs<T, TConfig = void> {
  readonly seedKey: string
  readonly revision: number
  readonly name: string
  /** Kernel presets may be named by stable id. Plugin-owned presets pass their
   * explicit core so declaration construction never crosses a runtime boundary. */
  readonly preset: string | ValuePresetCore<T, TConfig>
  readonly config?: TConfig
  readonly defaultValue?: T
  readonly changeScope: ChangeScope
  readonly hidden?: boolean
}

type KernelSeedPropertyArgs<K extends KernelPresetId> =
  Omit<SeedPropertyArgs<PresetValue<KernelPresetCoreMap[K]>, PresetConfig<KernelPresetCoreMap[K]>>, 'preset'> &
  {readonly preset: K}

type ExplicitCoreSeedPropertyArgs<T, TConfig> =
  Omit<SeedPropertyArgs<T, TConfig>, 'preset'> &
  {readonly preset: ValuePresetCore<T, TConfig>}

type AssertedJsonSeedPropertyArgs<T, K extends 'json' | 'optional-json'> =
  Omit<SeedPropertyArgs<T, void>, 'preset'> & {readonly preset: K}
type StrictEnumSeedPropertyArgs<T extends string> = Omit<
  SeedPropertyArgs<T, {readonly options: readonly EnumOption<T>[]}>,
  'preset' | 'config' | 'defaultValue'
> & {
  readonly preset: 'strict-enum'
  readonly config: {readonly options: readonly EnumOption<T>[]}
  readonly defaultValue: T
}

const own = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isPropertySeedKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[^/]+\/property\/[^/]+$/.test(value)

const isJsonValue = (value: unknown, active = new Set<object>()): boolean => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (active.has(value)) return false
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
  }
  active.add(value)
  let valid: boolean
  if (Array.isArray(value)) {
    valid = Object.keys(value).length === value.length
    for (let index = 0; valid && index < value.length; index += 1) {
      valid = Object.prototype.hasOwnProperty.call(value, index) && isJsonValue(value[index], active)
    }
  } else {
    valid = Object.values(value as Record<string, unknown>)
      .every(item => isJsonValue(item, active))
  }
  active.delete(value)
  return valid
}

/** Runtime boundary for public/dynamic extension contributions. This mirrors
 * the constructor invariants so one malformed contribution is dropped before
 * it can abort a shared materialization pass. */
export const isPropertySeedDeclaration = (
  value: unknown,
): value is AnyPropertySeedDeclaration =>
  isRecord(value) &&
  isPropertySeedKey(value.seedKey) &&
  Number.isInteger(value.revision) &&
  (value.revision as number) > 0 &&
  typeof value.name === 'string' && value.name.trim().length > 0 &&
  typeof value.presetId === 'string' && value.presetId.trim().length > 0 &&
  own(value, 'config') &&
  own(value, 'encodedConfig') && isRecord(value.encodedConfig) && isJsonValue(value.encodedConfig) &&
  isRecord(value.codec) &&
  typeof value.codec.type === 'string' && value.codec.type.trim().length > 0 &&
  typeof value.codec.encode === 'function' &&
  typeof value.codec.decode === 'function' &&
  own(value, 'defaultValue') &&
  isChangeScope(value.changeScope) &&
  typeof value.hidden === 'boolean' &&
  typeof value.hasExplicitDefault === 'boolean' &&
  own(value, 'encodedDefaultValue') &&
  (!value.hasExplicitDefault || isJsonValue(value.encodedDefaultValue))

const resolveCore = <T, TConfig>(
  preset: string | ValuePresetCore<T, TConfig>,
): ValuePresetCore<T, TConfig> => {
  if (typeof preset !== 'string') return preset
  const core = kernelValuePresetCoresById[preset as KernelPresetId]
  if (!core) throw new Error(`[seedProperty] unknown kernel preset id ${JSON.stringify(preset)}`)
  return core as unknown as ValuePresetCore<T, TConfig>
}

/** Define a seeded property and build its handle through the same preset core
 * path used for block-fed schemas. Config and explicit defaults are
 * encode/decode round-tripped immediately so invalid declarations fail at
 * module evaluation rather than after materialization. */
export function seedProperty<T>(
  args: AssertedJsonSeedPropertyArgs<T, 'json'>,
): PropertySeedDeclaration<T, void>
export function seedProperty<T>(
  args: AssertedJsonSeedPropertyArgs<T, 'optional-json'>,
): PropertySeedDeclaration<T, void>
export function seedProperty<T extends string>(
  args: StrictEnumSeedPropertyArgs<T>,
): PropertySeedDeclaration<T, {readonly options: readonly EnumOption<T>[]}>
export function seedProperty<K extends KernelPresetId>(
  args: KernelSeedPropertyArgs<K>,
): PropertySeedDeclaration<
  PresetValue<KernelPresetCoreMap[K]>,
  PresetConfig<KernelPresetCoreMap[K]>
>
export function seedProperty<T, TConfig = void>(
  args: ExplicitCoreSeedPropertyArgs<T, TConfig>,
): PropertySeedDeclaration<T, TConfig>
export function seedProperty<T, TConfig = void>(
  args: SeedPropertyArgs<T, TConfig>,
): PropertySeedDeclaration<T, TConfig> {
  if (!isPropertySeedKey(args.seedKey)) {
    throw new Error('[seedProperty] seedKey must match <owner>/property/<stable-key>')
  }
  if (!args.name.trim()) throw new Error('[seedProperty] name is required')
  if (!Number.isInteger(args.revision) || args.revision <= 0) {
    throw new Error('[seedProperty] revision must be a positive integer')
  }

  const core = resolveCore(args.preset)
  if (typeof core.id !== 'string' || !core.id.trim()) {
    throw new Error('[seedProperty] preset id is required')
  }
  const suppliedConfig = own(args, 'config')
  let config: TConfig
  let encodedConfig: unknown
  if (core.configCodec) {
    const candidate = suppliedConfig ? args.config : core.defaultConfig
    encodedConfig = core.configCodec.encode(candidate as TConfig)
    config = core.configCodec.decode(encodedConfig)
    encodedConfig = core.configCodec.encode(config)
    if (!isRecord(encodedConfig) || !isJsonValue(encodedConfig)) {
      throw new Error(
        `[seedProperty] preset ${JSON.stringify(core.id)} config must encode a JSON object`,
      )
    }
  } else {
    if (suppliedConfig && args.config !== undefined) {
      throw new Error(`[seedProperty] preset ${JSON.stringify(core.id)} does not accept config`)
    }
    config = undefined as TConfig
    encodedConfig = {}
  }

  const codec = core.build(config)
  const hasExplicitDefault = own(args, 'defaultValue')
  let defaultValue: T
  let encodedDefaultValue: unknown = undefined
  if (hasExplicitDefault) {
    encodedDefaultValue = codec.encode(args.defaultValue as T)
    if (!isJsonValue(encodedDefaultValue)) {
      throw new Error(
        `[seedProperty] preset ${JSON.stringify(core.id)} default must encode a JSON value`,
      )
    }
    defaultValue = codec.decode(encodedDefaultValue)
  } else {
    defaultValue = normalizePresetDefault(core, codec)
  }

  return {
    seedKey: args.seedKey,
    revision: args.revision,
    name: args.name,
    presetId: core.id,
    config,
    encodedConfig,
    codec,
    defaultValue,
    changeScope: args.changeScope,
    hidden: args.hidden ?? false,
    hasExplicitDefault,
    encodedDefaultValue,
  }
}
