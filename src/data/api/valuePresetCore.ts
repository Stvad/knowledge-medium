import type { Tx } from './tx'
import type { TypeRegistrySnapshot } from './blockType'
import type { Codec } from './codecs'
import type { AnyPropertySchema } from './propertySchema'

/** A semantic conversion between stored scalar presets, inside the definition edit.
 *  The optional source text preserves precision that an old decoder may normalize. */
export interface ScalarPresetConversion {
  readonly from: string
  matchesTarget(schema: AnyPropertySchema): boolean
  convert(
    encoded: unknown, context: TypeRegistrySnapshot & {tx: Tx; workspaceId: string}, sourceText?: string,
  ): Promise<{encoded: unknown} | {refused: string}>
}

/** Data-only half of a value preset. Safe to import from the kernel, CLI,
 * bridge, and projector code without pulling in React presentation. */
export interface ValuePresetCore<TValue = unknown, TConfig = void> {
  /** Stable id persisted on property-schema definition blocks. */
  readonly id: string
  /** Deterministic codec factory, called only with validated config. */
  readonly build: (config: TConfig) => Codec<TValue>
  readonly defaultValue: TValue
  readonly defaultConfig?: TConfig
  readonly configCodec?: Codec<TConfig>
  /** Preferred link text for a scalar reference. Its target stays the encoded id. */
  readonly valueChildReference?: {
    matchesSchema(schema: AnyPropertySchema): boolean
    resolve(tx: Tx, workspaceId: string, id: string): Promise<string | undefined>
  }
  readonly scalarConversion?: ScalarPresetConversion
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyValuePresetCore = ValuePresetCore<any, any>

export const scalarConversionBetween = (
  presets: ReadonlyMap<string, AnyValuePresetCore>,
  from: string | undefined,
  target: AnyPropertySchema,
): ScalarPresetConversion | undefined => {
  for (const preset of presets.values()) {
    const conversion = preset.scalarConversion
    if (conversion && conversion.from === from && conversion.matchesTarget(target)) return conversion
  }
  return undefined
}

export const definePresetCore = <TValue = unknown, TConfig = void>(
  core: ValuePresetCore<TValue, TConfig>,
): ValuePresetCore<TValue, TConfig> => core

/** Canonicalize a preset default through the same codec used for values.
 * Seed declarations and block-built fallbacks must take this identical path. */
export const normalizePresetDefault = <TValue>(
  core: Pick<ValuePresetCore<TValue, unknown>, 'defaultValue'>,
  codec: Codec<TValue>,
): TValue => codec.decode(codec.encode(core.defaultValue))
